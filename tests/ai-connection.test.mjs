import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace,createWorkspaceApp} from '../server/workspace.mjs';
import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
import {listSubscriptionModels,requestSubscriptionProposal} from '../scripts/siwc-provider.mjs';
import {chooseAccountModel,connectionPending,connectionLabel} from '../client/src/aiConnectionState.mjs';
const origin='http://127.0.0.1:5173',secret='SYNTHETIC_PRIVATE_BEARER';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const memorySession=(extra={})=>({bearer:()=>secret,close:async()=>{},...extra});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const until=async fn=>{for(let i=0;i<100;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error('synthetic state did not settle');};
async function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'bn-ai-connect-')),root=join(dir,'workspace');initializeWorkspace({destination:root});
  const documents=createWorkspaceApp({root}),documentBase=await listen(documents),panel=createAiPanelServer({documentBase,
    connect:async()=>memorySession(),listModels:async()=>[{slug:'gpt-6-luna',name:'Synthetic catalog Luna'}],
    propose:async()=>({proposal:{content:'합성 검토 의견',reason:'합성 응답'}}),...options});
  const base=await listen(panel);
  t.after(async()=>{await panel.shutdown();await new Promise(r=>{documents.close(r);documents.closeAllConnections();});rmSync(dir,{recursive:true,force:true});});
  const api=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
  const status=async()=>(await api('/panel/status')).body;
  const connect=async()=>{const ack=await api('/panel/connect',{background:true});await until(async()=>{const s=await status();return s.connected;});return ack;};
  return {root,base,api,status,connect,panel,documentBase};
}

test('connection: short 202 ACK, enum progress and status complete independently of OAuth waiting',async t=>{
  const g=gate();let progress;
  const f=await fixture(t,{connect:async({onProgress})=>{progress=onProgress;onProgress('waiting_browser');await g.promise;return memorySession();}});
  const start=Date.now(),ack=await f.api('/panel/connect',{background:true});assert.equal(ack.status,202);assert.ok(Date.now()-start<1000);
  assert.equal((await f.status()).connection.phase,'waiting_browser');progress('verifying');assert.equal((await f.status()).connection.phase,'verifying');
  g.resolve();await until(async()=> (await f.status()).connected);assert.equal((await f.status()).connection.phase,'connected');
  assert.doesNotMatch(JSON.stringify(await f.status()),/PRIVATE_BEARER|access_token|id_token|auth.openai.com|accountLabel/);
});
test('connection: duplicate requests never open a second browser and stale cancel IDs are rejected',async t=>{
  let calls=0;const f=await fixture(t,{connect:({signal,onProgress})=>new Promise((_,reject)=>{calls++;onProgress('waiting_browser');signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});})});
  const ack=await f.api('/panel/connect',{background:true});assert.equal((await f.api('/panel/connect',{background:true})).status,409);assert.equal(calls,1);
  assert.equal((await f.api('/panel/connect/cancel',{attemptId:'stale'})).status,409);
  assert.equal((await f.api('/panel/connect/cancel',{attemptId:ack.body.connection.attemptId})).status,200);
  assert.equal((await f.status()).connection.phase,'cancelled');
});
test('connection: cancelled late session is closed and cannot replace a successful retry',async t=>{
  const g=gate();let calls=0,closed=0;
  const f=await fixture(t,{connect:async({onProgress})=>{calls++;if(calls===1){onProgress('waiting_browser');await g.promise;return memorySession({close:async()=>{closed++;}});}return memorySession();}});
  const ack=await f.api('/panel/connect',{background:true});await f.api('/panel/connect/cancel',{attemptId:ack.body.connection.attemptId});
  const next=await f.connect();g.resolve();await until(()=>closed===1);
  assert.equal((await f.status()).connection.attemptId,next.body.connection.attemptId);assert.equal((await f.status()).connected,true);
});
test('connection: failure is sanitized, clears busy and permits retry',async t=>{
  let calls=0;const f=await fixture(t,{connect:async()=>{if(++calls===1)throw Error('Bearer '+secret+' code=PRIVATE_CODE');return memorySession();}});
  await f.api('/panel/connect',{background:true});await until(async()=> (await f.status()).connection.phase==='failed');
  const failed=await f.status();assert.equal(failed.busy,null);assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|Bearer/);
  await f.connect();assert.equal(calls,2);
});
test('connection: bounded auth expiry releases busy and permits a new attempt',async t=>{
  let calls=0;const f=await fixture(t,{connectTimeoutMs:30,connect:async({signal})=>{
    if(++calls>1)return memorySession();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
  }});
  await f.api('/panel/connect',{background:true});await until(async()=> (await f.status()).connection.phase==='expired');
  assert.equal((await f.status()).busy,null);await f.connect();assert.equal(calls,2);
});
test('connection: session expiry clears memory, proposals and model availability, then reconnects',async t=>{
  let expired=false,closed=0;const f=await fixture(t,{connect:async()=>memorySession({bearer:()=>{if(expired)throw Error('Session expired');return secret;},close:async()=>{closed++;}})});
  await f.connect();expired=true;const s=await f.status();assert.equal(s.connected,false);assert.equal(s.connection.phase,'expired');assert.equal(closed,1);
  assert.equal((await f.api('/panel/models')).status,409);expired=false;await f.connect();
});
test('connection: background session is cleaned on shutdown even if consent completes late',async t=>{
  const g=gate();let closed=0;const f=await fixture(t,{connect:async()=>{await g.promise;return memorySession({close:async()=>{closed++;}});}});
  await f.api('/panel/connect',{background:true});const stopping=f.panel.shutdown();g.resolve();await stopping;assert.equal(closed,1);
});
test('connection: same local Host/Origin restrictions protect start, status and cancellation',async t=>{
  const f=await fixture(t);
  for(const path of ['/panel/status','/panel/connect','/panel/connect/cancel']){
    const r=await fetch(f.base+path,{method:path.endsWith('status')?'GET':'POST',headers:{Origin:'http://evil.test','Content-Type':'application/json'},...(path.endsWith('status')?{}:{body:'{}'})});assert.equal(r.status,403);
  }
});
test('connection: actual subscription adapters use selected catalog Luna, keep proposal read-only and approve once',async t=>{
  const calls=[];
  const transport=async(url,opts={})=>{
    assert.equal(opts.headers.Authorization,'Bearer '+secret);
    if(url.endsWith('/models'))return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'Mock Sol',visibility:'list'},{slug:'gpt-6-luna',display_name:'Mock Luna',visibility:'list'}]});
    assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(opts.body);calls.push(body);assert.equal(body.model,'gpt-6-luna');assert.equal(body.store,false);
    const json=JSON.stringify({content:'합성 Luna 검토 의견',reason:'외부 모델이 아닌 모의 전송'});
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:json})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',id:'mock-response'}})+'\n\n');
  };
  const f=await fixture(t,{listModels:opts=>listSubscriptionModels({...opts,fetchImpl:transport}),propose:opts=>requestSubscriptionProposal({...opts,fetchImpl:transport})});
  await f.connect();const catalog=(await f.api('/panel/models')).body.models;assert.equal(chooseAccountModel(catalog,''),'gpt-6-luna');
  const read=async()=>fetch(f.documentBase+'/api/document').then(r=>r.json()),before=await read(),id='local-connect-luna';
  const started=await f.api('/panel/requests',{requestId:id,documentId:before.id,baseRevision:before.revision,targetId:before.blocks[0].id,model:'gpt-6-luna',mode:'insert',goal:'합성 문서를 검토해줘'});assert.equal(started.status,202);
  const job=await until(async()=>{const r=(await f.api('/panel/requests/'+id+'?documentId='+before.id)).body;return r.state==='review'?r:false;});
  assert.deepEqual(await read(),before);assert.equal(calls.length,1);assert.match(job.proposal.content,/Luna/);
  const approval={documentId:before.id,baseRevision:before.revision,targetId:before.blocks[0].id,proposalId:job.proposal.proposalId};
  assert.equal((await f.api('/panel/requests/'+id+'/approve',approval)).body.state,'committed');assert.equal((await read()).revision,before.revision+1);
  const history=await fetch(f.documentBase+'/api/history').then(r=>r.json());assert.equal(history.events.length,1);assert.equal(history.events[0].proposal.approval,'approved');
});
test('connection: missing Luna fails explicitly without invoking or silently switching models',async t=>{
  let calls=0;const f=await fixture(t,{listModels:async()=>[{slug:'gpt-6.1-sol',name:'Mock Sol'}],propose:async()=>{calls++;throw Error('must not call');}});
  await f.connect();const models=(await f.api('/panel/models')).body.models;assert.equal(chooseAccountModel(models,''),'');
  const doc=await fetch(f.documentBase+'/api/document').then(r=>r.json());const p=await f.api('/panel/preview',{model:'gpt-6-luna',goal:'합성',targetId:doc.blocks[0].id});
  assert.equal(p.body.code,'UNKNOWN_MODEL');assert.equal(calls,0);assert.equal((await fetch(f.documentBase+'/api/document').then(r=>r.json())).revision,doc.revision);
});
test('connection: Luna inference failure is sanitized and never retries another model',async t=>{
  const calls=[];const f=await fixture(t,{propose:async({model})=>{calls.push(model);throw Error(secret);}});await f.connect();await f.api('/panel/models');
  const doc=await fetch(f.documentBase+'/api/document').then(r=>r.json());const r=await f.api('/panel/preview',{model:'gpt-6-luna',goal:'합성',targetId:doc.blocks[0].id});
  assert.equal(r.status,502);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_BEARER/);assert.deepEqual(calls,['gpt-6-luna']);
});
test('model choice: missing/removed selection stays empty; cloud synthetic catalog keeps its own default',()=>{
  const catalog=[{slug:'other'},{slug:'gpt-6-luna'}];assert.equal(chooseAccountModel(catalog,''),'gpt-6-luna');
  assert.equal(chooseAccountModel(catalog,'other'),'other');assert.equal(chooseAccountModel(catalog,'gone'),'');
  assert.equal(chooseAccountModel([{slug:'synthetic-test'}],'',{cloud:true}),'synthetic-test');
  assert.equal(connectionPending({phase:'waiting_browser'}),true);assert.equal(connectionPending({phase:'cancelled'}),false);assert.match(connectionLabel({phase:'verifying'}),/인증/);
});

test('manual login: only the current waiting attempt exposes a validated local page; stale callbacks cannot revive it',async t=>{
  const callbacks=[],page='http://127.0.0.1:43123/sign-in/'+'a'.repeat(43);
  const f=await fixture(t,{connect:({signal,onProgress,onLoginPage})=>new Promise((_,reject)=>{
    callbacks.push({onProgress,onLoginPage});onProgress('waiting_browser');onLoginPage(page);
    signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});
  })});
  const a=await f.api('/panel/connect',{background:true});assert.equal(a.body.connection.loginPage,page);
  assert.equal((await f.status()).connection.loginPage,page);
  callbacks[0].onLoginPage('https://auth.openai.com/api/accounts/authorize?state=PRIVATE_STATE');
  assert.equal((await f.status()).connection.loginPage,undefined);
  callbacks[0].onLoginPage(page);callbacks[0].onLoginPage(null);assert.equal((await f.status()).connection.loginPage,undefined);
  callbacks[0].onLoginPage(page);callbacks[0].onProgress('verifying');assert.equal((await f.status()).connection.loginPage,undefined);
  await f.api('/panel/connect/cancel',{attemptId:a.body.connection.attemptId});
  const b=await f.api('/panel/connect',{background:true});callbacks[0].onLoginPage(page.replace('43123','43124'));callbacks[0].onLoginPage(null);
  assert.equal((await f.status()).connection.loginPage,page);
  await f.api('/panel/connect/cancel',{attemptId:b.body.connection.attemptId});callbacks[1].onLoginPage(page);
  const status=await f.status();assert.equal(status.connection.loginPage,undefined);assert.equal(status.busy,null);
  const response=await fetch(f.base+'/panel/status',{headers:{Origin:origin}});assert.equal(response.headers.get('cache-control'),'no-store');
  assert.doesNotMatch(JSON.stringify(status),/PRIVATE_STATE|auth.openai.com|token|code=/);
});
test('manual login: completion, failure, deadline and shutdown discard the page',async t=>{
  for(const end of ['success','failure','expiry','shutdown']){
    let finish;
    const f=await fixture(t,{connectTimeoutMs:end==='expiry'?40:2000,connect:async({signal,onProgress,onLoginPage})=>{
      onProgress('waiting_browser');onLoginPage('http://127.0.0.1:43123/sign-in/'+'b'.repeat(43));
      await new Promise((resolve,reject)=>{finish=()=>end==='failure'?reject(Error('private auth URL')):resolve();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});return memorySession();
    }});
    await f.api('/panel/connect',{background:true});assert.ok((await f.status()).connection.loginPage);
    if(end==='shutdown'){await f.panel.shutdown();continue;}
    if(end!=='expiry')finish();
    const s=await until(async()=>{const s=await f.status();return !connectionPending(s.connection)&&s;});assert.equal(s.connection.loginPage,undefined);
  }
});

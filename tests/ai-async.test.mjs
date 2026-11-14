import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorkspaceApp,initializeWorkspace} from '../server/workspace.mjs';import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
import {createAiRequests} from '../scripts/ai-requests.mjs';import {matchesRequest,requestLabel} from '../client/src/aiRequestState.mjs';
const wait=()=>new Promise(r=>setImmediate(r));const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));const stop=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
async function fixture(run,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'f504-')),root=join(dir,'workspace');const [a]=initializeWorkspace({destination:root});const server=createWorkspaceApp({root}),base=await listen(server);let panel;
 const api=async(path,method='GET',body)=>{const r=await fetch(base+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const doc=async id=>(await api('/api/documents/'+id+'/document')).data;
 let calls=0;const provider=async({document,targetId})=>{calls++;return {proposal:{content:document.blocks.find(b=>b.id===targetId).content[0]?.text+' improved',reason:'synthetic'}};};
 const make=()=>createAiPanelServer({documentBase:base,connect:async()=>({bearer:()=> 'synthetic-secret',close:async()=>{}}),listModels:async()=>[{slug:'synthetic',name:'Synthetic'}],propose:provider,...overrides});
 panel=make();let url=await listen(panel);
 const p=async(path,body)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:5173',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const start=async(id,requestId,extra={})=>{const d=await doc(id);return p('/panel/requests',{requestId,documentId:id,targetId:d.blocks[0].id,baseRevision:d.revision,mode:'patch',model:'synthetic',goal:'improve',...extra});};
 const get=(id,documentId)=>p('/panel/requests/'+id+'?documentId='+documentId);
 const settled=async(id,documentId,state)=>{for(let n=0;n<200;n++){const r=await get(id,documentId);if(r.data.state!=='running'&&(!state||r.data.state===state))return r;await new Promise(r=>setTimeout(r,5));}throw Error('request did not settle');};
 const action=(r,name,extra={})=>p('/panel/requests/'+r.requestId+'/'+name,{documentId:r.documentId,targetId:r.targetId,baseRevision:r.baseRevision,proposalId:r.proposal?.proposalId,...extra});
 try{await p('/panel/connect',{});await run({a,dir,root,p,api,doc,start,get,settled,action,get calls(){return calls;},restart:async()=>{await panel.shutdown();panel=make();url=await listen(panel);}});}finally{await panel.shutdown();await stop(server);rmSync(dir,{recursive:true,force:true});}
}
test('async: accepted request is bound to identity and only explicit approval writes once',()=>fixture(async f=>{
 const before=await f.doc(f.a.id),start=await f.start(f.a.id,'async:one');assert.equal(start.status,202);const r=(await f.settled('async:one',f.a.id)).data;assert.equal(r.state,'review');assert.deepEqual(await f.doc(f.a.id),before);
 assert.equal((await f.action(r,'approve',{targetId:'wrong'})).status,409);assert.equal((await f.action(r,'approve')).status,200);assert.equal((await f.action(r,'approve')).status,409);const after=await f.doc(f.a.id);assert.equal(after.revision,before.revision+1);assert.equal(after.blocks[0].id,before.blocks[0].id);
 const h=(await f.api('/api/documents/'+f.a.id+'/history')).data.events;assert.equal(h.length,1);assert.equal(h[0].idempotency.requestId,'async:one');
}));
test('async: same request replay never calls the model twice and different payload is rejected',()=>fixture(async f=>{
 const d=await f.doc(f.a.id),body={requestId:'async:replay',documentId:d.id,targetId:d.blocks[0].id,baseRevision:d.revision,mode:'patch',model:'synthetic',goal:'improve'};
 await f.p('/panel/requests',body);await f.p('/panel/requests',body);await f.settled(body.requestId,d.id);assert.equal(f.calls,1);assert.equal((await f.p('/panel/requests',{...body,goal:'different'})).status,409);
}));
test('async: concurrent documents resolve in reverse order without result or history mixing',()=>fixture(async f=>{
 const b=(await f.api('/api/documents','POST',{title:'B'})).data;await f.start(f.a.id,'reverse:A');await f.start(b.id,'reverse:B');await both;releases[1]();const rb=(await f.settled('reverse:B',b.id)).data;assert.equal(rb.proposal.documentId,b.id);assert.equal((await f.get('reverse:A',f.a.id)).data.state,'running');releases[0]();const ra=(await f.settled('reverse:A',f.a.id)).data;assert.equal(ra.proposal.documentId,f.a.id);assert.equal((await f.action(ra,'approve',{documentId:b.id})).status,409);await f.action(rb,'approve');await f.action(ra,'approve');for(const id of [f.a.id,b.id])assert.equal((await f.api('/api/documents/'+id+'/history')).data.events.length,1);
},{propose:async({document})=>{await new Promise(r=>{releases.push(r);if(releases.length===2)bothReady();});return {proposal:{content:'result-'+document.id,reason:'synthetic'}};}}));
const releases=[];let bothReady;const both=new Promise(r=>bothReady=r);
for(const kind of ['edit','delete'])test('async: target '+kind+' while waiting becomes conflict, never writes',()=>fixture(async f=>{
 await f.start(f.a.id,'change:'+kind);await started[kind];const d=await f.doc(f.a.id);d.blocks=kind==='edit'?d.blocks.map(b=>({...b,content:[{type:'text',text:'local edit',styles:{}}]})):[{...d.blocks[0],id:'replacement'}];await f.api('/api/documents/'+d.id+'/document','PUT',{documentId:d.id,revision:d.revision,blocks:d.blocks});finish[kind]();const r=(await f.settled('change:'+kind,d.id)).data;assert.equal(r.state,'conflict');assert.equal((await f.action(r,'approve')).status,409);assert.equal((await f.doc(d.id)).revision,2);
},{propose:async()=>{began[kind]();await gates[kind];return {proposal:{content:'late',reason:'test'}};}}));
const finish={},began={},gates={},started={};for(const k of ['edit','delete']){gates[k]=new Promise(r=>finish[k]=r);started[k]=new Promise(r=>began[k]=r);}
test('async: cancellation blocks late output even when provider ignores AbortSignal',()=>fixture(async f=>{
 const before=await f.doc(f.a.id);await f.start(f.a.id,'cancel:late');await cancellationBegan;const running=(await f.get('cancel:late',f.a.id)).data;assert.equal((await f.action(running,'cancel')).data.state,'cancelled');cancelRelease();await wait();assert.equal((await f.get('cancel:late',f.a.id)).data.state,'cancelled');assert.equal((await f.action(running,'approve')).status,409);assert.deepEqual(await f.doc(f.a.id),before);
},{propose:async()=>{cancelStarted();await cancellationGate;return {proposal:{content:'late',reason:'test'}};}}));
let cancelRelease,cancelStarted;const cancellationGate=new Promise(r=>cancelRelease=r),cancellationBegan=new Promise(r=>cancelStarted=r);
test('async: timeout invalidates non-cooperative model and does not modify data',()=>fixture(async f=>{
 const before=await f.doc(f.a.id);await f.start(f.a.id,'timeout:one');const r=(await f.settled('timeout:one',f.a.id)).data;assert.equal(r.state,'failed');assert.equal(r.code,'AI_TIMEOUT');timeoutRelease();await wait();assert.equal((await f.get('timeout:one',f.a.id)).data.state,'failed');assert.deepEqual(await f.doc(f.a.id),before);
},{requestTimeoutMs:25,propose:async()=>{await timeoutGate;return {proposal:{content:'late timeout',reason:'test'}};}}));
let timeoutRelease;const timeoutGate=new Promise(r=>timeoutRelease=r);
test('async: provider failure is redacted and source remains intact',()=>fixture(async f=>{const before=await f.doc(f.a.id);await f.start(f.a.id,'failure:one');const r=(await f.settled('failure:one',f.a.id)).data;assert.equal(r.state,'failed');assert.doesNotMatch(JSON.stringify(r),/secret-token/);assert.deepEqual(await f.doc(f.a.id),before);},{propose:async()=>{throw Error('Bearer secret-token');}}));
test('async: returning to a reviewed request validates current revision again',()=>fixture(async f=>{await f.start(f.a.id,'return:one');const r=(await f.settled('return:one',f.a.id)).data;const d=await f.doc(f.a.id);await f.api('/api/documents/'+d.id+'/document','PUT',{documentId:d.id,revision:d.revision,blocks:d.blocks});assert.equal((await f.get(r.requestId,d.id)).data.state,'conflict');}));
test('async: restart expires pending state without applying it and permits a new request',()=>fixture(async f=>{const before=await f.doc(f.a.id);await f.start(f.a.id,'restart:one');await f.settled('restart:one',f.a.id);await f.restart();assert.equal((await f.get('restart:one',f.a.id)).status,404);assert.deepEqual(await f.doc(f.a.id),before);await f.p('/panel/connect',{});assert.equal((await f.start(f.a.id,'restart:two')).status,202);}));
test('async: disconnect expires live requests; reconnect can start fresh requests',()=>fixture(async f=>{await f.start(f.a.id,'disconnect:one');await f.settled('disconnect:one',f.a.id);await f.p('/panel/disconnect',{});assert.equal((await f.get('disconnect:one',f.a.id)).data.state,'expired');await f.p('/panel/connect',{});assert.equal((await f.start(f.a.id,'disconnect:two')).status,202);}));
test('async: missing document file prevents approval without replacing or recreating it',()=>fixture(async f=>{
 await f.start(f.a.id,'missing:one');const r=(await f.settled('missing:one',f.a.id)).data;const {unlinkSync,existsSync}=await import('node:fs');const path=join(f.root,'documents',f.a.id,'document.json');unlinkSync(path);assert.notEqual((await f.action(r,'approve')).status,200);assert.equal(existsSync(path),false);
}));
test('async: lost committed response becomes uncertain and duplicate approval is refused',()=>fixture(async f=>{
 await f.start(f.a.id,'uncertain:one');const r=(await f.settled('uncertain:one',f.a.id)).data;assert.equal((await f.action(r,'approve')).status,503);assert.equal((await f.get(r.requestId,f.a.id)).data.state,'uncertain');assert.equal((await f.action(r,'approve')).status,409);assert.equal((await f.doc(f.a.id)).revision,2);assert.equal((await f.api('/api/documents/'+f.a.id+'/history')).data.events.length,1);
},{fetchImpl:async(url,options)=>{const r=await fetch(url,options);if(options.method==='PATCH')throw Error('lost response');return r;}}));
test('async: cancellation is refused after approval starts; double approval writes once',()=>fixture(async f=>{
 await f.start(f.a.id,'double:one');const r=(await f.settled('double:one',f.a.id)).data;const saved=f.action(r,'approve');await committing;assert.equal((await f.action(r,'cancel')).status,409);assert.equal((await f.action(r,'approve')).status,409);commitRelease();assert.equal((await saved).status,200);assert.equal((await f.doc(f.a.id)).revision,2);
},{fetchImpl:async(url,options)=>{if(options.method==='PATCH'){commitStarted();await commitGate;}return fetch(url,options);}}));
let commitRelease,commitStarted;const commitGate=new Promise(r=>commitRelease=r),committing=new Promise(r=>commitStarted=r);
test('async: pure ledger expires by clock and rejects wrong-document reads',async()=>{
 let clock=0;const block={id:'p',type:'paragraph',content:[],children:[],props:{}};
 const store=createAiRequests({prepare:async b=>({...b,scoped:true,proposalId:'proposal',beforeHash:'unused'}),commit:async()=>({saved:true}),document:async()=>({id:'d',revision:1,blocks:[block]}),canStart:()=>true,now:()=>clock,ttlMs:10});
 store.start({requestId:'clock:one',documentId:'d',targetId:'p',baseRevision:1,mode:'insert',model:'m',goal:'g'});await wait();assert.equal((await store.get('clock:one','d')).state,'review');await assert.rejects(store.get('clock:one','wrong'));clock=11;assert.equal((await store.get('clock:one','d')).state,'expired');store.invalidate(true);
});
test('async: client identity checks and user-facing labels never mix documents',()=>{const p={requestId:'x',documentId:'A',targetId:'p',baseRevision:7};assert.equal(matchesRequest({...p,state:'review'},p),true);for(const d of [{requestId:'old'},{documentId:'B'},{targetId:'q'},{baseRevision:8}])assert.equal(matchesRequest({...p,...d},p),false);assert.equal(requestLabel('running'),'AI 수정 중');assert.equal(requestLabel('conflict'),'문서가 변경되어 다시 요청 필요');});

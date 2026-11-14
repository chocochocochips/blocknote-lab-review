import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.mjs';
import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
import {request} from 'node:http';

const ORIGIN='http://127.0.0.1:5173';
const listen=server=>new Promise((resolve,reject)=>{
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port));
});
const stop=server=>new Promise(resolve=>server.close(resolve));
async function fixture(run,overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'blocknote-panel-'));
  const doc=createApp({documentFile:join(dir,'document.json'),historyFile:join(dir,'history.jsonl')});
  let panel, docBase, panelBase,closed=0,proposals=0;
  try {
    docBase=await listen(doc);
    panel=createAiPanelServer({
      documentBase:docBase,
      connect:async()=>({bearer:()=> 'synthetic-local-only-token',close:async()=>{closed++;}}),
      listModels:async()=>[{slug:'synthetic-model',name:'Synthetic model'}],
      propose:async({document,model,targetId})=>{
        proposals++;
        assert.equal(document.revision>=1,true);
        assert.equal(model,'synthetic-model');
        assert.ok(document.blocks.some(b=>b.id===targetId));
        return {proposal:{content:'Synthetic proposal',reason:'Synthetic test'}};
      },
      ...overrides,
    });
    panelBase=await listen(panel);
    const call=async(path,{method='GET',body,origin=ORIGIN,host}={})=>{
      const response=await fetch(panelBase+path,{method,
        headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...(host?{Host:host}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,data:await response.json()};
    };
    await run({call,docBase,panelBase,get closed(){return closed;},get proposals(){return proposals;}});
  } finally {
    if(panel)await panel.shutdown();
    await stop(doc);
    await rm(dir,{recursive:true,force:true});
  }
}
test('AI panel: same-device CORS and Host checks reject cross-origin access',()=>fixture(async({call,panelBase})=>{
  assert.equal((await call('/panel/status')).status,200);
  assert.equal((await call('/panel/status',{origin:'http://attacker.invalid'})).status,403);
  assert.equal((await call('/panel/connect',{method:'POST',body:{},origin:'http://attacker.invalid'})).status,403);
  const status=await new Promise((resolve,reject)=>{
    const req=request(panelBase+'/panel/status',{headers:{Host:'outside.invalid',Origin:ORIGIN}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(status,403);
}));
test('AI panel: request fails until connected, model names never include access token',()=>fixture(async({call})=>{
  assert.equal((await call('/panel/models')).status,409);
  assert.equal((await call('/panel/preview',{method:'POST',body:{}})).status,409);
  assert.equal((await call('/panel/connect',{method:'POST',body:{}})).data.connected,true);
  const catalog=await call('/panel/models');
  assert.deepEqual(catalog.data.models,[{slug:'synthetic-model',name:'Synthetic model'}]);
  assert.doesNotMatch(JSON.stringify(catalog),/synthetic-local-only-token/);
  assert.equal((await call('/panel/connect',{method:'POST',body:{}})).status,200);
}));
test('AI panel: pending preview needs explicit approve, verifies receipt and audit once',()=>fixture(async f=>{
  const {call,docBase}=f;
  await call('/panel/connect',{method:'POST',body:{}});
  const before=await fetch(docBase+'/api/document').then(r=>r.json());
  const targetId=before.blocks.at(-1).id;
  const result=await call('/panel/preview',{method:'POST',
    body:{model:'synthetic-model',goal:'Add one paragraph',targetId}});
  assert.equal(result.status,200);
  assert.equal(result.data.content,'Synthetic proposal');
  const restored=await call('/panel/proposal');
  assert.equal(restored.data.proposal?.proposalId,result.data.proposalId);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-local-only-token/);
  assert.equal(f.proposals,1);
  assert.equal((await fetch(docBase+'/api/document').then(r=>r.json())).revision,before.revision);
  assert.equal((await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'Again',targetId}})).status,409);
  const save=await call('/panel/approve',{method:'POST',body:{proposalId:result.data.proposalId}});
  assert.equal(save.status,200);
  assert.deepEqual(save.data,{saved:true,revision:before.revision+1,receipt:'COMMITTED',auditRecords:1});
  assert.equal((await call('/panel/approve',{method:'POST',body:{proposalId:result.data.proposalId}})).status,409);
  assert.equal((await call('/panel/proposal')).data.proposal,null);
  const after=await fetch(docBase+'/api/document').then(r=>r.json());
  assert.equal(after.blocks.at(-1).content[0].text,'Synthetic proposal');
  const history=await fetch(docBase+'/api/history').then(r=>r.json());
  assert.equal(history.events.filter(e=>e.proposal?.proposalId===result.data.proposalId).length,1);
}));
test('AI panel: stale revision refuses write; reject clears pending',()=>fixture(async({call,docBase})=>{
  await call('/panel/connect',{method:'POST',body:{}});
  const before=await fetch(docBase+'/api/document').then(r=>r.json());
  const targetId=before.blocks.at(-1).id;
  const a=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'Test',targetId}});
  const external=await fetch(docBase+'/api/blocks',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:before.revision,actor:'human-editor',content:'Other change'})});
  assert.equal(external.status,201);
  const stale=await call('/panel/approve',{method:'POST',body:{proposalId:a.data.proposalId}});
  assert.equal(stale.status,409);
  const after=await fetch(docBase+'/api/document').then(r=>r.json());
  assert.equal(after.blocks.at(-1).content[0].text,'Other change');
  const b=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'Again',targetId}});
  assert.equal(b.status,200);
  assert.equal((await call('/panel/reject',{method:'POST',body:{}})).data.rejected,true);
  assert.equal((await call('/panel/approve',{method:'POST',body:{proposalId:b.data.proposalId}})).status,409);
}));
test('AI panel: disconnect closes memory session and revokes in mock',()=>fixture(async f=>{
  await f.call('/panel/connect',{method:'POST',body:{}});
  const x=await f.call('/panel/disconnect',{method:'POST',body:{}});
  assert.equal(x.data.connected,false);
  assert.equal(f.closed,1);
  assert.equal((await f.call('/panel/status')).data.connected,false);
}));

test('AI panel: shutdown during connect awaits revocation of a late session',async()=>{
 let release,started,closed=0,finishClose,closeStarted;
 const closing=new Promise(resolve=>closeStarted=resolve);
 const closedGate=new Promise(resolve=>finishClose=resolve);
 const began=new Promise(resolve=>started=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const panel=createAiPanelServer({connect:async()=>{started();await gate;return {bearer:()=> 'synthetic',close:async()=>{closeStarted();await closedGate;closed++;}};}});
 const base=await listen(panel);
 const request=fetch(base+'/panel/connect',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:'{}'}).catch(()=>null);
 await began;
 let settled=false;
 const stopping=panel.shutdown().then(()=>{settled=true;});
 release();await closing;await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 finishClose();await request;await stopping;
 assert.equal(closed,1);
});
test('AI panel: document replacement with the same revision refuses stale approval',()=>fixture(async({call,docBase})=>{
 await call('/panel/connect',{method:'POST',body:{}});
 const doc=await fetch(docBase+'/api/document').then(r=>r.json());
 const preview=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'test',targetId:doc.blocks.at(-1).id}});
 replacement=true;
 const approved=await call('/panel/approve',{method:'POST',body:{proposalId:preview.data.proposalId}});
 assert.equal(approved.status,409);
 assert.equal((await fetch(docBase+'/api/document').then(r=>r.json())).revision,doc.revision);
},{fetchImpl:async(url,options)=>{
 const r=await fetch(url,options);
 if(new URL(url).pathname==='/api/document'&&replacement){const d=await r.json();return Response.json({...d,id:'replacement-document'});}
 return r;
}}));
let replacement=false;
test('AI panel: lost commit response is not retried and includes a receipt lookup ID',()=>fixture(async({call,docBase})=>{
 await call('/panel/connect',{method:'POST',body:{}});
 const doc=await fetch(docBase+'/api/document').then(r=>r.json());
 const preview=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'test',targetId:doc.blocks.at(-1).id}});
 const result=await call('/panel/approve',{method:'POST',body:{proposalId:preview.data.proposalId}});
 assert.equal(result.data.code,'SAVE_UNCERTAIN');assert.equal(typeof result.data.requestId,'string');
 const receipt=await fetch(docBase+'/api/requests/'+encodeURIComponent(result.data.requestId)).then(r=>r.json());
 assert.equal(receipt.outcome,'COMMITTED');
 assert.equal((await call('/panel/approve',{method:'POST',body:{proposalId:preview.data.proposalId}})).status,409);
 assert.equal((await fetch(docBase+'/api/document').then(r=>r.json())).revision,doc.revision+1);
},{fetchImpl:async(url,options)=>{const r=await fetch(url,options);if(options.method==='POST')throw Error('synthetic lost response');return r;}}));

test('AI panel: concurrent approval commits once and non-JSON writes are rejected',()=>fixture(async({call,docBase,panelBase})=>{
 const bad=await fetch(panelBase+'/panel/connect',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'text/plain'},body:'{}'});
 assert.equal(bad.status,415);
 await call('/panel/connect',{method:'POST',body:{}});
 const doc=await fetch(docBase+'/api/document').then(r=>r.json());
 const p=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'test',targetId:doc.blocks.at(-1).id}});
 const results=await Promise.all([1,2].map(()=>call('/panel/approve',{method:'POST',body:{proposalId:p.data.proposalId}})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await fetch(docBase+'/api/document').then(r=>r.json())).revision,doc.revision+1);
}));
test('AI panel: failed inference is redacted and cannot produce an approvable proposal',()=>fixture(async({call,docBase})=>{
 await call('/panel/connect',{method:'POST',body:{}});
 const d=await fetch(docBase+'/api/document').then(r=>r.json());
 const p=await call('/panel/preview',{method:'POST',body:{model:'synthetic-model',goal:'test',targetId:d.blocks.at(-1).id}});
 assert.equal(p.status,502);assert.doesNotMatch(JSON.stringify(p),/synthetic-secret/);
 assert.equal((await call('/panel/proposal')).data.proposal,null);
 assert.equal((await fetch(docBase+'/api/document').then(r=>r.json())).revision,d.revision);
},{propose:async()=>{throw Error('Bearer synthetic-secret');}}));


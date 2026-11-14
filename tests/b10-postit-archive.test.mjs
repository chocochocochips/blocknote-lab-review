import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace,createWorkspaceApp} from '../server/workspace.mjs';
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
for(const [flag,port] of [[null,5173],['LAB_B06_ISOLATED',15173],['LAB_B09_ISOLATED',25173],['LAB_B09_FOLLOWUP',35173]]){
 test(`archive via browser Origin ${port}, retrieval, restart and document independence`,async()=>{
  const flags=['LAB_B06_ISOLATED','LAB_B09_ISOLATED','LAB_B09_FOLLOWUP'];
  const saved=Object.fromEntries(flags.map(f=>[f,process.env[f]]));
  for(const f of flags)delete process.env[f];if(flag)process.env[flag]='1';
  const root=mkdtempSync(join(tmpdir(),'b10-archive-'));let server;
  try{
   const [doc]=initializeWorkspace({destination:join(root,'data'),title:'B10 합성 문서'});
   server=createWorkspaceApp({root:join(root,'data')});let base=await listen(server);
   const call=async(path,method='GET',body,origin=`http://127.0.0.1:${port}`)=>{
    const r=await fetch(base+path,{method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};
   };
   const before=(await call(`/api/documents/${doc.id}/document`)).data;
   // Controller's server-to-server save has no Origin; browser archive does.
   const seeded=await fetch(base+'/api/postits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({documentId:doc.id,requestId:'b10:synthetic',proposalId:'b10:proposal',model:'gpt-6-luna',prompt:'합성 질문\n두 번째 줄',rawContent:'합성 답변\n보관 내용'})});
   assert.equal(seeded.status,201);const draft=(await seeded.json()).postit;
   const list=await call('/api/postits');assert.equal(list.status,200);
   for(const origin of [`http://127.0.0.1:${port}`,`http://localhost:${port}`]){
    const archived=await call(`/api/postits/${draft.id}/archive`,'POST',{},origin);
    assert.equal(archived.status,200,JSON.stringify(archived.data));
    assert.equal(archived.data.postit.archived,true);assert.equal(archived.data.postit.createdAt,draft.createdAt);
    assert.equal(archived.data.postit.rawContent,draft.rawContent);assert.equal(archived.data.postit.content,draft.content);assert.equal(archived.data.postit.updatedAt,null);
   }
   const confirmed=(await call(`/api/postits/${draft.id}`)).data.postit;
   assert.ok(confirmed.archivedAt);assert.equal(confirmed.itemRevision,draft.itemRevision+1);
   for(const bad of ['https://example.invalid',`http://127.0.0.1:${port+1}`,...[5173,15173,25173,35173].filter(p=>p!==port).map(p=>`http://127.0.0.1:${p}`)]){
    const denied=await call(`/api/postits/${draft.id}/archive`,'POST',{},bad);assert.equal(denied.status,403);assert.equal(denied.data.code,'POSTIT_BAD_ORIGIN');
   }
   assert.deepEqual((await call('/api/postits?status=archived')).data.postits,[confirmed]);
   await close(server);server=createWorkspaceApp({root:join(root,'data')});base=await listen(server);
   assert.deepEqual((await call(`/api/postits/${draft.id}`)).data.postit,confirmed);
   assert.deepEqual((await call('/api/postits?status=archived')).data.postits,[confirmed]);
   assert.deepEqual((await call(`/api/documents/${doc.id}/document`)).data,before);
  }finally{if(server)await close(server);rmSync(root,{recursive:true,force:true});for(const f of flags){if(saved[f]===undefined)delete process.env[f];else process.env[f]=saved[f];}}
 });
}

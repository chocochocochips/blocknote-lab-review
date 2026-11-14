import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeWorkspace,openWorkspace,createWorkspaceApp,verifyExport} from '../server/workspace.mjs';
import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
const bytes=p=>readFileSync(p,'utf8');
async function fixture(run){
 const dir=mkdtempSync(join(tmpdir(),'f05-')),root=join(dir,'workspace');
 const [first]=initializeWorkspace({destination:root,title:'문서 A'});let server=createWorkspaceApp({root}),base=await listen(server),panel;
 const call=async(path,method='GET',data)=>{const r=await fetch(base+path,{method,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};};
 const doc=(id,suffix='/document')=>'/api/documents/'+id+suffix;
 const insert=(id,content,revision=1,extra={})=>call(doc(id,'/blocks'),'POST',{documentId:id,revision,actor:'test',content,...extra});
 try{await run({root,dir,first,call,doc,insert,restart:async()=>{await close(server);server=createWorkspaceApp({root});base=await listen(server);},panel:async(overrides={})=>{
  panel=createAiPanelServer({documentBase:base,connect:async()=>({bearer:()=> 'mock-secret',close:async()=>{}}),listModels:async()=>[{slug:'mock',name:'Mock'}],propose:async()=>({proposal:{content:'synthetic',reason:'test'}}),...overrides});const url=await listen(panel);
  return async(path,body)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:5173',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 }});}finally{if(panel)await panel.shutdown();await close(server);rmSync(dir,{recursive:true,force:true});}
}
test('workspace: duplicate titles have distinct IDs, blank bodies and independent histories',()=>fixture(async({first,call,doc})=>{
 const b=await call('/api/documents','POST',{title:first.title});assert.equal(b.status,201);assert.notEqual(b.data.id,first.id);
 const d=(await call(doc(b.data.id))).data;assert.equal(d.revision,1);assert.equal(d.blocks[0].content[0].text,'');assert.deepEqual((await call(doc(b.data.id,'/history'))).data.events,[]);assert.equal((await call('/api/documents')).data.documents.length,2);
}));
test('workspace: concurrent saves to separate documents isolate content, revision and audit',()=>fixture(async({first,call,doc,insert})=>{
 const b=(await call('/api/documents','POST',{title:'B'})).data;assert.deepEqual((await Promise.all([first,b].map(d=>insert(d.id,d.title)))).map(r=>r.status),[201,201]);
 for(const d of [first,b]){const saved=(await call(doc(d.id))).data;assert.equal(saved.revision,2);assert.equal(saved.blocks.at(-1).content[0].text,d.title);assert.equal((await call(doc(d.id,'/history'))).data.events.length,1);}
}));
test('workspace: simultaneous same-document CAS has exactly one winner',()=>fixture(async({first,insert,call,doc})=>{
 assert.deepEqual((await Promise.all(['x','y'].map(x=>insert(first.id,x)))).map(r=>r.status).sort(),[201,409]);assert.equal((await call(doc(first.id,'/history'))).data.events.length,1);
}));
test('workspace: missing or wrong document IDs cannot write at matching revision',()=>fixture(async({first,call,doc,insert})=>{
 for(const id of [undefined,'other'])assert.equal((await insert(first.id,'bad',1,{documentId:id})).status,409);
 assert.equal((await call(doc(first.id))).data.revision,1);
}));
test('workspace: replay receipts are document-scoped and mismatched replay is rejected',()=>fixture(async({first,call,doc,insert})=>{
 const b=(await call('/api/documents','POST',{title:'B'})).data;
 for(const d of [first,b]){for(let n=0;n<2;n++)assert.equal((await insert(d.id,d.title,1,{requestId:'same-id'})).status,201);assert.equal((await call(doc(d.id,'/history'))).data.events.length,1);}
 assert.equal((await insert(b.id,b.title,1,{requestId:'same-id',documentId:first.id})).status,409);
}));
test('workspace: rename/archive/restore preserve ID, paths and bytes; archived writes fail',()=>fixture(async({first,root,call,insert})=>{
 const path=join(root,'documents',first.id,'document.json'),before=bytes(path),meta='/api/documents/'+first.id;
 const r=await call(meta,'PATCH',{title:'새 제목',metadataVersion:1});assert.equal(r.status,200);assert.equal(r.data.id,first.id);assert.equal(bytes(path),before);
 assert.equal((await call(meta,'PATCH',{archived:true,metadataVersion:2})).status,200);assert.equal((await insert(first.id,'bad')).status,409);
 assert.equal((await call('/api/blocks','POST',{documentId:first.id,revision:1,actor:'test',content:'bad'})).status,409);assert.equal(bytes(path),before);
 assert.equal((await call(meta,'PATCH',{archived:false,metadataVersion:3})).status,200);assert.equal((await insert(first.id,'ok')).status,201);
}));
test('workspace: metadata CAS, title validation and archive type validation',()=>fixture(async({first,call})=>{
 const p='/api/documents/'+first.id;assert.equal((await call(p,'PATCH',{title:'X',metadataVersion:1})).status,200);assert.equal((await call(p,'PATCH',{title:'Y',metadataVersion:1})).status,409);assert.equal((await call('/api/documents','POST',{title:' '})).status,400);assert.equal((await call(p,'PATCH',{archived:'yes',metadataVersion:2})).status,400);
}));
test('workspace: list, metadata, bodies and history survive server restart',()=>fixture(async({first,call,doc,insert,restart})=>{
 const b=(await call('/api/documents','POST',{title:'B'})).data;await insert(b.id,'persist');await call('/api/documents/'+first.id,'PATCH',{archived:true,metadataVersion:1});const before=(await call('/api/documents')).data;await restart();assert.deepEqual((await call('/api/documents')).data,before);assert.equal((await call(doc(b.id))).data.blocks.at(-1).content[0].text,'persist');assert.equal((await call(doc(b.id,'/history'))).data.events.length,1);
}));
test('workspace: export verifies bytes and reconstructs fresh storage without auth or paths',()=>fixture(async({first,call,doc,insert,dir})=>{
 await insert(first.id,'backup');const b=(await call(doc(first.id,'/export'))).data,v=verifyExport(b);assert.equal(v.doc.revision,2);assert.equal(v.events.length,1);assert.deepEqual(Object.keys(b.files).sort(),['document.json','history.jsonl']);assert.doesNotMatch(JSON.stringify(b),/mock-secret|OAuth|\/tmp\/|memory.json/);
 const source=join(dir,'reconstructed');mkdirSync(source);for(const [name,text] of Object.entries(b.files))writeFileSync(join(source,name),text);
 const destination=join(dir,'restored');initializeWorkspace({destination,source,title:b.manifest.title});const store=openWorkspace(destination).get(first.id).storage;assert.deepEqual(store.readDocument(),v.doc);assert.deepEqual(store.readHistory(),v.events);
}));
test('workspace: tampered export, wrong identity and extra files fail verification',()=>fixture(async({first,call,doc})=>{
 const b=(await call(doc(first.id,'/export'))).data;assert.throws(()=>verifyExport({...b,files:{...b.files,'history.jsonl':'{}'}}));assert.throws(()=>verifyExport({...b,manifest:{...b.manifest,documentId:'wrong'}}));assert.throws(()=>verifyExport({...b,files:{...b.files,'memory.json':''}}));
}));
test('workspace: legacy Revision 7 copy preserves original, prior backup, ID, blocks and audit',()=>fixture(async({dir})=>{
 const source=join(dir,'legacy');mkdirSync(source);const d={id:'legacy-seven',revision:7,updatedAt:'2026-10-31T00:00:00.000Z',blocks:[{id:'block',type:'paragraph',props:{},content:[{type:'text',text:'원본',styles:{}}],children:[]}]};const document=JSON.stringify(d),history=JSON.stringify({revision:7,actor:'synthetic',operation:'document.save'})+'\n';writeFileSync(join(source,'document.json'),document);writeFileSync(join(source,'history.jsonl'),history);writeFileSync(join(source,'document.json.bak'),'preserved-old-backup');
 const destination=join(dir,'copy');initializeWorkspace({destination,source});for(const [name,value] of [['document.json',document],['history.jsonl',history],['document.json.bak','preserved-old-backup']]){assert.equal(bytes(join(source,name)),value);assert.equal(bytes(join(destination,'source-backup',name)),value);}assert.deepEqual(openWorkspace(destination).get(d.id).storage.readDocument(),d);assert.throws(()=>initializeWorkspace({destination,source}));
}));
for(const name of ['document.json','history.jsonl'])test('workspace: missing '+name+' blocks startup and runtime mutation without reinitializing',()=>fixture(async({root,first,insert})=>{
 const dir=join(root,'documents',first.id),other=join(dir,name==='document.json'?'history.jsonl':'document.json'),before=bytes(other);unlinkSync(join(dir,name));assert.throws(()=>createWorkspaceApp({root}));assert.equal((await insert(first.id,'bad')).status,503);assert.equal(bytes(other),before);
}));
for(const name of ['document.json','history.jsonl','workspace.json'])test('workspace: corrupt '+name+' refuses startup and preserves bytes',()=>fixture(async({root,first})=>{
 const p=name==='workspace.json'?join(root,name):join(root,'documents',first.id,name);writeFileSync(p,'{broken');assert.throws(()=>createWorkspaceApp({root}));assert.equal(bytes(p),'{broken');
}));
test('workspace: runtime valid-JSON audit corruption refuses write before document changes',()=>fixture(async({root,first,insert})=>{
 const dir=join(root,'documents',first.id),before=bytes(join(dir,'document.json'));writeFileSync(join(dir,'history.jsonl'),'{}\n');assert.equal((await insert(first.id,'bad')).status,503);assert.equal(bytes(join(dir,'document.json')),before);
}));
test('workspace: traversal IDs, symlinks and missing registry are never initialized',()=>fixture(async({root,first,dir})=>{
 const p=join(root,'workspace.json'),saved=bytes(p),r=JSON.parse(saved);r.documents[0].id='../escape';writeFileSync(p,JSON.stringify(r));assert.throws(()=>openWorkspace(root));writeFileSync(p,saved);
 const h=join(root,'documents',first.id,'history.jsonl'),outside=join(dir,'outside');unlinkSync(h);writeFileSync(outside,'');symlinkSync(outside,h);assert.throws(()=>openWorkspace(root));unlinkSync(p);assert.throws(()=>openWorkspace(root));
}));
test('AI workspace: scoped preview and approval require document ID and base revision; audit once',()=>fixture(async({first,call,doc,panel})=>{
 const p=await panel();await p('/panel/connect',{});const b=(await call('/api/documents','POST',{title:'B'})).data,d=(await call(doc(first.id))).data;
 const preview=await p('/panel/preview',{documentId:first.id,baseRevision:1,model:'mock',goal:'test',targetId:d.blocks[0].id});assert.equal(preview.status,200);assert.equal(preview.data.documentId,first.id);
 const approve={proposalId:preview.data.proposalId,documentId:first.id,baseRevision:1};assert.equal((await p('/panel/approve',{...approve,documentId:b.id})).status,409);assert.equal((await p('/panel/approve',{...approve,baseRevision:2})).status,409);
 assert.equal((await p('/panel/approve',approve)).status,200);assert.equal((await p('/panel/approve',approve)).status,409);assert.equal((await call(doc(first.id,'/history'))).data.events.length,1);assert.equal((await call(doc(b.id))).data.revision,1);assert.equal((await call(doc(b.id,'/history'))).data.events.length,0);
 assert.equal((await p('/panel/preview',{documentId:first.id,baseRevision:1,model:'mock',goal:'stale',targetId:d.blocks[0].id})).status,409);
}));
test('AI workspace: edit or archive after preview rejects approval',()=>fixture(async({first,call,doc,insert,panel})=>{
 const p=await panel();await p('/panel/connect',{});const d=(await call(doc(first.id))).data;
 for(const revision of [1,2]){const preview=await p('/panel/preview',{documentId:first.id,baseRevision:revision,model:'mock',goal:'test',targetId:d.blocks[0].id});assert.equal(preview.status,200);if(revision===1)await insert(first.id,'external');else await call('/api/documents/'+first.id,'PATCH',{archived:true,metadataVersion:1});assert.equal((await p('/panel/approve',{documentId:first.id,baseRevision:revision,proposalId:preview.data.proposalId})).status,409);}
 assert.equal((await call(doc(first.id))).data.revision,2);
}));
test('AI workspace: delayed inference remains bound to A and cannot be approved on B',()=>fixture(async({first,call,doc,panel})=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);const p=await panel({propose:async({document})=>{started();await gate;assert.equal(document.id,first.id);return {proposal:{content:'late A',reason:'test'}};}});await p('/panel/connect',{});const d=(await call(doc(first.id))).data;
 const pending=p('/panel/preview',{documentId:first.id,baseRevision:1,model:'mock',goal:'test',targetId:d.blocks[0].id});await began;const b=(await call('/api/documents','POST',{title:'B'})).data;assert.equal((await p('/panel/reject',{documentId:first.id})).status,409);release();const preview=await pending;assert.equal(preview.data.documentId,first.id);assert.equal((await p('/panel/approve',{documentId:b.id,baseRevision:1,proposalId:preview.data.proposalId})).status,409);assert.equal((await call(doc(b.id))).data.revision,1);
}));

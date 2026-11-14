import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash,randomUUID} from 'node:crypto';
import {initializeWorkspace,openWorkspace,createWorkspaceApp} from '../server/workspace.mjs';import {inspectBackup} from '../server/restore.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(run){const dir=mkdtempSync(join(tmpdir(),'f07-restore-')),root=join(dir,'workspace');initializeWorkspace({destination:root,title:'원본'});const w=openWorkspace(root),id=w.defaultId;try{return run({dir,root,w,id});}finally{rmSync(dir,{recursive:true,force:true});}}
function signed(w,id){const s=w.get(id).storage,d=s.readDocument(),old=d.blocks[0].content[0].text,next=structuredClone(d);next.revision++;next.updatedAt=new Date().toISOString();next.blocks[0].content[0].text='합성 승인된 문장';s.writeDocument(d,next,'synthetic','block.update',d.blocks[0].id,null,{proposalId:'synthetic-approval',goal:'다듬기',reason:'합성 시험',approval:'approved',edit:{model:'synthetic-test',documentId:id,blockId:d.blocks[0].id,baseRevision:d.revision,beforeText:old,afterText:'합성 승인된 문장',beforeHash:sha(old)}});return w.export(id);}
function payload(bundle,extra={}){return {bundle,digest:inspectBackup(bundle).digest,confirmed:true,requestId:'restore:'+randomUUID(),...extra};}
const rehash=b=>{for(const k of Object.keys(b.files))b.manifest.files[k]=sha(b.files[k]);return b;};
const changeDoc=(b,fn)=>{const d=JSON.parse(b.files['document.json']);fn(d);b.files['document.json']=JSON.stringify(d);return rehash(b);};
test('restore: actual F05 synthetic Cloudtype backup retains single and partial approval history',()=>fixture(({w})=>{
 const b=JSON.parse(readFileSync(new URL('./fixtures/cloud-synthetic-backup.json',import.meta.url),'utf8'));
 const v=inspectBackup(b);assert.equal(v.doc.revision,6);assert.equal(v.events.length,5);
 const r=w.restore(payload(b)),events=w.get(r.id).storage.readHistory();assert.equal(events.filter(e=>e.proposal).length,2);
 assert.equal(events.find(e=>e.proposal?.edits).proposal.edits.length,2);
 for(const e of events)for(const x of e.proposal?.edits||(e.proposal?.edit?[e.proposal.edit]:[]))assert.equal(x.documentId,r.id);
 assert.equal(w.previewRestore(w.export(r.id)).revision,6);
}));
test('restore: preview performs no writes and includes title/body/revision/history and integrity',()=>fixture(({w,id,root})=>{const b=signed(w,id),registry=readFileSync(join(root,'workspace.json'),'utf8'),p=w.previewRestore(b);assert.equal(p.title,'원본');assert.equal(p.revision,2);assert.equal(p.historyCount,1);assert.match(p.text,/합성 승인/);assert.equal(p.integrity,'checksum-verified');assert.equal(readFileSync(join(root,'workspace.json'),'utf8'),registry);assert.equal(w.list().length,1);}));
test('restore: same source ID always gets a fresh ID, preserves revision/approval and remains editable',()=>fixture(({w,id,root})=>{const b=signed(w,id),source=JSON.stringify(b),original=w.get(id).storage.readDocument(),r=w.restore(payload(b));assert.notEqual(r.id,id);const d=w.get(r.id).storage.readDocument(),e=w.get(r.id).storage.readHistory();assert.equal(d.revision,2);assert.deepEqual(d.blocks,original.blocks);assert.equal(e[0].proposal.edit.documentId,r.id);assert.equal(e[0].proposal.approval,'approved');assert.equal(e[0].proposal.edit.beforeHash,sha(''));assert.deepEqual(w.get(id).storage.readDocument(),original);assert.equal(JSON.stringify(b),source);const next={...d,revision:3,updatedAt:new Date().toISOString()};w.get(r.id).storage.writeDocument(d,next,'human-editor','document.save');assert.equal(openWorkspace(root).get(r.id).storage.readDocument().revision,3);assert.equal(openWorkspace(root).get(r.id).storage.readHistory().length,2);}));
test('restore: new requests for same backup are blocked; same request replay survives reopen',()=>fixture(({w,id,root})=>{const b=w.export(id),p=payload(b),a=w.restore(p),reopened=openWorkspace(root);assert.equal(reopened.restore(p).id,a.id);assert.equal(reopened.previewRestore(b).duplicate.id,a.id);assert.throws(()=>reopened.restore(payload(b)),e=>e.code==='DUPLICATE_BACKUP');assert.equal(reopened.list().length,2);}));
test('restore: whitespace/key order/title/time changes cannot evade duplicate identity',()=>fixture(({w,id})=>{
 const b=signed(w,id);w.restore(payload(b));const variant=structuredClone(b);variant.manifest.title='다른 파일 이름';variant.manifest.modifiedAt='2026-11-02T00:00:00Z';
 const d=JSON.parse(variant.files['document.json']);variant.files['document.json']=JSON.stringify({blocks:d.blocks,updatedAt:d.updatedAt,revision:d.revision,id:d.id});rehash(variant);
 assert.ok(w.previewRestore(variant).duplicate);assert.throws(()=>w.restore(payload(variant)),e=>e.code==='DUPLICATE_BACKUP');
}));
test('restore: same content on different document IDs is not a duplicate; new revision/content remains importable',()=>fixture(({w,id})=>{
 const b=w.export(id);w.restore(payload(b));const other=structuredClone(b);other.manifest.documentId='different-document';changeDoc(other,d=>{d.id='different-document';});assert.equal(w.previewRestore(other).duplicate,null);w.restore(payload(other));
 const changed=structuredClone(b);changeDoc(changed,d=>{d.blocks[0].content[0].text='변경된 백업';});assert.equal(w.previewRestore(changed).duplicate,null);w.restore(payload(changed));assert.equal(w.list().length,4);
}));
test('restore: archived/edited restored document still blocks duplicate without changing its bytes',()=>fixture(({w,id,root})=>{
 const b=w.export(id),r=w.restore(payload(b));w.update(r.id,{metadataVersion:1,archived:true});const before=readFileSync(w.get(r.id).storage.paths.documentFile);const reopened=openWorkspace(root);assert.equal(reopened.previewRestore(b).duplicate.archived,true);assert.throws(()=>reopened.restore(payload(b)),e=>e.code==='DUPLICATE_BACKUP');assert.deepEqual(readFileSync(w.get(r.id).storage.paths.documentFile),before);
}));
test('restore: snapshot export time ignored but dirty/content/source ID distinguish backups',()=>fixture(({w,id})=>{
 const d=w.get(id).storage.readDocument(),b={documentId:id,revision:1,blocks:d.blocks,localEdits:false,exportedAt:d.updatedAt};w.restore(payload(b));assert.ok(w.previewRestore({...b,exportedAt:'2026-11-02T00:00:00Z'}).duplicate);assert.equal(w.previewRestore({...b,documentId:'other'}).duplicate,null);assert.equal(w.previewRestore({...b,localEdits:true}).duplicate,null);
}));
test('restore: stale duplicate-free preview cannot approve after another request restores it',()=>fixture(({w,id})=>{
 const b=w.export(id),first=payload(b),second=payload(b);assert.equal(w.previewRestore(b).duplicate,null);w.restore(first);assert.throws(()=>w.restore(second),e=>e.code==='DUPLICATE_BACKUP');assert.equal(w.list().length,2);
}));
test('restore: preview digest/confirmation/title/request identity required before any write',()=>fixture(({w,id,root})=>{const b=w.export(id),before=readFileSync(join(root,'workspace.json'),'utf8');for(const extra of [{confirmed:false},{digest:'wrong'},{title:' '},{requestId:'../escape'}])assert.throws(()=>w.restore(payload(b,extra)));assert.equal(readFileSync(join(root,'workspace.json'),'utf8'),before);assert.equal(readdirSync(join(root,'documents')).length,1);}));
test('restore: local JSON has no invented history/title/hash and warns about unsaved version',()=>fixture(({w,id})=>{const d=w.get(id).storage.readDocument(),b={documentId:id,revision:7,blocks:d.blocks,localEdits:true,exportedAt:d.updatedAt},p=w.previewRestore(b);assert.equal(p.integrity,'structure-only');assert.equal(p.historyCount,0);assert.match(p.warnings.join(' '),/미저장/);const r=w.restore(payload(b));assert.equal(w.get(r.id).storage.readDocument().revision,7);assert.deepEqual(w.get(r.id).storage.readHistory(),[]);}));
const corruptions={
 'checksum':b=>{b.files['history.jsonl']+=' ';},
 'unsupported version':b=>{b.manifest.formatVersion=99;},
 'traversal file':b=>{b.files['../document.json']='x';},
 'wrong document identity':b=>{b.manifest.documentId='other';},
 'duplicate blocks':b=>changeDoc(b,d=>d.blocks.push(d.blocks[0])),
 'malformed history':b=>{b.files['history.jsonl']='{bad\n';rehash(b);},
 'invalid history timestamp':b=>{const e=JSON.parse(b.files['history.jsonl']);e.at='bad';b.files['history.jsonl']=JSON.stringify(e);rehash(b);},
 'duplicate history':b=>{b.files['history.jsonl']+=b.files['history.jsonl'];rehash(b);},
 'future history':b=>{const e=JSON.parse(b.files['history.jsonl']);e.revision=900;b.files['history.jsonl']=JSON.stringify(e);rehash(b);},
 'damaged approval hash':b=>{const e=JSON.parse(b.files['history.jsonl']);e.proposal.edit.beforeHash='malformed';b.files['history.jsonl']=JSON.stringify(e);rehash(b);},
 'script link':b=>changeDoc(b,d=>d.blocks[0].content=[{type:'link',href:'javascript:alert(1)',content:[{type:'text',text:'x',styles:{}}]}]),
 'HTML custom inline':b=>changeDoc(b,d=>d.blocks[0].content=[{type:'html',html:'<script>alert(1)</script>'}]),
 'unknown properties':b=>changeDoc(b,d=>d.blocks[0].props.onClick='alert(1)'),
 'unsafe ID':b=>{b.manifest.documentId='../escape';},
 'prototype key':b=>{Object.defineProperty(b,'__proto__',{value:{polluted:true},enumerable:true});},
 'oversized file':b=>{b.extra='x'.repeat(750001);}
};
for(const [name,damage]of Object.entries(corruptions))test('restore rejects '+name+' without altering existing data',()=>fixture(({w,id,root})=>{const b=signed(w,id),doc=readFileSync(w.get(id).storage.paths.documentFile),history=readFileSync(w.get(id).storage.paths.historyFile),registry=readFileSync(join(root,'workspace.json'));damage(b);assert.throws(()=>w.previewRestore(b));assert.throws(()=>w.restore({bundle:b,confirmed:true,digest:'invalid',requestId:'restore:'+randomUUID()}));assert.deepEqual(readFileSync(w.get(id).storage.paths.documentFile),doc);assert.deepEqual(readFileSync(w.get(id).storage.paths.historyFile),history);assert.deepEqual(readFileSync(join(root,'workspace.json')),registry);assert.equal(readdirSync(join(root,'documents')).length,1);}));
for(const stage of ['document','history','validated','renamed','beforeRegistry'])test('restore failure at '+stage+' publishes no partial document',()=>fixture(({w,id,root})=>{const b=w.export(id),before=readFileSync(join(root,'workspace.json'));const faulty=openWorkspace(root,{restoreFaults:s=>{if(s===stage)throw Error('synthetic disk error');}});assert.throws(()=>faulty.restore(payload(b)),/기존 문서/);assert.deepEqual(readFileSync(join(root,'workspace.json')),before);assert.equal(openWorkspace(root).list().length,1);assert.equal(readdirSync(join(root,'documents')).length,1);}));
test('restore: lost result after publication is recoverable by request ID without duplicate writes',()=>fixture(({w,id,root})=>{const p=payload(w.export(id)),f=openWorkspace(root,{restoreFaults:s=>{if(s==='published')throw Error('lost response');}});assert.throws(()=>f.restore(p),/목록/);assert.equal(openWorkspace(root).list().length,2);const recovered=openWorkspace(root).restore(p);assert.notEqual(recovered.id,id);assert.equal(openWorkspace(root).list().length,2);}));
test('restore: backup recovers into a separate initialized server store after synthetic reset',()=>fixture(({w,id,dir})=>{const b=signed(w,id),fresh=join(dir,'fresh');initializeWorkspace({destination:fresh});const recovered=openWorkspace(fresh),r=recovered.restore(payload(b));assert.equal(recovered.list().length,2);assert.equal(recovered.get(r.id).storage.readDocument().revision,2);assert.equal(recovered.get(r.id).storage.readHistory()[0].proposal.edit.documentId,r.id);}));
test('restore HTTP: preview and explicit confirmation required, malformed JSON and write failures keep source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'f07-http-')),root=join(dir,'workspace');initializeWorkspace({destination:root});const w=openWorkspace(root),b=w.export(w.defaultId),server=createWorkspaceApp({root,workspace:w});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const post=async(path,value)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:typeof value==='string'?value:JSON.stringify(value)});return {status:r.status,body:await r.json()};};
 try{assert.equal((await post('/api/documents/restore/preview','{bad')).status,400);const p=(await post('/api/documents/restore/preview',{bundle:b})).body;assert.equal((await post('/api/documents/restore',{bundle:b,digest:p.digest,confirmed:false,requestId:'restore:'+randomUUID()})).status,409);assert.equal((await post('/api/documents/restore',payload(b))).status,201);assert.equal(w.list().length,2);}finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});rmSync(dir,{recursive:true,force:true});}
});

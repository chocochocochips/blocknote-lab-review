import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,readdirSync,mkdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {defaultStyleSpecs} from '@blocknote/core';
import {fontSize,isEditorFontSize} from '../shared/font-size.mjs';
import {initializeWorkspace,openWorkspace} from '../server/workspace.mjs';
import {inspectBackup} from '../server/restore.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const text = (value,styles={}) => ({type:'text',text:value,styles});
const block = (id,content,children=[]) => ({id,type:'paragraph',props:{},content,children});
const richBlocks = () => [block('styled-root',[
  text('글씨 크기와 기존 서식 ',{fontSize:'20',bold:true,italic:true,underline:true,strike:false,code:false,textColor:'#205B46',backgroundColor:'yellow'}),
  {type:'link',href:'https://example.com/synthetic',content:[text('안전한 링크',{fontSize:'12.5',italic:true})]},
], [block('nested-child',[text('중첩 문단',{fontSize:'36',strike:true})], [block('nested-grandchild',[text('작은 글씨',{fontSize:'12',code:true})])])])];
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'p2-font-restore-')),root=join(dir,'workspace');
  initializeWorkspace({destination:root,title:'합성 글씨 크기 원본'});
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const workspace=openWorkspace(root),id=workspace.defaultId;
  return {dir,root,workspace,id};
}
function seed(w,id) {
  const s=w.get(id).storage,d=s.readDocument();
  const styled={...d,revision:d.revision+1,updatedAt:new Date().toISOString(),blocks:richBlocks()};
  s.writeDocument(d,styled,'synthetic','document.save');
  // A historical insertion receipt also carries a full styled block. It must
  // receive exactly the same strict validation as current document content.
  const inserted=block('approved-insertion',[text('승인된 합성 문단',{fontSize:'21',underline:true})]);
  const next={...styled,revision:styled.revision+1,updatedAt:new Date().toISOString(),blocks:[...styled.blocks,inserted]};
  s.writeDocument(styled,next,'synthetic','block.insert',inserted.id,{
    requestId:'synthetic-font-insert',fingerprint:sha('synthetic-font-insert'),status:201,
    body:{revision:next.revision,block:inserted},
  },{proposalId:'synthetic-font-proposal',goal:'합성 백업 검수',reason:'실제 AI 호출 없음',approval:'approved'});
  return w.export(id);
}
const snapshot = checked => ({documentId:checked.doc.id,revision:checked.doc.revision,blocks:structuredClone(checked.doc.blocks),localEdits:true,exportedAt:checked.doc.updatedAt});
const approved = (bundle,preview) => ({bundle,digest:preview.digest,confirmed:true,requestId:'restore:'+randomUUID()});
function rehash(bundle) {
  for(const name of Object.keys(bundle.files))bundle.manifest.files[name]=sha(bundle.files[name]);
  return bundle;
}
function mutateDocument(bundle,change) {
  const doc=JSON.parse(bundle.files['document.json']);change(doc);
  bundle.files['document.json']=JSON.stringify(doc);return rehash(bundle);
}
function storeBytes(w,id,root) {
  return ['documentFile','historyFile'].map(k=>readFileSync(w.get(id).storage.paths[k])).concat(readFileSync(join(root,'workspace.json')));
}

test('P2 restore: font-size accepts only canonical editor output, including bounded decimal sizes',()=>{
  assert.deepEqual(Object.keys(defaultStyleSpecs).sort(),['backgroundColor','bold','code','italic','strike','textColor','underline']);
  for(const input of [undefined,null,0,'invalid',-10,12,12.5,17,20,21,35.75,36,100,Infinity]) {
    assert.equal(isEditorFontSize(String(fontSize(input))),true,String(input));
  }
  for(let n=12;n<=36;n+=0.5)assert.equal(isEditorFontSize(String(n)),true);
  for(const value of [20,true,false,null,{},[],NaN,Infinity,'',' ',' 20','20 ','020','+20','20.0','20px','20%','2e1','0x14','11.99','36.01','NaN','Infinity','calc(20px)','20; color:red','url(https://evil.test)']) {
    assert.equal(isEditorFontSize(value),false,String(value));
  }
});

test('P2 restore: project and local snapshot keep existing styles, links, nested blocks and honest history',t=>{
  const {workspace:w,id}=fixture(t),bundle=seed(w,id),checked=inspectBackup(bundle);
  assert.equal(checked.preview.integrity,'checksum-verified');assert.equal(checked.events.length,2);
  assert.equal(checked.events[1].idempotency.body.block.content[0].styles.fontSize,'21');
  for(const input of [bundle,snapshot(checked)]) {
    const before=JSON.stringify(input),preview=w.previewRestore(input),r=w.restore(approved(input,preview));
    assert.notEqual(r.id,id);assert.deepEqual(w.get(r.id).storage.readDocument().blocks,checked.doc.blocks);
    assert.equal(w.get(r.id).storage.readDocument().revision,checked.doc.revision);
    assert.equal(JSON.stringify(input),before);
    const events=w.get(r.id).storage.readHistory();
    if(input.manifest)assert.deepEqual(events,checked.events);
    else {assert.deepEqual(events,[]);assert.equal(preview.integrity,'structure-only');assert.match(preview.warnings.join(' '),/승인 이력.*없어요/);}
  }
});

test('P2 restore: exact failing f80 Cloudtype synthetic backup is accepted without rewriting original bytes',t=>{
  const {workspace:w,id}=fixture(t);
  const raw=readFileSync(new URL('./fixtures/cloudtype-fontsize-rev6.json',import.meta.url),'utf8');
  assert.equal(sha(raw),'21b8f846a5f7d31ce8b188e82fb47b2c60697a48f5333794e6dec1f5aa74b824');
  const bundle=JSON.parse(raw),p=w.previewRestore(bundle),restored=w.restore(approved(bundle,p));
  assert.equal(p.integrity,'checksum-verified');assert.equal(p.revision,6);assert.notEqual(restored.id,id);
  assert.deepEqual(w.get(restored.id).storage.readDocument().blocks,JSON.parse(bundle.files['document.json']).blocks);
  assert.equal(w.get(restored.id).storage.readDocument().blocks[0].content[0].styles.fontSize,'21');
  assert.equal(w.previewRestore(bundle).duplicate.id,restored.id);
});

test('P2 restore: dependency-free Docker runtime copy includes the shared font-size policy',async t=>{
  const {dir}=fixture(t),runtime=join(dir,'runtime');mkdirSync(runtime);
  const lab=new URL('../',import.meta.url);
  const docker=readFileSync(new URL('Dockerfile',lab),'utf8').split('AS runtime')[1];
  for(const line of docker.split('\n').filter(x=>x.startsWith('COPY ')&&!x.includes('--from='))) {
    const parts=line.trim().split(/\s+/).slice(1),target=parts.pop();
    mkdirSync(join(runtime,target),{recursive:true});
    for(const source of parts)copyFileSync(new URL(source,lab),join(runtime,target,source.split('/').at(-1)));
  }
  const {createSyntheticWorkspace}=await import(pathToFileURL(join(runtime,'scripts/workspace-fixture.mjs')));
  const {openWorkspace:open}=await import(pathToFileURL(join(runtime,'server/workspace.mjs')));
  // Importing the entry point resolves every packaged transitive dependency.
  await import(pathToFileURL(join(runtime,'server/cloud-start.mjs')));
  const root=join(dir,'packaged-workspace');createSyntheticWorkspace(root);const w=open(root),bundle=seed(w,w.defaultId);
  const preview=w.previewRestore(bundle),r=w.restore(approved(bundle,preview));
  assert.equal(w.get(r.id).storage.readDocument().blocks[0].content[0].styles.fontSize,'20');
});

for(const [label,value] of Object.entries({units:'20px',css:'20; color:red',exponent:'2e1',whitespace:' 20',below:'11',above:'37',numeric:20,boolean:true,null:null,array:['20'],object:{value:'20'}})) {
  test('P2 restore rejects unsafe font-size '+label+' before writes in both backup formats',t=>{
    const {workspace:w,id,root}=fixture(t),bundle=seed(w,id),before=storeBytes(w,id,root);
    mutateDocument(bundle,doc=>{doc.blocks[0].children[0].content[0].styles.fontSize=value;});
    const raw=JSON.parse(bundle.files['document.json']);
    for(const input of [bundle,snapshot({doc:raw})]) {
      assert.throws(()=>w.previewRestore(input),e=>e.code==='INVALID_BACKUP');
      assert.throws(()=>w.restore({bundle:input,confirmed:true,digest:'untrusted',requestId:'restore:'+randomUUID()}),e=>e.code==='INVALID_BACKUP');
    }
    assert.deepEqual(storeBytes(w,id,root),before);assert.equal(readdirSync(join(root,'documents')).length,1);
  });
}

test('P2 restore: bad historical font-size, unknown style and malicious link still fail closed',t=>{
  const {workspace:w,id,root}=fixture(t),good=seed(w,id),before=storeBytes(w,id,root);
  for(const damage of [
    b=>{const rows=b.files['history.jsonl'].trim().split('\n').map(JSON.parse);rows[1].idempotency.body.block.content[0].styles.fontSize='36px';b.files['history.jsonl']=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';rehash(b);},
    b=>mutateDocument(b,d=>{d.blocks[0].content[0].styles.fontFamily='evil';}),
    b=>mutateDocument(b,d=>{d.blocks[0].content[1].content[0].styles.fontSize='var(--evil)';}),
    b=>mutateDocument(b,d=>{d.blocks[0].content[1].href='javascript:alert(1)';}),
    b=>mutateDocument(b,d=>{d.blocks[0].content[0].styles.bold='true';}),
  ]) {
    const b=structuredClone(good);damage(b);assert.throws(()=>w.previewRestore(b),e=>e.code==='INVALID_BACKUP');
    assert.throws(()=>w.restore({bundle:b,confirmed:true,digest:'bad',requestId:'restore:'+randomUUID()}),e=>e.code==='INVALID_BACKUP');
    assert.deepEqual(storeBytes(w,id,root),before);
  }
});

test('P2 restore: styled backup semantic duplicates blocked, different document identity allowed after reopen',t=>{
  const {workspace:w,id,root}=fixture(t),bundle=seed(w,id),preview=w.previewRestore(bundle),r=w.restore(approved(bundle,preview));
  const again=openWorkspace(root),variant=structuredClone(bundle);variant.manifest.title='다른 파일명';
  assert.equal(again.previewRestore(variant).duplicate.id,r.id);
  assert.throws(()=>again.restore(approved(variant,again.previewRestore(variant))),e=>e.code==='DUPLICATE_BACKUP');
  const other=structuredClone(bundle);other.manifest.documentId='different-styled-document';mutateDocument(other,d=>{d.id=other.manifest.documentId;});
  assert.equal(again.previewRestore(other).duplicate,null);again.restore(approved(other,again.previewRestore(other)));
  assert.equal(again.list().length,3);
});

async function serverProcess(root) {
  const source=`import {createWorkspaceApp} from ${JSON.stringify(new URL('../server/workspace.mjs',import.meta.url).href)};const s=createWorkspaceApp({root:process.argv[1]});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,root],{stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>{log+=b;});
  const port=await new Promise((resolve,reject)=>{
    child.once('error',reject);child.once('exit',()=>reject(Error('synthetic server exited: '+log)));
    let line='';child.stdout.on('data',b=>{line+=b;if(/^\d+\n/.test(line))resolve(Number(line.trim()));});
  });
  return {child,origin:'http://127.0.0.1:'+port};
}
async function stop(server) {
  if(!server||server.child.exitCode!==null||server.child.signalCode!==null)return;
  const exited=once(server.child,'exit');server.child.kill('SIGTERM');await exited;
}

test('P2 restore HTTP: export → read-only preview → approval → fresh document → save → process restart persists', {timeout:15000},async t=>{
  const {workspace:w,id,root}=fixture(t),bundle=seed(w,id),checked=inspectBackup(bundle),before=storeBytes(w,id,root);
  let server=await serverProcess(root);t.after(()=>stop(server));
  const api=async(path,method='GET',body)=>{
    const response=await fetch(server.origin+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const exported=await api('/api/documents/'+id+'/export');assert.deepEqual(exported.body,bundle);
  const preview=await api('/api/documents/restore/preview','POST',{bundle});assert.equal(preview.status,200);
  assert.deepEqual(storeBytes(w,id,root),before);assert.equal(preview.body.integrity,'checksum-verified');
  const payload=approved(bundle,preview.body);
  assert.equal((await api('/api/documents/restore','POST',{...payload,confirmed:false})).status,409);
  assert.deepEqual(storeBytes(w,id,root),before);
  const restored=await api('/api/documents/restore','POST',payload);assert.equal(restored.status,201);assert.notEqual(restored.body.id,id);
  const restoredId=restored.body.id,path='/api/documents/'+restoredId;
  const doc=(await api(path+'/document')).body;assert.deepEqual(doc.blocks,checked.doc.blocks);
  doc.blocks[0].content[0].text+=' 복원 후 다시 저장';
  const saved=await api(path+'/document','PUT',{documentId:restoredId,revision:doc.revision,blocks:doc.blocks});assert.equal(saved.status,200);
  assert.equal(saved.body.revision,doc.revision+1);
  const savedDoc=(await api(path+'/document')).body,savedHistory=(await api(path+'/history')).body;
  assert.equal(savedHistory.events.length,3);assert.equal(savedHistory.events[1].proposal.approval,'approved');
  await stop(server);server=await serverProcess(root);
  assert.deepEqual((await api(path+'/document')).body,savedDoc);
  assert.deepEqual((await api(path+'/history')).body,savedHistory);
  assert.deepEqual((await api('/api/documents/'+id+'/document')).body,checked.doc);
  assert.equal((await api('/api/documents')).body.documents.length,2);
  assert.equal((await api('/api/documents/restore/preview','POST',{bundle})).body.duplicate.id,restoredId);
  assert.equal((await api('/api/documents/restore','POST',approved(bundle,preview.body))).status,409);
  assert.equal(inspectBackup((await api(path+'/export')).body).preview.integrity,'checksum-verified');
});

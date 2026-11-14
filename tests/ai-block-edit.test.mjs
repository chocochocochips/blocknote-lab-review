import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace,createWorkspaceApp,verifyExport} from '../server/workspace.mjs';
import {createStorage} from '../server/storage.mjs';
import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
import {isEditableParagraph,paragraphText,paragraphDiff} from '../shared/block-edit.mjs';
import {blockHash} from '../server/block-edit.mjs';
import {normalizeHistoryResponse} from '../client/src/historyViewModel.mjs';
import {makeSubscriptionRequest} from '../scripts/siwc-provider.mjs';
const block=(id,text,type='paragraph')=>({id,type,props:{},content:[{type:'text',text,styles:{}}],children:[]});
const listen=(s,port=0)=>new Promise(r=>s.listen(port,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
async function fixture(run,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'f503-')),root=join(dir,'workspace'),source=join(dir,'source');mkdirSync(source);
 const initial={id:'synthetic-A',revision:7,updatedAt:'2026-11-01T00:00:00.000Z',blocks:[block('p1','원래 문단입니다.'),block('p2','다른 문단입니다.')]};
 writeFileSync(join(source,'document.json'),JSON.stringify(initial));writeFileSync(join(source,'history.jsonl'),'');initializeWorkspace({destination:root,source,title:'A'});
 let server=createWorkspaceApp({root}),base=await listen(server),panel;const calls=[];
 const api=async(path='',method='GET',body)=>{const r=await fetch(base+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const path=(suffix='/document',id=initial.id)=>'/api/documents/'+id+suffix;
 const doc=async id=>(await api(path('/document',id))).data;
 panel=createAiPanelServer({documentBase:base,connect:async()=>({bearer:()=> 'synthetic-secret',close:async()=>{}}),listModels:async()=>[{slug:'synthetic-model',name:'Synthetic'}],
  propose:async args=>{calls.push({mode:args.mode,targetId:args.targetId,documentId:args.document.id});return {proposal:{content:'더 명확하게 다듬은 문단입니다.',reason:'가독성을 개선했습니다.'}};},...overrides});
 const url=await listen(panel);
 const p=async(endpoint,body)=>{const r=await fetch(url+endpoint,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:5173',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
 const preview=extra=>p('/panel/preview',{mode:'patch',documentId:initial.id,baseRevision:7,model:'synthetic-model',goal:'가독성을 개선해줘',targetId:'p1',...extra});
 const approve=(proposal,extra={})=>p('/panel/approve',{proposalId:proposal.proposalId,documentId:initial.id,baseRevision:proposal.baseRevision,targetId:proposal.targetId,...extra});
 const replace=async(fn,id=initial.id)=>{const d=await doc(id);return api(path('/document',id),'PUT',{documentId:id,revision:d.revision,blocks:fn(d.blocks)});};
 try{await p('/panel/connect',{});await run({dir,root,initial,api,path,doc,p,preview,approve,replace,calls,restart:async()=>{await close(server);server=createWorkspaceApp({root});base=await listen(server);}});}
 finally{await panel.shutdown();await close(server);rmSync(dir,{recursive:true,force:true});}
}
test('edit: text-only eligibility excludes styled/link/child/heading blocks and handles empty paragraphs',()=>{
 const plain=block('p','text');assert.equal(isEditableParagraph(plain),true);assert.equal(paragraphText(plain),'text');assert.equal(isEditableParagraph({...plain,content:[]}),true);
 for(const changed of [{type:'heading'},{children:[block('child','nested')]},{content:[{type:'text',text:'bold',styles:{bold:true}}]},{content:[{type:'link',href:'x',content:[]}]},{content:[{type:'text',text:'x',styles:{},custom:'unknown'}]}])assert.equal(isEditableParagraph({...plain,...changed}),false);
});
test('edit: bounded Unicode diff reconstructs complete before/after, including insert/delete/no-change',()=>{
 for(const [before,after] of [['한글 원문 😀 끝','한글 수정 😀 끝'],['','새 문장'],['삭제',''],['same','same'],['a'.repeat(20000),'a'.repeat(19999)+'b']]){const d=paragraphDiff(before,after);assert.equal(d.prefix+d.removed+d.suffix,before);assert.equal(d.prefix+d.added+d.suffix,after);}
});
test('edit: subscription adapter sends patch and the exact selected target',()=>{const r=makeSubscriptionRequest({document:{id:'d',revision:7,blocks:[block('p','text')]},model:'synthetic-model',mode:'patch',targetId:'p',goal:'개선'});const input=JSON.parse(r.input[0].content);assert.equal(input.mode,'patch');assert.equal(input.targetId,'p');});
test('edit: preview returns authoritative original and proposal without touching document or audit',()=>fixture(async f=>{
 const before=await f.doc();const p=await f.preview();assert.equal(p.status,200);assert.equal(p.data.mode,'patch');assert.equal(p.data.originalContent,'원래 문단입니다.');assert.equal(p.data.targetId,'p1');assert.equal(p.data.documentId,'synthetic-A');assert.deepEqual(await f.doc(),before);assert.deepEqual((await f.api(f.path('/history'))).data.events,[]);assert.deepEqual(f.calls,[{mode:'patch',targetId:'p1',documentId:'synthetic-A'}]);
 assert.equal((await f.p('/panel/proposal')).data.proposal.originalContent,p.data.originalContent);
}));
test('edit: approve replaces one paragraph, preserves ID/props/other blocks and records recoverable evidence',()=>fixture(async f=>{
 const before=await f.doc(),p=(await f.preview()).data;const result=await f.approve(p);assert.equal(result.status,200);const after=await f.doc();assert.equal(after.revision,8);assert.equal(after.blocks.length,before.blocks.length);assert.equal(after.blocks[0].id,'p1');assert.deepEqual(after.blocks[0].props,before.blocks[0].props);assert.deepEqual(after.blocks[1],before.blocks[1]);assert.equal(paragraphText(after.blocks[0]),p.content);
 const history=(await f.api(f.path('/history'))).data.events;assert.equal(history.length,1);const e=history[0];assert.equal(e.operation,'block.update');assert.equal(e.blockId,'p1');assert.equal(e.proposal.approval,'approved');assert.deepEqual(e.proposal.edit,{model:'synthetic-model',documentId:'synthetic-A',blockId:'p1',baseRevision:7,beforeText:p.originalContent,afterText:p.content,beforeHash:blockHash(before.blocks[0])});assert.equal(normalizeHistoryResponse({events:history})[0].edit.approval,'approved');
 assert.deepEqual(JSON.parse(readFileSync(join(f.root,'documents','synthetic-A','document.json.bak'),'utf8')),before);
}));
test('edit: reject preserves original, revision and audit and invalidates approval',()=>fixture(async f=>{
 const before=await f.doc(),p=(await f.preview()).data;assert.equal((await f.p('/panel/reject',{proposalId:p.proposalId,documentId:'synthetic-A'})).status,200);assert.deepEqual(await f.doc(),before);assert.equal((await f.approve(p)).status,409);assert.deepEqual((await f.api(f.path('/history'))).data.events,[]);
}));
test('edit: wrong document, target block, base revision or proposal ID cannot approve',()=>fixture(async f=>{
 const p=(await f.preview()).data;for(const extra of [{documentId:'other'},{targetId:'p2'},{targetId:undefined},{baseRevision:8},{proposalId:'other'}])assert.equal((await f.approve(p,extra)).status,409);assert.equal((await f.doc()).revision,7);assert.equal((await f.approve(p)).status,200);
}));
test('edit: identical block IDs across documents never mix edits or histories',()=>fixture(async f=>{
 const b=(await f.api('/api/documents','POST',{title:'B'})).data;await f.replace(()=>[block('p1','B 내용')],b.id);const beforeB=await f.doc(b.id),p=(await f.preview()).data;assert.equal((await f.approve(p,{documentId:b.id})).status,409);assert.equal((await f.approve(p)).status,200);assert.deepEqual(await f.doc(b.id),beforeB);assert.equal((await f.api(f.path('/history',b.id))).data.events.length,1);
}));
for(const mutation of ['other-edit','target-edit','target-delete'])test('edit: '+mutation+' after proposal prevents stale approval',()=>fixture(async f=>{
 const p=(await f.preview()).data;await f.replace(blocks=>mutation==='target-delete'?blocks.slice(1):blocks.map(b=>b.id===(mutation==='other-edit'?'p2':'p1')?block(b.id,'새 본문'):b));const before=await f.doc();assert.equal((await f.approve(p)).status,409);assert.deepEqual(await f.doc(),before);assert.equal((await f.api(f.path('/history'))).data.events.length,1);
}));
test('edit: raw same-revision target replacement is caught by snapshot hash',()=>fixture(async f=>{
 const p=(await f.preview()).data,d=await f.doc();d.blocks[0].props.textAlignment='right';writeFileSync(join(f.root,'documents',d.id,'document.json'),JSON.stringify(d));assert.equal((await f.approve(p)).status,409);assert.equal((await f.doc()).revision,7);
}));
test('edit: duplicate concurrent approvals commit exactly once',()=>fixture(async f=>{const p=(await f.preview()).data;assert.deepEqual((await Promise.all([f.approve(p),f.approve(p)])).map(r=>r.status).sort(),[200,409]);assert.equal((await f.doc()).revision,8);assert.equal((await f.api(f.path('/history'))).data.events.length,1);}));
test('edit: scoped patch evidence CAS rejects hash, text, identity and payload tampering',()=>fixture(async f=>{
 const d=await f.doc(),e={model:'synthetic-model',documentId:d.id,blockId:'p1',baseRevision:7,beforeText:paragraphText(d.blocks[0]),afterText:'수정',beforeHash:blockHash(d.blocks[0])};
 const payload={documentId:d.id,revision:7,actor:'test',content:'수정',proposalId:'edit-proof',requestId:'edit-proof',goal:'수정',reason:'개선',approval:'approved'};
 for(const extra of [{beforeHash:'0'.repeat(64)},{beforeText:'위조'},{blockId:'p2'},{documentId:'other'},{baseRevision:6},{afterText:'다름'}]){const r=await f.api(f.path('/blocks/p1'),'PATCH',{...payload,edit:{...e,...extra}});assert.equal(r.status,409);}
 assert.equal((await f.doc()).revision,7);assert.equal((await f.api(f.path('/blocks/p1'),'PATCH',{...payload,edit:e})).status,200);
}));
test('edit: wrong rich target is rejected before inference; no-change proposal creates no write',()=>fixture(async f=>{
 await f.replace(blocks=>[{...blocks[0],content:[{type:'text',text:'bold',styles:{bold:true}}]},blocks[1]]);assert.equal((await f.preview({baseRevision:8})).status,422);assert.equal(f.calls.length,0);
}));
test('edit: no-change output is not an approvable proposal',()=>fixture(async f=>{assert.equal((await f.preview()).data.code,'NO_CHANGE');assert.equal((await f.p('/panel/proposal')).data.proposal,null);assert.equal((await f.doc()).revision,7);},{propose:async()=>({proposal:{content:'원래 문단입니다.',reason:'같음'}})}));
test('edit: delayed inference stays bound to original document and stale revision is refused',()=>fixture(async f=>{
 const pPromise=f.preview();await began;assert.equal((await f.p('/panel/reject',{documentId:'synthetic-A'})).status,409);await f.replace(b=>b.map(x=>x.id==='p1'?block('p1','요청 중 편집'):x));release();const p=(await pPromise).data;assert.equal(p.documentId,'synthetic-A');assert.equal(p.originalContent,'원래 문단입니다.');assert.equal((await f.approve(p)).status,409);
},{propose:async()=>{started();await gate;return {proposal:{content:'늦은 수정안',reason:'시험'}};}}));
let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);
test('edit: uncertain PATCH response is not retried and receipt/audit identify one commit',()=>fixture(async f=>{
 const p=(await f.preview()).data,r=await f.approve(p);assert.equal(r.status,503);assert.equal(r.data.code,'SAVE_UNCERTAIN');assert.equal((await f.approve(p)).status,409);assert.equal((await f.doc()).revision,8);assert.equal((await f.api(f.path('/requests/'+r.data.requestId))).data.outcome,'COMMITTED');assert.equal((await f.api(f.path('/history'))).data.events.length,1);
},{fetchImpl:async(url,options)=>{const r=await fetch(url,options);if(options.method==='PATCH')throw Error('synthetic lost response');return r;}}));
test('edit: commit gate catches target change between controller precheck and PATCH',()=>fixture(async f=>{
 const p=(await f.preview()).data;mutateFile=join(f.root,'documents','synthetic-A','document.json');assert.equal((await f.approve(p)).status,409);assert.equal((await f.doc()).revision,7);assert.equal((await f.api(f.path('/history'))).data.events.length,0);
},{fetchImpl:async(url,options)=>{if(options.method==='PATCH'){const d=JSON.parse(readFileSync(mutateFile,'utf8'));d.blocks[0].content[0].text='gate change';writeFileSync(mutateFile,JSON.stringify(d));}return fetch(url,options);}}));
let mutateFile;
test('edit: server restart preserves full edit history, backup and portable export',()=>fixture(async f=>{
 const p=(await f.preview()).data;assert.equal((await f.approve(p)).status,200);const before=await f.doc(),history=(await f.api(f.path('/history'))).data;await f.restart();assert.deepEqual(await f.doc(),before);assert.deepEqual((await f.api(f.path('/history'))).data,history);const portable=(await f.api(f.path('/export'))).data;assert.deepEqual(verifyExport(portable).events[0].proposal.edit,history.events[0].proposal.edit);
}));
test('edit: WAL recovery validates extended approval evidence without losing original backup',()=>fixture(async f=>{
 const documentFile=join(f.root,'documents','synthetic-A','document.json'),historyFile=join(f.root,'documents','synthetic-A','history.jsonl');const before=await f.doc(),after={...before,revision:8,blocks:[block('p1','복구된 수정'),before.blocks[1]]};let fault=true;
 const s=createStorage({documentFile,historyFile,strict:true,faults:stage=>{if(stage==='beforeAudit'&&fault){fault=false;throw Error('synthetic crash');}}});const proposal={proposalId:'recovery-proof',goal:'개선',reason:'시험',approval:'approved',edit:{model:'synthetic-model',documentId:before.id,blockId:'p1',baseRevision:7,beforeText:paragraphText(before.blocks[0]),afterText:paragraphText(after.blocks[0]),beforeHash:blockHash(before.blocks[0])}};
 assert.throws(()=>s.writeDocument(before,after,'test','block.update','p1',null,proposal));await f.restart();assert.deepEqual(await f.doc(),after);assert.deepEqual((await f.api(f.path('/history'))).data.events[0].proposal,proposal);assert.deepEqual(JSON.parse(readFileSync(documentFile+'.bak','utf8')),before);
}));
test('edit: Android synthetic fixture starts at revision 7 and refuses destination overwrite',async()=>{
 const {spawnSync}=await import('node:child_process');const dir=mkdtempSync(join(tmpdir(),'f503-setup-')),destination=join(dir,'trial');
 try{const script=new URL('../scripts/block-edit-fixture.mjs',import.meta.url).pathname;const run=()=>spawnSync(process.execPath,[script,destination],{encoding:'utf8'});assert.equal(run().status,0);const path=join(destination,'documents','f503-android-synthetic','document.json'),before=readFileSync(path,'utf8');const d=JSON.parse(before);assert.equal(d.revision,7);assert.equal(d.blocks.length,3);assert.equal(run().status,1);assert.equal(readFileSync(path,'utf8'),before);}finally{rmSync(dir,{recursive:true,force:true});}
});

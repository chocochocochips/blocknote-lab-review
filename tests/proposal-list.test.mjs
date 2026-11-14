import test from 'node:test';import assert from 'node:assert/strict';import {createAiRequests} from '../scripts/ai-requests.mjs';
const pause=()=>new Promise(r=>setImmediate(r));
test('proposal UX: document-scoped summaries omit proposal text and retain independent requests',async()=>{
 const store=createAiRequests({prepare:async b=>({...b,proposalId:b.requestId,scoped:true,content:'private paragraph',originalContent:'original'}),commit:async()=>({saved:true}),document:async id=>({id,revision:1,blocks:[{id:'p'}]}),canStart:()=>true});
 for(const [id,doc] of [['one','A'],['two','A'],['three','B']])store.start({requestId:id,documentId:doc,targetId:'p',baseRevision:1,model:'m',mode:'insert',goal:id});await pause();
 const a=await store.list('A');assert.equal(a.length,2);assert.equal(a.some(r=>r.documentId==='B'),false);assert.equal(a.some(r=>r.proposal),false);assert.doesNotMatch(JSON.stringify(a),/private paragraph|original/);store.cancel('one',{documentId:'A',targetId:'p',baseRevision:1});assert.equal((await store.get('two','A')).state,'review');assert.equal((await store.list('A')).find(r=>r.requestId==='one').state,'cancelled');store.invalidate(true);
});

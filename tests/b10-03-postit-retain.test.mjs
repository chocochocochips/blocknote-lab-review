import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeWorkspace,createWorkspaceApp} from '../server/workspace.mjs';
import {createAiPanelServer} from '../scripts/ai-panel-server.mjs';
import {
  readOpinionView,writeOpinionView,clearOpinionView,
  readInsertedMap,markInsertedRequest,isRequestInserted,
} from '../client/src/aiRequestState.mjs';

const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(r=>{s.close(r);s.closeAllConnections();});
const settled=async(panelCall,id,docId)=>{
  for(let i=0;i<200;i++){
    const r=await panelCall(`/panel/requests/${id}?documentId=${encodeURIComponent(docId)}`);
    if(r.data.state!=='running')return r;
    await new Promise(ok=>setTimeout(ok,10));
  }
  throw Error('request did not settle');
};

test('B10-03 Candidate A: opinion Post-it proposal survives commit, archive<->insert are independent, duplicate insert is blocked, and server data is preserved across restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'b10-03-a-'));
  let server,panel;
  try{
    const [docA]=initializeWorkspace({destination:join(root,'data'),title:'문서 A'});
    server=createWorkspaceApp({root:join(root,'data')});
    let docBase=await listen(server);
    let callCount=0;
    const makePanel=()=>createAiPanelServer({
      documentBase:docBase,
      allowedOrigins:['http://127.0.0.1:45173','http://127.0.0.1:5173'],
      connect:async()=>({bearer:()=>'synthetic-token',close:async()=>{}}),
      listModels:async()=>[{slug:'gpt-6-luna',name:'GPT-6 Luna Synthetic'}],
      propose:async({goal})=>({proposal:{content:`합성 의견 답변 #${++callCount}: ${goal}`,reason:'합성 검토 이유'}}),
    });
    panel=makePanel();
    let panelBase=await listen(panel);

    const api=async(path,method='GET',body,origin='http://127.0.0.1:5173')=>{
      const r=await fetch(docBase+path,{method,headers:{Origin:origin,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:r.status,data:await r.json()};
    };
    const p=async(path,body)=>{
      const r=await fetch(panelBase+path,{method:body===undefined?'GET':'POST',headers:{Origin:'http://127.0.0.1:5173',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:r.status,data:await r.json()};
    };

    await p('/panel/connect',{});
    const docBefore=(await api(`/api/documents/${docA.id}/document`)).data;

    // 1. Generate Opinion 1 -> Insert -> Archive (삽입 -> 보관 & 우측 유지 & 중복 삽입 차단)
    const start1=await p('/panel/requests',{
      requestId:'ai:b1003-one',
      documentId:docA.id,
      targetId:docBefore.blocks.at(-1).id,
      baseRevision:docBefore.revision,
      mode:'insert',
      model:'gpt-6-luna',
      goal:'첫 번째 질문: 삽입 후 보관 검증',
    });
    assert.equal(start1.status,202);
    const rev1=(await settled(p,'ai:b1003-one',docA.id)).data;
    assert.equal(rev1.state,'review');
    assert.equal(rev1.proposal.mode,'insert');
    assert.ok(rev1.proposal.postitId,'draft postitId must be created on server');

    // Approve (문서에 삽입)
    const app1=await p('/panel/requests/ai:b1003-one/approve',{
      documentId:docA.id,
      targetId:rev1.targetId,
      baseRevision:rev1.baseRevision,
      proposalId:rev1.proposal.proposalId,
    });
    assert.equal(app1.status,200);
    assert.equal(app1.data.state,'committed');
    // Crucial for Candidate A: committed snapshot STILL retains proposal so UI card does not unmount on refreshJob
    assert.ok(app1.data.proposal,'committed opinion snapshot must retain proposal');
    assert.equal(app1.data.proposal.content,rev1.proposal.content);
    assert.equal(app1.data.proposal.postitId,rev1.proposal.postitId);

    // Re-fetching request after commit (simulating reload / re-selection) still includes proposal + committed state
    const reget1=(await p(`/panel/requests/ai:b1003-one?documentId=${encodeURIComponent(docA.id)}`)).data;
    assert.equal(reget1.state,'committed');
    assert.equal(reget1.proposal?.proposalId,rev1.proposal.proposalId);

    // Duplicate approve is strictly blocked with 409
    const dup1=await p('/panel/requests/ai:b1003-one/approve',{
      documentId:docA.id,
      targetId:rev1.targetId,
      baseRevision:rev1.baseRevision,
      proposalId:rev1.proposal.proposalId,
    });
    assert.equal(dup1.status,409);

    // Document API receipt endpoint confirms COMMITTED (survives reloads & restarts)
    const receipt1=await api(`/api/documents/${docA.id}/requests/ai:b1003-one`);
    assert.equal(receipt1.status,200);
    assert.equal(receipt1.data.outcome,'COMMITTED');
    assert.equal(receipt1.data.revision,docBefore.revision+1);

    // Server Post-it data was NOT deleted by document insertion, and archiving after insertion succeeds (삽입 -> 보관)
    const postitBeforeArchive=await api(`/api/postits/${rev1.proposal.postitId}`);
    assert.equal(postitBeforeArchive.status,200);
    assert.equal(postitBeforeArchive.data.postit.archived,false);
    assert.equal(postitBeforeArchive.data.postit.rawContent,rev1.proposal.content);

    const arch1=await api(`/api/postits/${rev1.proposal.postitId}/archive`,'POST',{});
    assert.equal(arch1.status,200);
    assert.equal(arch1.data.postit.archived,true);
    assert.equal(arch1.data.postit.rawContent,rev1.proposal.content);

    // 2. Generate Opinion 2 -> Archive -> Insert (보관 -> 삽입 독립 동작)
    const docAfter1=(await api(`/api/documents/${docA.id}/document`)).data;
    assert.equal(docAfter1.revision,docBefore.revision+1);

    const start2=await p('/panel/requests',{
      requestId:'ai:b1003-two',
      documentId:docA.id,
      targetId:docAfter1.blocks.at(-1).id,
      baseRevision:docAfter1.revision,
      mode:'insert',
      model:'gpt-6-luna',
      goal:'두 번째 질문: 보관 후 삽입 검증',
    });
    assert.equal(start2.status,202);
    const rev2=(await settled(p,'ai:b1003-two',docA.id)).data;
    assert.equal(rev2.state,'review');

    // Archive first (보관)
    const arch2=await api(`/api/postits/${rev2.proposal.postitId}/archive`,'POST',{});
    assert.equal(arch2.status,200);
    assert.equal(arch2.data.postit.archived,true);
    // Archiving must NOT change document revision
    assert.equal((await api(`/api/documents/${docA.id}/document`)).data.revision,docAfter1.revision);

    // Then Insert into document (보관 -> 삽입)
    const app2=await p('/panel/requests/ai:b1003-two/approve',{
      documentId:docA.id,
      targetId:rev2.targetId,
      baseRevision:rev2.baseRevision,
      proposalId:rev2.proposal.proposalId,
    });
    assert.equal(app2.status,200);
    assert.equal(app2.data.state,'committed');
    assert.ok(app2.data.proposal);
    const docAfter2=(await api(`/api/documents/${docA.id}/document`)).data;
    assert.equal(docAfter2.revision,docAfter1.revision+1);

    // 3. Restart Document API server and verify both Post-its and receipts survive
    await close(server);
    server=createWorkspaceApp({root:join(root,'data')});
    docBase=await listen(server);

    const archivedList=(await api('/api/postits?status=archived')).data.postits;
    assert.equal(archivedList.length,2);
    assert.equal((await api(`/api/documents/${docA.id}/requests/ai:b1003-one`)).data.outcome,'COMMITTED');
    assert.equal((await api(`/api/documents/${docA.id}/requests/ai:b1003-two`)).data.outcome,'COMMITTED');
  }finally{
    if(panel)await panel.shutdown();
    if(server)await close(server);
    rmSync(root,{recursive:true,force:true});
  }
});

test('B10-03 Candidate A: document-scoped opinion view and inserted tracking never leak across documents',()=>{
  clearOpinionView('doc-1');
  clearOpinionView('doc-2');
  const card1={requestId:'ai:1',proposalId:'siwc-1',documentId:'doc-1',baseRevision:1,targetId:'p1',model:'gpt-6-luna',goal:'질문 1',content:'답변 1',reason:'이유 1'};
  writeOpinionView('doc-1',card1);
  assert.deepEqual(readOpinionView('doc-1'),card1);
  assert.equal(readOpinionView('doc-2'),null);

  // Attempting to write card1 under doc-2 is rejected because card1.documentId !== 'doc-2'
  writeOpinionView('doc-2',card1);
  assert.equal(readOpinionView('doc-2'),null);

  markInsertedRequest('doc-1',{requestId:'ai:1',proposalId:'siwc-1',revision:2,receipt:'COMMITTED'});
  assert.equal(isRequestInserted('doc-1','ai:1','siwc-1'),true);
  assert.equal(isRequestInserted('doc-2','ai:1','siwc-1'),false);
  assert.equal(readInsertedMap('doc-1')['ai:1'].revision,2);

  // Verify AiPanel source contract for Candidate A
  const aiSrc=readFileSync(new URL('../client/src/AiPanel.jsx',import.meta.url),'utf8');
  assert.match(aiSrc,/isCurrentInserted\?'삽입 완료':'문서에 삽입'/);
  assert.match(aiSrc,/disabled=\{working\|\|running\|\|Boolean\(proposal\)\}/);
  assert.match(aiSrc,/selectionGuard\.current=\(\)=>!/);
});

import React,{useEffect,useRef,useState} from 'react';
import ParagraphComparison from './ParagraphComparison.jsx';
import {requestLabel} from './aiRequestState.mjs';
const key=id=>'blocknote.ai.group.v1:'+id;
export default function BatchPanel({api,documentId,getRevision,getParagraphs,selectedBlockIds=[],model,goal,legacy,canAct,onCommitted,guard,onBusy}){
 const [selected,setSelected]=useState([]),[group,setGroup]=useState(null),[approved,setApproved]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),op=useRef(false),epoch=useRef(0),pointer=useRef(null),current=useRef(null);
 if(pointer.current===null){try{const p=JSON.parse(sessionStorage.getItem(key(documentId)));if(p?.documentId===documentId)pointer.current=p;}catch{}}
 guard.current=()=>!op.current&&current.current?.state!=='approving';
 function remember(p){pointer.current=p;try{sessionStorage.setItem(key(documentId),JSON.stringify(p));}catch{}}
 function assign(g){if(alive.current){current.current=g;setGroup(g);}}
 async function refresh(){const p=pointer.current,serial=epoch.current;if(!p)return;if(p.cancelled){assign({...p,state:'cancelled'});return;}
  try{const g=await api('/panel/groups/'+p.groupId+'?documentId='+encodeURIComponent(documentId));if(!alive.current||serial!==epoch.current||g.groupId!==pointer.current?.groupId||g.documentId!==documentId)return;if(p.approvalAttempted&&!['committed','conflict','failed','uncertain'].includes(g.state))g.state='uncertain';assign(g);}
  catch(e){if(alive.current&&serial===epoch.current)assign({...p,state:e.status===404?'expired':'failed'});}
 }
 useEffect(()=>{
  const editableIds=new Set(getParagraphs().map(p=>p.id));
  const fromSelection=selectedBlockIds.filter(id=>editableIds.has(id)).slice(0,5);
  if(fromSelection.length>=2){setSelected(fromSelection);}
 },[selectedBlockIds.join(',')]);
 useEffect(()=>{alive.current=true;void refresh();const t=setInterval(()=>{if(!op.current&&!document.hidden)void refresh();},700);return()=>{alive.current=false;epoch.current++;clearInterval(t);};},[]);
 async function run(fn){if(op.current)return;op.current=true;epoch.current++;setBusy(true);onBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(e.message);}finally{op.current=false;onBusy(false);if(alive.current)setBusy(false);}}
 const start=()=>{if(!canAct())return;return run(async()=>{
  const p={groupId:'group:'+crypto.randomUUID(),documentId,baseRevision:getRevision()};remember(p);
  setApproved(null);assign(await api('/panel/groups','POST',{...p,targetIds:selected,model,goal,legacy:Boolean(legacy)}));
 });};
 const cancel=()=>run(async()=>{const p=pointer.current;try{const g=await api('/panel/groups/'+p.groupId+'/cancel','POST',{documentId,baseRevision:p.baseRevision});remember({...p,cancelled:true});assign(g);}catch(e){if(e.status===409){await refresh();throw e;}remember({...p,cancelled:true});assign({...p,state:'cancelled'});}});
 const approve=()=>{if(!canAct()||current.current?.state!=='review')return;return run(async()=>{
  const p=pointer.current;remember({...p,approvalAttempted:true});assign({...current.current,state:'approving'});
  try{const g=await api('/panel/groups/'+p.groupId+'/approve','POST',{documentId,baseRevision:p.baseRevision,targetIds:approved??current.current.requests.map(r=>r.targetId)});assign(g);onCommitted();}
  catch(e){assign({...p,state:e.status===409?'conflict':'uncertain'});throw e;}
 });};
 const active=['running','review','approving','uncertain'].includes(group?.state);
 const paragraphs=getParagraphs();
 const approvedCount=group?.state==='review'?(approved===null?group.requests.length:approved.length):0;
 return <section className="batch-panel" aria-label="여러 문단 수정">
  <h3>여러 문단 수정 · 부분 승인</h3><p>서식 없는 일반 문단 2~5개를 골라 각각 원문과 수정안을 비교한 뒤 원하는 문단만 부분 승인할 수 있습니다.</p>
  {!active&&<><div className="batch-targets">{paragraphs.map(p=><label key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/>{p.text||'(빈 문단)'}</label>)}</div>
  <button type="button" id="proposeEdit" disabled={busy||!canAct()||!model||selected.length<2||selected.length>5} onClick={start}>여러 문단 수정 요청 ({selected.length}개 선택)</button></>}
  {group&&<strong role="status">{requestLabel(group.state)}</strong>}
  {group?.state==='review'&&<div id="editProposalCard" className="b05-proposal-card"><p className="batch-choice-note" id="b05ApprovedCount">승인할 문단: {group.requests.length}개 중 {approvedCount}개 선택. 선택하지 않은 수정안은 이번 승인과 함께 종료되며 원문이 유지됩니다.</p><div id="b05ProposalList" className="batch-comparisons">{group.requests.map((r,i)=><article key={r.requestId} className="b05-diff"><h4><label className="b05-diff-check"><input type="checkbox" checked={approved===null||approved.includes(r.targetId)} onChange={e=>setApproved(old=>{const ids=old??group.requests.map(x=>x.targetId);return e.target.checked?[...ids,r.targetId]:ids.filter(id=>id!==r.targetId);})}/> 문단 {i+1} · 제안 적용</label></h4><ParagraphComparison before={r.proposal.originalContent} after={r.proposal.content}/></article>)}</div><div className="b05-approve-actions"><button type="button" className="ai-panel-secondary" id="cancelEdit" disabled={busy} onClick={cancel}>모두 취소</button><button type="button" id="applyEdit" disabled={busy||!canAct()||approved?.length===0} onClick={approve}>선택한 문단 승인 후 저장</button></div></div>}
  {group?.state==='running'&&<button type="button" disabled={busy} onClick={cancel}>여러 문단 요청 취소</button>}
  {group?.state==='committed'&&<p className="batch-success">여러 문단 저장 확인 · 변경 {group.result.revision}<br/>승인하지 않은 {group.result.skippedCount}개 수정안은 종료했습니다. 다시 수정하려면 새로 요청하세요.</p>}
  {group?.state==='conflict'&&<p role="alert">원문 또는 문서 버전이 변경되어 오래된 수정안 적용을 차단했습니다. 최신 문서를 확인하고 다시 요청하세요.</p>}
  {group?.state==='uncertain'&&<p>저장 결과가 불확실합니다. 자동 재시도하지 않았습니다. 문서와 변경 이력을 확인하세요.</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}

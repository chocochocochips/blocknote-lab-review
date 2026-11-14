import SkinPicker from './SkinPicker.jsx';
import {SKINS,readPreference,writePreference} from './appearance.mjs';
import BatchPanel from './BatchPanel.jsx';
import ParagraphComparison from './ParagraphComparison.jsx';
import SiteAiOpinion from './SiteAiOpinion.jsx';
import React,{useEffect,useRef,useState} from 'react';
import {
  readPointer,writePointer,clearPointer,requestLabel,matchesRequest,
  readOpinionView,writeOpinionView,readInsertedMap,markInsertedRequest,
} from './aiRequestState.mjs';
import {isLocalLoginPage} from '../../shared/local-login-page.mjs';
import {connectionPending,connectionLabel,chooseAccountModel,formatConnectionChip,PREFERRED_TEST_MODEL} from './aiConnectionState.mjs';
import {formatPostitTime,shortModelName} from '../../shared/postit-contract.mjs';
const SITE=import.meta.env.VITE_LAB_SITE==='1';
const CLOUD=SITE||import.meta.env.VITE_LAB_CLOUD_TEST==='1';
const PANEL_URL=CLOUD?'':'http://127.0.0.1:'+(import.meta.env.VITE_LAB_B10_03_ISOLATED==='1'?'48788':import.meta.env.VITE_LAB_B09_FOLLOWUP==='1'?'38788':import.meta.env.VITE_LAB_B09_ISOLATED==='1'?'28788':import.meta.env.VITE_LAB_B06_ISOLATED==='1'?'18788':'8788');
async function api(path,method='GET',body) {
  const res=await fetch(PANEL_URL+path,{method,headers:body===undefined?undefined:{'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(path==='/panel/models'?35000:20000)});
  const result=await res.json();
  if(!res.ok){const error=new Error(result.error||'AI 요청 실패');error.code=result.code;error.status=res.status;error.requestId=result.requestId;throw error;}
  return result;
}
export default function AiPanel({
  getTarget,canAct,onCommitted,documentId,documentTitle,getRevision,guard,legacy,
  selectedTarget,selectedBlockIds=[],questionScope,reaskContext,onClearReask,archivedPostitView,
  postits=[],onEnsureDraftPostit,onArchivePostit,
  reviewContext,selectionGuard,getEditableParagraphs,onClose,
}) {
  const [connected,setConnected]=useState(false),[available,setAvailable]=useState(false);
  const [connection,setConnection]=useState({phase:'idle'}),[connectionNotice,setConnectionNotice]=useState('');
  const [modelIssue,setModelIssue]=useState('');
  const [chipMenuOpen,setChipMenuOpen]=useState(false);
  const connectionRef=useRef(connection),connectedRef=useRef(false),statusSerial=useRef(0);
  const modelsFor=useRef(null),modelsLoading=useRef(false),modelsSerial=useRef(0);
  const connecting=!CLOUD&&connectionPending(connection);
  const [models,setModels]=useState([]),[model,setModel]=useState(''),[mode,setMode]=useState('insert');
  const [workspaceMode,setWorkspaceMode]=useState('opinion');
  const [siteProvider,setSiteProvider]=useState('');
  const [siteAiBusy,setSiteAiBusy]=useState(false);
  const externalOpinion=SITE&&workspaceMode==='opinion'&&Boolean(siteProvider);
  const [skin,setSkin]=useState(()=>{const s=readPreference('blocknote.p2.skin','desk');return SKINS.some(([id])=>id===s)?s:'desk';});
  const changeSkin=id=>{setSkin(id);writePreference('blocknote.p2.skin',id);};
  const [goal,setGoal]=useState('이 내용을 검토해줘');
  const [requests,setRequests]=useState([]),[batchBusy,setBatchBusy]=useState(false);
  const batchGuard=useRef(()=>true);
  const [job,setJob]=useState(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [opinionCard,setOpinionCard]=useState(()=>readOpinionView(documentId));
  const [insertedMap,setInsertedMap]=useState(()=>readInsertedMap(documentId));
  const [activePostitId,setActivePostitId]=useState(null);
  const [postitSaveState,setPostitSaveState]=useState('');
  const autoSavedReqRef=useRef(new Set());
  const opinionCardRef=useRef(opinionCard);
  opinionCardRef.current=opinionCard;
  const alive=useRef(true),epoch=useRef(0),pointer=useRef(readPointer(documentId));
  const operationInFlight=useRef(false),statusLoading=useRef(false),jobRef=useRef(null);
  const localBrowser=CLOUD||['127.0.0.1','localhost'].includes(window.location.hostname);
  // Separate blocking paragraph-edit review (proposal) from the persistent opinion Post-it card (currentOpinion).
  const proposal=job?.state==='review'&&job.proposal?.mode==='patch'?job.proposal:null;
  const currentOpinion=opinionCard?.documentId===documentId?opinionCard:null;
  const copyAnswer=async(textToCopy)=>{try{await navigator.clipboard.writeText(textToCopy??currentOpinion?.content??proposal?.content??'');setError('');}catch{setError('복사하지 못했어요. 답변을 선택해 직접 복사할 수 있습니다.');}};
  const running=job?.state==='running',working=Boolean(busy)||batchBusy||siteAiBusy||job?.state==='approving';
  guard.current=()=>!siteAiBusy&&!operationInFlight.current&&jobRef.current?.state!=='approving'&&batchGuard.current();
  selectionGuard.current=()=>!siteAiBusy&&!operationInFlight.current&&!batchBusy&&batchGuard.current()&&!['running','approving','uncertain'].includes(jobRef.current?.state)&&!(jobRef.current?.state==='review'&&jobRef.current?.proposal?.mode==='patch');
  function updateOpinionCard(nextCard){
    if(!nextCard||nextCard.documentId!==documentId)return;
    opinionCardRef.current=nextCard;
    writeOpinionView(documentId,nextCard);
    setOpinionCard(nextCard);
  }
  function assign(next){
    if(!alive.current)return;
    jobRef.current=next;
    setJob(next);
    if(next?.proposal?.mode==='patch'){setMode('patch');setWorkspaceMode('edit');}
    if(next?.proposal&&next.proposal.mode!=='patch'&&(next.documentId||next.proposal.documentId)===documentId){
      updateOpinionCard({
        requestId:next.requestId,
        proposalId:next.proposal.proposalId,
        documentId,
        baseRevision:next.proposal.baseRevision??next.baseRevision,
        targetId:next.proposal.targetId??next.targetId,
        model:next.proposal.model||next.model||model,
        goal:next.goal||goal,
        content:next.proposal.content,
        reason:next.proposal.reason,
        ...(next.proposal.postitId?{postitId:next.proposal.postitId}:{}),
        ...(next.proposal.postitSave?{postitSave:next.proposal.postitSave}:{}),
        ...(next.proposal.postitDraft?{postitDraft:next.proposal.postitDraft}:{}),
      });
    }
    if(next?.state==='committed'&&next?.requestId){
      const pid=next.proposal?.proposalId||(opinionCardRef.current?.requestId===next.requestId?opinionCardRef.current?.proposalId:null);
      const updated=markInsertedRequest(documentId,{
        requestId:next.requestId,
        proposalId:pid,
        revision:next.result?.revision??null,
        receipt:next.result?.receipt??'COMMITTED',
      });
      setInsertedMap(updated);
    }
  }
  function remember(p){pointer.current=p;writePointer(p);}
  function target(p=pointer.current){return {documentId,targetId:p.targetId,baseRevision:p.baseRevision};}
  async function refreshJob(){
    const p=pointer.current,serial=epoch.current;
    if(!p)return null;
    if(p.cancelled){const next={...p,state:'cancelled'};assign(next);return next;}
    try{
      const next=await api('/panel/requests/'+p.requestId+'?documentId='+encodeURIComponent(documentId));
      if(!alive.current||serial!==epoch.current||pointer.current?.requestId!==p.requestId)return null;
      if(!matchesRequest(next,p))throw Error('AI 요청 대상이 다릅니다.');
      if(p.approvalAttempted&&!['committed','conflict','failed','expired','uncertain'].includes(next.state))next.state='uncertain';
      assign(next);return next;
    }catch(e){
      if(!alive.current||serial!==epoch.current)return null;
      if(e.status===404&&p.accepted&&opinionCardRef.current?.requestId===p.requestId){
        const ins=readInsertedMap(documentId)[p.requestId];
        if(ins){
          const next={...p,state:'committed',proposal:opinionCardRef.current,result:{saved:true,revision:ins.revision,receipt:ins.receipt||'COMMITTED'}};
          assign(next);return next;
        }
        pointer.current=null;clearPointer(documentId);assign(null);return null;
      }
      const next={...p,state:e.status===404&&p.accepted?'expired':'failed',localUnknown:!p.accepted||e.status!==404,code:!p.accepted&&e.status===404?'START_NOT_CONFIRMED':e.status===404?'REQUEST_EXPIRED':'STATUS_UNAVAILABLE'};assign(next);return next;
    }
  }
  async function refreshList(){try{const r=await api('/panel/requests?documentId='+encodeURIComponent(documentId));if(alive.current)setRequests(r.requests.filter(r=>!r.groupId));}catch{}}
  function newDraft(){if(operationInFlight.current)return;epoch.current++;pointer.current=null;clearPointer(documentId);assign(null);setError('');}
  const choose=r=>run('요청 확인 중',async()=>{
    setActivePostitId(null);setPostitSaveState('');
    remember({requestId:r.requestId,documentId,targetId:r.targetId,baseRevision:r.baseRevision});
    const next=await refreshJob();
    if(alive.current&&!next?.proposal){
      const savedNote=postits.find(n=>n.documentId===documentId&&n.requestId===r.requestId);
      if(savedNote){
        setWorkspaceMode('opinion');setMode('insert');
        updateOpinionCard({
          requestId:savedNote.requestId,
          proposalId:savedNote.proposalId||savedNote.id,
          documentId,
          baseRevision:savedNote.baseRevision||r.baseRevision,
          targetId:r.targetId,
          model:savedNote.model||r.model||model,
          goal:savedNote.prompt||r.goal||goal,
          content:savedNote.rawContent,
          reason:'임시 저장된 포스트잇 원문',
          postitId:savedNote.id,
          postitSave:'saved',
        });
      }
    }
  });
  function observeStatus(s){
    connectedRef.current=Boolean(s.connected);setConnected(Boolean(s.connected));
    const next=s.connection??{phase:s.connected?'connected':'idle'};connectionRef.current=next;setConnection(next);
    if(!s.connected){modelsSerial.current++;modelsFor.current=null;setModels([]);setModel('');setModelIssue('');}
  }
  async function loadModels(key,refresh=false){
    if(modelsLoading.current||(!refresh&&modelsFor.current===key))return;
    modelsLoading.current=true;modelsFor.current=key;const serial=++modelsSerial.current;
    try{
      const c=await api('/panel/models');
      if(!alive.current||serial!==modelsSerial.current||!connectedRef.current)return;
      setModels(c.models);setModel(old=>chooseAccountModel(c.models,old,{cloud:CLOUD}));
      setModelIssue(!CLOUD&&!c.models.some(m=>m.slug===PREFERRED_TEST_MODEL)?'gpt-6-luna가 이 계정의 모델 목록에 없어요. 다른 모델을 자동 선택하지 않았습니다.':c.models.length?'':'사용 가능한 모델이 없어요.');
    }catch{
      if(alive.current&&serial===modelsSerial.current){setModels([]);setModel('');setModelIssue('모델 목록을 확인하지 못했어요. 상태 확인을 눌러 다시 조회하세요.');}
    }finally{modelsLoading.current=false;}
  }
  async function loadStatus({refreshModels=false}={}){
    if(!localBrowser||statusLoading.current)return;
    statusLoading.current=true;const serial=epoch.current,statusToken=++statusSerial.current;
    try{
      const s=await api('/panel/status');if(!alive.current||statusToken!==statusSerial.current)return;
      setAvailable(true);setConnectionNotice('');observeStatus(s);
      if(s.connected&&!s.busy)void loadModels(s.connection?.attemptId??'cloud',refreshModels);
      if(serial===epoch.current){await refreshJob();await refreshList();}
    }catch{if(alive.current&&statusToken===statusSerial.current){setAvailable(false);setConnectionNotice('연결 상태를 확인하지 못했어요. 인증 실패로 단정하지 않고 다시 확인합니다.');await refreshJob();}}
    finally{statusLoading.current=false;}
  }
  useEffect(()=>{alive.current=true;void loadStatus();const timer=setInterval(()=>{if(!document.hidden&&!operationInFlight.current){void refreshJob();void refreshList();}},700);
    const statusTimer=setInterval(()=>{if(!CLOUD&&!document.hidden&&!operationInFlight.current)void loadStatus();},1500);
    const focus=()=>void loadStatus();window.addEventListener('focus',focus);
    return()=>{alive.current=false;epoch.current++;modelsSerial.current++;clearInterval(timer);clearInterval(statusTimer);window.removeEventListener('focus',focus);};},[]);
  useEffect(()=>{if(selectedTarget?.explicitEdit){setWorkspaceMode('edit');setMode('patch');setGoal('의미를 유지하면서 더 읽기 쉽게 다듬어줘.');}},[selectedTarget?.serial]);
  useEffect(()=>{
    if(workspaceMode==='edit'&&selectedBlockIds.length>=2&&!proposal&&!running){
      setMode('batch');
    }
  },[workspaceMode,selectedBlockIds.length]);
  useEffect(()=>{
    if(!reviewContext)return;
    setWorkspaceMode('opinion');setMode('insert');
    setGoal('이 내용을 검토해줘');
  },[reviewContext?.serial]);
  useEffect(()=>{
    if(!reaskContext)return;
    setWorkspaceMode('opinion');setMode('insert');
    if(reaskContext.defaultPrompt)setGoal(reaskContext.defaultPrompt);
  },[reaskContext?.reaskedFromId]);

  // Verify against the Document API receipt endpoint so reloads, request re-selection,
  // or server restarts always know whether the active opinion was already committed.
  useEffect(()=>{
    const reqId=currentOpinion?.requestId,propId=currentOpinion?.proposalId;
    if(!reqId||insertedMap[reqId]||(propId&&insertedMap[propId]))return;
    let cancelled=false;
    const receiptPath=(legacy?'/api/requests/':'/api/documents/'+encodeURIComponent(documentId)+'/requests/')+encodeURIComponent(reqId);
    fetch(receiptPath,{cache:'no-store'}).then(async r=>{
      if(!r.ok||cancelled||!alive.current)return;
      const data=await r.json();
      if(!cancelled&&alive.current&&data?.outcome==='COMMITTED'){
        const updated=markInsertedRequest(documentId,{requestId:reqId,proposalId:propId,revision:data.revision??null,receipt:'COMMITTED'});
        setInsertedMap(updated);
      }
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[currentOpinion?.requestId,currentOpinion?.proposalId,documentId,legacy]);

  // The answer belongs to the current request. A failed/uncertain write keeps
  // its original text visible and retries only with the same request ID.
  async function saveCurrentPostit(currentJob,currentProposal){
    const requestId=currentJob?.requestId, proposalId=currentProposal?.proposalId;
    if(!requestId||!proposalId||!onEnsureDraftPostit||autoSavedReqRef.current.has(requestId))return;
    autoSavedReqRef.current.add(requestId);
    setPostitSaveState('임시 저장 확인 중…');
    try{
      const original=currentProposal.postitDraft??{requestId,proposalId,documentId:currentProposal.documentId||documentId,
        baseRevision:currentProposal.baseRevision||getRevision(),targetIds:questionScope?.targetIds||[],
        scopeText:questionScope?.reaskedFromId?(reaskContext?.confirmedContent||''):(questionScope?.scopeText||''),
        reaskedFromId:questionScope?.reaskedFromId||null,model:currentProposal.model||model,
        prompt:currentJob.goal||goal,rawContent:currentProposal.content};
      const saved=await onEnsureDraftPostit({...original,documentTitle:documentTitle||'내 작업실 문서',
        ...(currentProposal.postitSave==='saved'&&currentProposal.postitId?{existingPostitId:currentProposal.postitId}:{})});
      if(!saved?.id||saved.requestId!==requestId||saved.proposalId!==proposalId)throw Error('저장 결과를 확인할 수 없습니다.');
      if(alive.current&&opinionCardRef.current?.requestId===requestId&&opinionCardRef.current?.proposalId===proposalId){
        setActivePostitId(saved.id);setPostitSaveState(saved.archived?'보관됨 · 왼쪽 포스트잇 아이콘에서 확인':'임시 저장됨 · 보관 가능');
        if(reaskContext)onClearReask?.();
      }
    }catch{
      autoSavedReqRef.current.delete(requestId);
      if(alive.current&&opinionCardRef.current?.requestId===requestId&&opinionCardRef.current?.proposalId===proposalId)
        setPostitSaveState('임시 저장 실패 또는 결과 불확실 · 서버 종료 전에 원문을 복사하거나 다시 확인하세요.');
    }
  }
  useEffect(()=>{
    if(!currentOpinion||!currentOpinion.requestId||!currentOpinion.proposalId)return;
    const saved=postits.find(note=>note.documentId===documentId&&note.requestId===currentOpinion.requestId&&note.proposalId===currentOpinion.proposalId&&note.rawContent===currentOpinion.content);
    if(saved){
      setActivePostitId(saved.id);
      setPostitSaveState(saved.archived?'보관됨 · 왼쪽 포스트잇 아이콘에서 확인':'임시 저장됨 · 보관 가능');
      return;
    }
    if(currentOpinion.postitSave==='failed'){
      setPostitSaveState('임시 저장 실패 또는 결과 불확실 · 서버 종료 전에 원문을 복사하거나 다시 확인하세요.');
      return;
    }
    void saveCurrentPostit({requestId:currentOpinion.requestId,goal:currentOpinion.goal},currentOpinion);
  },[currentOpinion?.proposalId,currentOpinion?.requestId,postits,documentId]);

  async function run(label,fn){
    if(operationInFlight.current)return;operationInFlight.current=true;epoch.current++;setBusy(label);setError('');
    try{await fn();}catch(e){if(alive.current)setError(e.message);}finally{operationInFlight.current=false;if(alive.current)setBusy('');}
  }
  const editSafe=()=>{if(!canAct()){setError('먼저 입력·저장·문서 전환을 마치세요.');return false;}return true;};
  const connect=()=>run('연결 시작',async()=>{
    statusSerial.current++;setConnectionNotice('');
    if(!CLOUD){const next={phase:'starting'};connectionRef.current=next;setConnection(next);}
    try{const s=await api('/panel/connect','POST',CLOUD?{}:{background:true});if(alive.current)observeStatus(s);}
    catch{if(alive.current)setConnectionNotice('연결 시작 응답을 확인하지 못했어요. 중복 실행하지 말고 상태를 확인하세요.');}
    await loadStatus();
  });
  const cancelConnection=()=>run('연결 취소 중',async()=>{
    statusSerial.current++;
    try{const s=await api('/panel/connect/cancel','POST',{attemptId:connectionRef.current.attemptId});if(alive.current)observeStatus(s);}
    finally{await loadStatus();}
  });
  const preview=()=>{if(!editSafe())return;return run('요청 중',async()=>{
    if(pointer.current&&!pointer.current.cancelled){
      const current=await refreshJob();
      if(current?.localUnknown||['running','approving','uncertain'].includes(current?.state)||(current?.state==='review'&&current?.proposal?.mode==='patch')){
        setError('기존 요청을 확인하거나 취소한 뒤 새로 요청하세요.');return;
      }
    }
    if(!alive.current||!editSafe())return;
    const targetId=getTarget(mode);if(!targetId)throw Error('편집기에서 수정할 문단을 선택하세요.');
    setActivePostitId(null);setPostitSaveState('');
    const p={requestId:'ai:'+crypto.randomUUID(),documentId,targetId,baseRevision:getRevision()};remember(p);
    const scopeExtra=mode==='insert'&&questionScope?{
      targetIds:questionScope.targetIds,
      reaskedFromId:questionScope.reaskedFromId,
      reaskedItemRevision:questionScope.reaskedItemRevision,
    }:{};
    try{const next=await api('/panel/requests','POST',{...p,model,goal,mode,legacy:Boolean(legacy),...scopeExtra});if(alive.current&&matchesRequest(next,p)){remember({...p,accepted:true});assign(next);}}
    catch(e){if(e.status>=400&&e.status<500){pointer.current=null;clearPointer(documentId);assign(null);}else assign({...p,state:'failed',localUnknown:true,code:'START_UNCERTAIN'});throw e;}
  });};
  const cancel=()=>run('취소 중',async()=>{
    const p=pointer.current;if(!p)return;
    try{const next=await api('/panel/requests/'+p.requestId+'/cancel','POST',target(p));remember({...p,cancelled:true});assign(next.state==='committed'?next:{...next,state:'cancelled'});}
    catch(e){if(e.status===409){await refreshJob();throw e;}remember({...p,cancelled:true});assign({...p,state:'cancelled'});}
  });
  const reject=cancel;
  const approve=()=>{
    if(!editSafe())return;
    if(workspaceMode==='opinion'&&currentOpinion){
      if(insertedMap[currentOpinion.requestId]||(currentOpinion.proposalId&&insertedMap[currentOpinion.proposalId]))return;
      if(jobRef.current?.requestId===currentOpinion.requestId&&jobRef.current?.state!=='review')return;
      return run('승인 저장 중',async()=>{
        const reqId=currentOpinion.requestId,propId=currentOpinion.proposalId;
        const p={requestId:reqId,documentId,targetId:currentOpinion.targetId,baseRevision:currentOpinion.baseRevision,accepted:true,approvalAttempted:true};
        remember(p);
        if(jobRef.current?.requestId===reqId)assign({...jobRef.current,state:'approving'});
        try{
          const next=await api('/panel/requests/'+reqId+'/approve','POST',{...target(p),proposalId:propId});
          if(alive.current&&matchesRequest(next,p)){
            const updated=markInsertedRequest(documentId,{requestId:reqId,proposalId:propId,revision:next.result?.revision??null,receipt:next.result?.receipt??'COMMITTED'});
            setInsertedMap(updated);
            await onCommitted?.();
            assign(next);
          }
        }catch(e){
          if(e.status===409){
            try{
              const receiptPath=(legacy?'/api/requests/':'/api/documents/'+encodeURIComponent(documentId)+'/requests/')+encodeURIComponent(reqId);
              const checkRes=await fetch(receiptPath,{cache:'no-store'});
              if(checkRes.ok){
                const receiptData=await checkRes.json();
                if(receiptData?.outcome==='COMMITTED'){
                  const updated=markInsertedRequest(documentId,{requestId:reqId,proposalId:propId,revision:receiptData.revision??null,receipt:'COMMITTED'});
                  setInsertedMap(updated);
                  await onCommitted?.();
                  assign({...p,state:'committed',proposal:currentOpinion,result:{saved:true,revision:receiptData.revision,receipt:'COMMITTED',auditRecords:1}});
                  return;
                }
              }
            }catch{}
          }
          assign({...(jobRef.current||p),state:e.status===409?'conflict':'uncertain',proposal:undefined});
          throw Error(e.status===409?'문서가 변경되어 다시 요청 필요':'저장 결과가 불확실합니다. 자동 재시도하지 않았습니다. 서버 문서와 이력을 확인하세요.');
        }
      });
    }
    if(jobRef.current?.state!=='review')return;
    return run('승인 저장 중',async()=>{
      const item=jobRef.current,p=pointer.current;remember({...p,approvalAttempted:true});assign({...item,state:'approving'});
      try{const next=await api('/panel/requests/'+p.requestId+'/approve','POST',{...target(p),proposalId:item.proposal.proposalId});if(alive.current&&matchesRequest(next,p)){await onCommitted?.();assign(next);}}
      catch(e){assign({...item,state:e.status===409?'conflict':'uncertain',proposal:undefined});throw Error(e.status===409?'문서가 변경되어 다시 요청 필요': '저장 결과가 불확실합니다. 자동 재시도하지 않았습니다. 서버 문서와 이력을 확인하세요.');}
    });
  };
  const disconnect=()=>run('연결 해제 중',async()=>{await api('/panel/disconnect','POST',{});observeStatus({connected:false});await refreshJob();});

  const chip=SITE
    ? {longLabel:connected?'시험 응답':'시험 응답 연결',shortLabel:connected?'시험 응답':'연결 안 됨',state:connected?'connected':'disconnected'}
    : formatConnectionChip({connected,connection,models,model,cloud:CLOUD});
  const currentPostit=currentOpinion?postits.find(n=>n.documentId===documentId&&n.requestId===currentOpinion.requestId&&(!currentOpinion.proposalId||n.proposalId===currentOpinion.proposalId)&&(activePostitId===null||n.id===activePostitId)):null;
  const currentInsertedInfo=currentOpinion?(insertedMap[currentOpinion.requestId]||(currentOpinion.proposalId?insertedMap[currentOpinion.proposalId]:null)||(job?.requestId===currentOpinion.requestId&&job?.state==='committed'?(job.result||{receipt:'COMMITTED',revision:getRevision()}):null)):null;
  const isCurrentInserted=Boolean(currentInsertedInfo);
  const canInsertCurrent=Boolean(currentOpinion&&!isCurrentInserted&&currentOpinion.baseRevision===getRevision()&&(!job||job.requestId!==currentOpinion.requestId||job.state==='review'));
  const receipt=job?.state==='committed'?job.result:(workspaceMode==='opinion'&&currentInsertedInfo?{revision:currentInsertedInfo.revision||getRevision(),receipt:currentInsertedInfo.receipt||'COMMITTED'}:null);
  const handleArchiveCurrent=async()=>{
    if(!currentPostit||!onArchivePostit)return;
    try{
      await onArchivePostit(currentPostit.id);
      setPostitSaveState('보관됨 · 왼쪽 포스트잇 아이콘에서 확인');
    }catch(e){
      setError(`포스트잇 보관 실패: ${e.message}`);
    }
  };

  return <section className="ai-panel phase2-ai-panel" data-skin={skin} aria-label="AI 도우미">
    <div className="ai-panel-heading">
      <div><h2>✦ AI 도우미</h2><p>{SITE?'문서 의견 · 선택적 편집':CLOUD?'합성 AI 시험':'문서 의견 · 선택적 편집'}</p></div>
      <div className="phase2-panel-tools">
        <div className="b05-connection">
          <button
            type="button"
            id="b05Chip"
            className={'b05-chip '+(connected?'ai-panel-state connected':'ai-panel-state')}
            data-state={chip.state}
            aria-expanded={chipMenuOpen}
            aria-controls="b05ChipMenu"
            onClick={()=>setChipMenuOpen(!chipMenuOpen)}
          >
            <span className="b05-dot"/>
            <span className="b05-chip-long">{chip.longLabel}</span>
            <span className="b05-chip-short">{chip.shortLabel}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          {chipMenuOpen&&<div className="b05-chip-menu" id="b05ChipMenu">
            <strong>{chip.longLabel}</strong>
            <p role="status">{connectionLabel(connection)}</p>
            {connected&&models.length>0&&<div className="b05-chip-model">
              <label htmlFor="ai-panel-model-chip">참여 모델</label>
              <select id="ai-panel-model-chip" value={model} disabled={working||running||Boolean(proposal)} onChange={e=>setModel(e.target.value)}>
                {!model&&<option value="">모델을 선택하세요</option>}
                {models.map(m=><option value={m.slug} key={m.slug}>{m.name} · {m.slug}</option>)}
              </select>
            </div>}
            <div className="b05-chip-actions">
              <button type="button" className="ai-panel-secondary" disabled={working} onClick={()=>void loadStatus({refreshModels:true})}>상태 확인</button>
              {connected&&<button type="button" className="ai-panel-secondary" disabled={working} onClick={disconnect}>연결 해제</button>}
              <button type="button" className="ai-panel-secondary" onClick={()=>setChipMenuOpen(false)}>닫기</button>
            </div>
          </div>}
        </div>
        <SkinPicker value={skin} onChange={changeSkin}/>
        <button type="button" className="ai-panel-secondary mobile-ai-close" aria-label="AI 숨기기" title="AI 숨기기" onClick={onClose}>×</button>
      </div>
    </div>
    {archivedPostitView}
    <div className="phase2-ai-body" hidden={Boolean(archivedPostitView)}>
    {!CLOUD&&localBrowser&&(!connected||connecting||connectionNotice||error||modelIssue)&&<div className="ai-connection-status b06-auth-card" id="b06AuthCard" aria-label="ChatGPT 연결 상태" aria-live="polite">
      <p role="status">{connectionLabel(connection)}</p>
      {connecting&&<p>Chrome에서 로그인을 마친 뒤 편집기로 돌아오세요. 20초가 지나도 연결 대기를 유지합니다.</p>}
      {connection.phase==='waiting_browser'&&isLocalLoginPage(connection.loginPage)&&<>
        <a className="manual-login-link" href={connection.loginPage} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Chrome에서 로그인 열기</a>
        <p>로그인 탭이 열리지 않으면 눌러 주세요. 열린 페이지에서 ‘ChatGPT로 로그인’을 선택하세요.</p>
      </>}
      {connectionNotice&&<p role="alert">{connectionNotice}</p>}
      {error&&<p className="ai-panel-warning" role="alert">{error}</p>}
      {modelIssue&&<p className="ai-panel-warning" role="alert">{modelIssue}</p>}
    </div>}
    <div className="phase2-mode-tabs" role="group" aria-label="AI 도우미 모드">
      <button type="button" id="opinionTab" className={workspaceMode==='opinion'?'active':''} aria-pressed={workspaceMode==='opinion'}
        disabled={working||running||Boolean(proposal)}
        onClick={()=>{setWorkspaceMode('opinion');setMode('insert');setError('');setGoal('현재 문서를 읽고 의견을 제시해줘.');}}>의견 나누기</button>
      <button type="button" id="editTab" className={workspaceMode==='edit'?'active':''} aria-pressed={workspaceMode==='edit'}
        disabled={working||running||Boolean(proposal)}
        onClick={()=>{setWorkspaceMode('edit');setMode(selectedBlockIds.length>=2?'batch':'patch');setError('');setGoal('의미를 유지하면서 더 읽기 쉽게 다듬어줘.');}}>편집 맡기기</button>
    </div>
    {workspaceMode==='opinion'&&<div className="phase2-opinion-intro">
      <p><strong>문서에 관해 무엇이든 물어보세요.</strong> 기존 본문을 그대로 두고 AI의 의견을 포스트잇으로 받아 검토합니다.</p>
      <div className="b05-scope" id="b05OpinionScope">
        <span>{questionScope?.label||'참고 범위 · 문서 전체'}</span>
        {reaskContext&&<button type="button" className="b05-scope-clear" onClick={()=>onClearReask?.()}>재검토 해제</button>}
      </div>
      {questionScope?.scopeText&&<div className="phase2-review-context">
        <strong>{reaskContext?`(${shortModelName(reaskContext.model)})`:'선택 문단 참조 내용'}</strong>
        <p>{questionScope.scopeText.slice(0,320)}{questionScope.scopeText.length>320?'… (앞부분만 표시)':''}</p>
      </div>}
      
    </div>}
    {SITE&&workspaceMode==='opinion'&&<div>
      <label className="ai-panel-label" htmlFor="site-ai-provider">AI 제공업체</label>
      <select id="site-ai-provider" value={siteProvider} disabled={working||running||Boolean(proposal)}
        onChange={event=>setSiteProvider(event.target.value)}>
        <option value="">시험 응답</option>
        <option value="google">Google AI Studio</option>
        <option value="cloudflare">Cloudflare Workers AI</option>
        <option value="exaone">EXAONE</option>
      </select>
    </div>}
    {SITE&&siteProvider&&<div hidden={!externalOpinion}>
      <SiteAiOpinion provider={siteProvider} documentId={documentId} questionScope={questionScope}
        goal={goal} setGoal={setGoal} getRevision={getRevision} canAct={canAct}
        onEnsureDraftPostit={onEnsureDraftPostit} onArchivePostit={onArchivePostit} onBusy={setSiteAiBusy}/>
    </div>}
    {!externalOpinion&&<>
    {!localBrowser&&<p className="ai-panel-warning" role="alert">
      AI 기능은 Termux 기기의 로컬 주소에서만 사용할 수 있습니다. LAN에서는 비활성화됩니다.
    </p>}
    {localBrowser&&!connected&&<div className="ai-panel-actions">
      <button type="button" id="b06AuthStart" disabled={working||!available||connecting} onClick={connect}>{SITE?'시험 응답 연결':CLOUD?'합성 AI 연결':'ChatGPT 연결'}</button>
      {connecting&&<button type="button" id="b06AuthCancel" className="ai-panel-secondary" disabled={working} onClick={cancelConnection}>연결 취소</button>}
      <button type="button" className="ai-panel-secondary" disabled={working} onClick={()=>void loadStatus({refreshModels:true})}>상태 확인</button>
    </div>}
    {!available&&localBrowser&&<p className="ai-panel-hint">{SITE?'시험 응답 연결 상태를 확인해 주세요.':'Termux에서 npm run ai-panel 실행 후 상태 확인을 눌러주세요.'}</p>}
    {!connected&&<div className="disconnected-request"><label className="ai-panel-label" htmlFor="disconnected-goal">AI에게 질문 및 요청 (단일 입력창)</label><textarea id="disconnected-goal" rows={3} placeholder="예: 선택한 문단에 빠진 관점이 있을까? (의견 검토·리서치·사실 확인을 자유롭게 입력하세요)" disabled/><p className="ai-panel-hint">{SITE?'시험 응답 연결 후 질문을 보낼 수 있어요.':'연결 후 요청을 작성할 수 있어요. 실제 AI 답변을 받기 전에는 예시 답변을 표시하지 않습니다.'}</p></div>}
    {connected&&localBrowser&&<>
      {workspaceMode==='edit'&&<><label className="ai-panel-label" htmlFor="ai-panel-mode">편집 작업</label>
      <select id="ai-panel-mode" value={mode} disabled={working||running||Boolean(proposal)} onChange={e=>{setMode(e.target.value);setError('');}}>
        <option value="patch">선택 문단 수정</option><option value="batch">여러 문단 수정 (부분 승인)</option>
      </select></>}
      {workspaceMode==='edit'&&mode==='patch' && <div className="selected-paragraph" role="region" aria-label="선택한 문단">
        <strong>수정 대상 문단</strong>
        <p id="editTarget">{proposal?.mode==='patch'?(proposal.originalContent || '(빈 문단)'):selectedTarget?(selectedTarget.text || '(빈 문단)'):'툴바의 ‘문단 선택’ 또는 ‘이 문단 AI 수정’으로 대상 문단을 지정하세요.'}</p>
      </div>}
      <label className="ai-panel-label" htmlFor="ai-panel-goal">
        {workspaceMode==='opinion'?'AI에게 질문하기 (자유 질문 입력창)':'어떻게 다듬을까요?'}
      </label>
      <div className="req-box b05-query">
        <textarea id="ai-panel-goal" value={goal} maxLength={240}
          placeholder={workspaceMode==='opinion'?'예: 선택한 문단의 논리 점검이나 관련 사례를 검토해줘.':'예: 핵심 의미를 유지하고 간결하게 다듬어줘.'}
          disabled={working||running||Boolean(proposal)} onChange={e=>setGoal(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&mode!=='batch'&&!proposal&&!running&&job?.state!=='uncertain'&&!(working||!available||!model||!goal.trim()||!canAct()||(mode==='patch'&&!selectedTarget))){e.preventDefault();void preview();}}}
          rows={3}/>
        {mode!=='batch'&&!proposal&&!running&&job?.state!=='uncertain'&&<button className="send" id="askBtn" type="button"
          aria-label={workspaceMode==='opinion'?'질문 보내기':'AI 수정안 만들기'}
          title={workspaceMode==='opinion'?'질문 보내기':'AI 수정안 만들기'}
          disabled={working||!available||!model||!goal.trim()||!canAct()||(mode==='patch'&&!selectedTarget)} onClick={preview}>
          <svg className="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <symbol id="i-send" viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7zM11 13l11-11"/></symbol>
            <use href="#i-send"/>
          </svg>
        </button>}
      </div>
      <p className="ai-panel-hint">{mode==='patch'?'선택한 문단의 수정안을 제안합니다. 승인 전에는 원문이 바뀌지 않습니다.':'의견 답변은 생성 즉시 임시 포스트잇으로 자동 보존되며, 문서에 삽입할 때만 본문 리비전이 증가합니다.'}</p>
      {mode!=='batch'&&workspaceMode==='opinion'&&currentOpinion&&<div className="ai-panel-preview answer-card b05-postit-card" id="answerCard">
        <div className="ai-panel-preview-title">
          <span id="answerTitle">{currentPostit?.title||'AI 검토 의견'}</span>
          <small>요청 모델 ({shortModelName(currentOpinion.model)}) · 기준 변경 {currentOpinion.baseRevision}</small>
        </div>
        <p className="ai-panel-proposal" id="answerContent">{currentOpinion.content}</p>
        <p className="ai-panel-reason">제안 이유: {currentOpinion.reason}</p>
        <div className="b05-answer-save-status" id="b05AnswerSaveStatus">
          {currentPostit?.archived?'보관됨 · 왼쪽 포스트잇 아이콘에서 확인':(currentPostit?'임시 저장됨 · 보관 가능':(postitSaveState||'임시 저장 확인 중…'))}
          {currentPostit?.createdAt?` · 생성 ${formatPostitTime(currentPostit.createdAt)}`:''}
          {isCurrentInserted?` · 본문 삽입 완료${currentInsertedInfo?.revision?` (변경 ${currentInsertedInfo.revision})`:''}`:''}
        </div>
        <div className="ai-panel-actions reply-actions">
          <button type="button" className="ai-panel-secondary" id="copyAnswer" onClick={()=>void copyAnswer(currentOpinion.content)}>복사</button>
          <button type="button" className="ai-panel-secondary b05-store-btn" id="b05StoreAnswer" disabled={working||running||!currentPostit||Boolean(currentPostit?.archived)} onClick={()=>void handleArchiveCurrent()}>
            {currentPostit?.archived?'보관됨':'보관'}
          </button>
          {postitSaveState.startsWith('임시 저장 실패')&&<button type="button" className="ai-panel-secondary" onClick={()=>void saveCurrentPostit({requestId:currentOpinion.requestId,goal:currentOpinion.goal},currentOpinion)}>임시 저장 다시 확인</button>}
          <button type="button" className="ai-panel-primary" id="insertAnswer" disabled={working||running||!canAct()||isCurrentInserted||!canInsertCurrent} onClick={approve}>
            {isCurrentInserted?'삽입 완료':'문서에 삽입'}
          </button>
        </div>
      </div>}
      {mode!=='batch'&&proposal&&proposal.mode==='patch'&&<div className="ai-panel-preview answer-card">
        <div className="ai-panel-preview-title">문단 수정안 <small>변경 {proposal.baseRevision}</small></div>
        <ParagraphComparison before={proposal.originalContent} after={proposal.content}/>
        <p className="ai-panel-reason">제안 이유: {proposal.reason}</p>
        <div className="ai-panel-actions">
          <button type="button" className="ai-panel-secondary" onClick={()=>void copyAnswer(proposal.content)}>복사</button>
          <button type="button" className="ai-panel-secondary" disabled={working} onClick={reject}>거절</button>
          <button type="button" className="ai-panel-primary" disabled={working||!canAct()} onClick={approve}>
            승인 후 저장
          </button>
        </div>
      </div>}
      {receipt&&<p className="ai-panel-success" role="status">저장 확인 · 변경 {receipt.revision} · {receipt.receipt}</p>}
    </>}
    </>}
    {connected&&workspaceMode==='edit'&&mode==='batch'&&<BatchPanel api={api} documentId={documentId} getRevision={getRevision} getParagraphs={getEditableParagraphs} selectedBlockIds={selectedBlockIds} model={model} goal={goal} legacy={legacy} canAct={canAct} onCommitted={onCommitted} guard={batchGuard} onBusy={setBatchBusy}/>}
    {connected&&<section className="proposal-list" aria-label="이 문서의 AI 요청">
      <h3>이 문서의 AI 요청</h3>
      <button type="button" disabled={working} onClick={newDraft}>다른 요청 만들기</button>
      {!requests.length&&<p>아직 요청이 없습니다.</p>}
      {requests.map(r=><button type="button" className="proposal-row" key={r.requestId} disabled={working} aria-pressed={job?.requestId===r.requestId||(workspaceMode==='opinion'&&currentOpinion?.requestId===r.requestId)} onClick={()=>choose(r)}>
        <strong>{requestLabel(r.state)}</strong><span>{r.goal}</span>
      </button>)}
    </section>}
    {job && <div className="ai-request-state" role="status"><strong>{requestLabel(job.state)}</strong>
      {job.code==='START_NOT_CONFIRMED'&&<p role="alert">요청 접수를 확인하지 못했어요. 질문과 선택을 유지했습니다. 연결을 확인하고 요청 취소 후 다시 시작하세요.</p>}
      {job.code==='STATUS_UNAVAILABLE'&&<p role="alert">요청 상태를 확인하지 못했어요. 연결 상태를 확인하세요.</p>}
      {job.code==='INVALID_GOAL'&&<p role="alert">질문은 240자 이내로 입력하고 허용되지 않는 제어문자를 제거하세요.</p>}
      {job.code==='AUTH_EXPIRED'&&<p role="alert">인증이 만료됐거나 거부됐어요. 연결을 다시 확인하세요.</p>}
      {job.code==='AI_PROVIDER_UNAVAILABLE'&&<p role="alert">AI 서비스 응답을 받지 못했어요. 연결 상태를 확인하고 다시 요청하세요.</p>}
      {job.code==='AI_REQUEST_FAILED'&&<p role="alert">AI 요청을 완료하지 못했어요. 질문을 유지했으니 상태를 확인하고 다시 요청하세요.</p>}
      {job.code==='REFERENCE_TOO_LARGE'&&<p role="alert">선택한 참고 내용이 너무 깁니다. 범위를 줄여 다시 요청하세요.</p>}
      {job.code==='INVALID_REFERENCE'&&<p role="alert">선택 문단을 다시 확인하세요.</p>}
      {job.state==='expired'&&<p>이전 요청을 복구할 수 없습니다. 문단을 선택하고 새로 요청하세요.</p>}
      {job.state==='conflict'&&<p>대상 문단이나 문서가 바뀌었습니다. 현재 내용을 확인하고 새로 요청하세요.</p>}
      {job.state==='uncertain'&&<p>저장 결과가 불확실합니다. 자동 재시도하지 않았습니다. 서버 문서와 변경 이력을 확인하세요.</p>}
      {(running||job.localUnknown||job.state==='uncertain')&&<button type="button" disabled={working||job.state==='approving'} onClick={cancel}>요청 취소</button>}
    </div>}
    {busy&&<p className="ai-panel-hint" role="status">{busy}…</p>}
    {CLOUD&&error&&<p className="ai-panel-warning" role="alert">{error}</p>}
    <p className="ai-panel-disclaimer">답변은 검토 후 보관하거나 문서 끝에 삽입할 수 있어요. 자유 대화·웹 리서치·선택 위치 삽입은 후속 연결 예정입니다. 수정안은 승인 전 원문을 변경하지 않습니다.</p>
    </div>
  </section>;
}

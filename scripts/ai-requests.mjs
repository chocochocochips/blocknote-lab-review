/** F05-04 request ledger. Memory only; GET revalidates and never performs a write. */
import {blockHash} from '../server/block-edit.mjs';
import {validGoal} from '../shared/ai-goal.mjs';
import {isEditableParagraph,stableJson} from '../shared/block-edit.mjs';
const fail=(status,code,message)=>{const e=new Error(message);Object.assign(e,{status,code});throw e;};
const LIVE=new Set(['running','review']);
export function createAiRequests({prepare,commit,document,canStart,timeoutMs=60000,ttlMs=600000,now=Date.now,initialRecords=[]}) {
  const records=new Map(initialRecords.map(r=>[r.id,{...r,controller:new AbortController()}]));
  const pending=new Set();
  let closed=false;
  const stop=(r,state,code)=>{r.state=state;r.code=code;r.controller.abort();if(r.item?.mode!=='insert'||state!=='conflict')delete r.item;};
  function expire(r){if(LIVE.has(r.state)&&now()-r.createdAt>=ttlMs)stop(r,'expired','REQUEST_EXPIRED');}
  function find(id,documentId){
    const r=records.get(id);
    if(!r)fail(404,'REQUEST_EXPIRED','이전 AI 요청이 만료됐습니다. 새로 요청하세요.');
    if(r.documentId!==documentId)fail(409,'DOCUMENT_ID_MISMATCH','현재 문서의 AI 요청이 아닙니다.');
    expire(r);return r;
  }
  function bound(id,body){const r=find(id,body.documentId);if(body.targetId!==r.targetId||body.baseRevision!==r.baseRevision)fail(409,'REQUEST_TARGET_MISMATCH','AI 요청의 대상이 다릅니다.');return r;}
  function snapshot(r){
    const p=(r.state==='review'||(r.item?.mode==='insert'&&['committed','conflict'].includes(r.state)))?r.item:null;
    return {requestId:r.id,documentId:r.documentId,targetId:r.targetId,baseRevision:r.baseRevision,state:r.state,groupId:r.groupId??null,
      code:r.code??null,createdAt:r.createdAt,model:r.model,goal:r.goal,...(p?{proposal:{proposalId:p.proposalId,documentId:p.documentId,targetId:p.targetId,baseRevision:p.baseRevision,
        model:p.model,mode:p.mode,originalContent:p.originalContent,content:p.content,reason:p.reason,...(p.postitId?{postitId:p.postitId}:{}),...(p.postitSave?{postitSave:p.postitSave}:{}),...(p.postitDraft?{postitDraft:p.postitDraft}:{})}}:{}),...(r.result?{result:r.result}:{})};
  }
  async function validate(r){
    if(r.state!=='review')return;
    const item=r.item;
    try{
      const d=await document(item.scoped?item.documentId:undefined);
      if(r.state!=='review'||r.item!==item)return;
      const b=d.blocks?.find(b=>b.id===item.targetId);
      if(d.id!==r.documentId||d.revision!==r.baseRevision||!b||
        (item.mode==='patch'&&(!isEditableParagraph(b)||blockHash(b)!==item.beforeHash)))stop(r,'conflict','DOCUMENT_CHANGED');
    }catch{if(r.state==='review')stop(r,'failed','DOCUMENT_UNAVAILABLE');}
  }
  async function run(r,body){
    const assertActive=()=>{expire(r);if(closed||r.state!=='running'||r.controller.signal.aborted)fail(409,'REQUEST_INACTIVE','요청이 더 이상 유효하지 않습니다.');};
    let timer;
    try{
      const aborted=new Promise((_,reject)=>{
        r.controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('inactive'),{code:'REQUEST_INACTIVE'})),{once:true});
        timer=setTimeout(()=>{if(r.state==='running')stop(r,'failed','AI_TIMEOUT');},timeoutMs);timer.unref?.();
      });
      const item=await Promise.race([prepare(body,{requestId:r.id,signal:r.controller.signal,assertActive}),aborted]);
      assertActive();r.item=item;r.state='review';await validate(r);
    }catch(e){if(r.state==='running'){const known=['REFERENCE_TOO_LARGE','REFERENCE_CHANGED','INVALID_REFERENCE','AUTH_EXPIRED','AI_PROVIDER_UNAVAILABLE','INVALID_GOAL'].includes(e.code);stop(r,e.status===409?'conflict':'failed',known?e.code:(e.status===409?'DOCUMENT_CHANGED':'AI_REQUEST_FAILED'));}}
    finally{clearTimeout(timer);}
  }
  return {
    start(body,{groupId}={}){
      const {requestId,documentId,targetId,baseRevision,model,goal}=body;
      if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)||
        typeof documentId!=='string'||!documentId||documentId.length>128||typeof targetId!=='string'||!targetId||targetId.length>128||
        !Number.isSafeInteger(baseRevision)||baseRevision<1||typeof model!=='string'||!model||
        !['patch','insert'].includes(body.mode))fail(400,'INVALID_REQUEST','문서와 문단을 선택하고 요청 내용을 확인하세요.');
      if(!validGoal(goal))fail(400,'INVALID_GOAL','질문은 240자 이내로 입력하고 허용되지 않는 제어문자를 제거하세요.');
      const fingerprint=stableJson(body),old=records.get(requestId);
      if(old){if(old.fingerprint!==fingerprint)fail(409,'REQUEST_ID_REUSED','요청 ID가 다른 내용으로 재사용됐습니다.');return snapshot(find(requestId,documentId));}
      if(closed||!canStart())fail(409,'NOT_READY','AI 연결 상태를 확인하세요.');
      for(const [id,r] of records){expire(r);if(!LIVE.has(r.state)&&r.state!=='approving'&&now()-r.createdAt>ttlMs)records.delete(id);}
      if(records.size>=64||[...records.values()].filter(r=>LIVE.has(r.state)||r.state==='approving').length>=8)fail(429,'REQUEST_LIMIT','진행 중인 요청을 마치거나 취소한 뒤 다시 요청하세요.');
      const r={id:requestId,documentId,targetId,baseRevision,model,goal,groupId,state:'running',createdAt:now(),fingerprint,controller:new AbortController()};records.set(requestId,r);
      const task=run(r,body);pending.add(task);void task.finally(()=>pending.delete(task));return snapshot(r);
    },
    async list(documentId){if(typeof documentId!=='string'||!documentId)fail(400,'INVALID_DOCUMENT','문서를 선택하세요.');const rows=[...records.values()].filter(r=>r.documentId===documentId);await Promise.all(rows.map(async r=>{expire(r);await validate(r);}));return rows.sort((a,b)=>b.createdAt-a.createdAt).map(r=>{const {proposal,...summary}=snapshot(r);return summary;});},
    async get(id,documentId){const r=find(id,documentId);await validate(r);expire(r);return snapshot(r);},
    cancel(id,body){
      const r=bound(id,body);
      if(r.state==='approving'||r.state==='committed'||r.state==='uncertain')fail(409,'APPROVAL_IN_PROGRESS','승인 저장은 취소할 수 없습니다. 문서와 이력을 확인하세요.');
      if(LIVE.has(r.state))stop(r,'cancelled','REQUEST_CANCELLED');return snapshot(r);
    },
    async approve(id,body){
      const r=bound(id,body);
      if(r.groupId)fail(409,'GROUP_APPROVAL_REQUIRED','여러 문단 요청은 일괄 검토 화면에서 승인하세요.');
      if(r.state!=='review'||body.proposalId!==r.item?.proposalId)fail(409,'REQUEST_NOT_REVIEWABLE','검토할 수 없는 요청입니다. 새로 요청하세요.');
      // This synchronous transition happens before any await. No double approval,
      // cancellation or stale GET can resurrect a request once saving begins.
      const item=r.item;r.state='approving';
      try{r.result=await commit(item);r.state='committed';if(item.mode!=='insert')delete r.item;return snapshot(r);}
      catch(e){r.state=e.code==='SAVE_UNCERTAIN'?'uncertain':e.status===409?'conflict':'failed';r.code=e.code??'AI_REQUEST_FAILED';if(item.mode!=='insert'||r.state!=='conflict')delete r.item;e.requestId=r.id;throw e;}
    },
    discard(ids){for(const id of ids){const r=records.get(id);if(r&&LIVE.has(r.state))stop(r,'cancelled','REQUEST_CANCELLED');}},
    reserve(ids,groupId,documentId,baseRevision){
      const rows=ids.map(id=>find(id,documentId));
      if(new Set(ids).size!==ids.length||rows.some(r=>r.groupId!==groupId||r.baseRevision!==baseRevision||r.state!=='review'||!r.item))fail(409,'GROUP_CHANGED','검토한 문단들이 변경되었습니다.');
      for(const r of rows)r.state='approving';return rows.map(r=>r.item);
    },
    finish(ids,state,result,code){for(const id of ids){const r=records.get(id);if(r?.state==='approving'){r.state=state;r.result=result;r.code=code;delete r.item;}}},
    drain:()=>Promise.all(pending),
    snapshot:()=>[...records.values()].map(({controller,...r})=>r),
    approving:()=>[...records.values()].some(r=>r.state==='approving'),
    invalidate(final=false){closed=final;for(const r of records.values())if(LIVE.has(r.state))stop(r,'expired','REQUEST_EXPIRED');},
  };
}

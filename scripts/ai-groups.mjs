import {stableJson} from '../shared/block-edit.mjs';
const fail=(status,code,message)=>{const e=new Error(message);Object.assign(e,{status,code});throw e;};
export function createAiGroups({requests,commit,initialGroups=[]}){
 const groups=new Map(initialGroups.map(g=>[g.id,g]));
 function find(id,documentId){const g=groups.get(id);if(!g)fail(404,'REQUEST_EXPIRED','여러 문단 요청이 만료됐습니다.');if(g.documentId!==documentId)fail(409,'DOCUMENT_ID_MISMATCH','다른 문서의 요청입니다.');return g;}
 const identity=g=>({groupId:g.id,documentId:g.documentId,baseRevision:g.baseRevision,state:g.state,code:g.code??null,result:g.result});
 async function inspect(g){
  if(g.state==='running'||g.state==='review'){
   const rows=await Promise.all(g.children.map(x=>requests.get(x.requestId,g.documentId)));
   if(!['running','review'].includes(g.state))return {...identity(g),requests:[]};
   if(rows.some(r=>['conflict','failed','expired','cancelled'].includes(r.state))){g.state='conflict';g.code='GROUP_CHANGED';}
   else g.state=rows.some(r=>r.state==='running')?'running':'review';
   return {...identity(g),requests:g.state==='review'?rows:[]};
  }return {...identity(g),requests:[]};
 }
 return {
  start(body){
   const {groupId,documentId,baseRevision,targetIds}=body;
   if(typeof groupId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/.test(groupId)||!Array.isArray(targetIds)||targetIds.length<2||targetIds.length>5||new Set(targetIds).size!==targetIds.length)fail(400,'INVALID_GROUP','서로 다른 일반 문단 2~5개를 선택하세요.');
   const old=groups.get(groupId);if(old){if(old.fingerprint!==stableJson(body))fail(409,'REQUEST_ID_REUSED','다른 요청에 ID를 재사용할 수 없습니다.');return identity(find(groupId,documentId));}
   if(groups.size>=32)fail(429,'GROUP_LIMIT','실행부를 다시 시작한 뒤 새 시험을 진행하세요.');
   const g={id:groupId,documentId,baseRevision,state:'running',fingerprint:stableJson(body),children:[]};
   try{for(let i=0;i<targetIds.length;i++){const r=requests.start({requestId:groupId+':'+i,documentId,baseRevision,targetId:targetIds[i],model:body.model,goal:body.goal,mode:'patch',legacy:Boolean(body.legacy)},{groupId});g.children.push(r);}}
   catch(e){for(const c of g.children)requests.cancel(c.requestId,{documentId,targetId:c.targetId,baseRevision});throw e;}
   groups.set(groupId,g);return identity(g);
  },
  snapshot:()=>[...groups.values()],
  async get(id,documentId){return inspect(find(id,documentId));},
  cancel(id,body){const g=find(id,body.documentId);if(body.baseRevision!==g.baseRevision)fail(409,'GROUP_CHANGED','기준 Revision이 다릅니다.');if(['approving','committed','uncertain'].includes(g.state))fail(409,'APPROVAL_IN_PROGRESS','승인 저장은 취소할 수 없습니다.');g.state='cancelled';for(const c of g.children)requests.cancel(c.requestId,{documentId:g.documentId,targetId:c.targetId,baseRevision:g.baseRevision});return identity(g);},
  async approve(id,body){
   const g=find(id,body.documentId);if(body.baseRevision!==g.baseRevision||g.state!=='review')fail(409,'GROUP_CHANGED','검토 가능한 수정안이 아닙니다.');
   const selected=body.targetIds??g.children.map(c=>c.targetId);
   if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!g.children.some(c=>c.targetId===id)))fail(400,'INVALID_SELECTION','승인할 문단을 하나 이상 정확히 선택하세요.');
   const chosen=g.children.filter(c=>selected.includes(c.targetId)),skipped=g.children.filter(c=>!selected.includes(c.targetId));
   const items=requests.reserve(chosen.map(c=>c.requestId),g.id,g.documentId,g.baseRevision);g.state='approving';
   try{g.result={...await commit(g,items),skippedCount:skipped.length};g.state='committed';requests.finish(chosen.map(c=>c.requestId),'committed',g.result);requests.discard(skipped.map(c=>c.requestId));return identity(g);}
   catch(e){g.state=e.code==='SAVE_UNCERTAIN'?'uncertain':e.status===409?'conflict':'failed';g.code=e.code;requests.finish(chosen.map(c=>c.requestId),g.state,undefined,e.code);e.requestId=g.id;throw e;}
  },
 };
}

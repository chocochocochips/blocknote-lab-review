/** Synthetic-only bridge behind the unchanged Cloudtype session/Origin gate.
 * No OAuth, external model, credentials or network imports. */
import {randomUUID} from 'node:crypto';
import {createAiRequests} from '../scripts/ai-requests.mjs';import {createAiGroups} from '../scripts/ai-groups.mjs';
import {isEditableParagraph,paragraphText} from '../shared/block-edit.mjs';import {blockHash} from './block-edit.mjs';import {RequestError} from './validation.mjs';
const fail=(status,code)=>{throw new RequestError(status,code,'합성 시험 요청을 처리하지 못했습니다.');};
export function createCloudAi({session,internal,now=Date.now,persisted=null,prepareHosted}){
 const path=(id,suffix)=>'/api/documents/'+encodeURIComponent(id)+suffix;
 const document=id=>internal(path(id,'/document'));
 const evidence=i=>({model:i.model,documentId:i.documentId,blockId:i.targetId,baseRevision:i.baseRevision,beforeText:i.originalContent,afterText:i.content,beforeHash:i.beforeHash});
 async function commit(items,id,batch=false){
  const first=items[0],doc=await document(first.documentId);
  if(doc.id!==first.documentId||doc.revision!==first.baseRevision)fail(409,'REVISION_CONFLICT');
  for(const item of items){const b=doc.blocks.find(b=>b.id===item.targetId);if(!b||(item.mode==='patch'&&(!isEditableParagraph(b)||blockHash(b)!==item.beforeHash)))fail(409,'EDIT_TARGET_CHANGED');}
  const payload={documentId:doc.id,revision:doc.revision,actor:prepareHosted?'시험 응답':'synthetic AI',requestId:id,proposalId:batch?id:first.proposalId,goal:first.goal,reason:'문서 모드 누적 합성 시험',approval:'approved',
   ...(batch?{edits:items.map(evidence)}:{content:first.content,type:'paragraph',afterId:first.targetId,...(first.mode==='patch'?{edit:evidence(first)}:prepareHosted?{opinionModel:'시험 응답'}:{})})};
  try{
   const saved=await internal(path(doc.id,batch?'/blocks':first.mode==='patch'?'/blocks/'+encodeURIComponent(first.targetId):'/blocks'),batch||first.mode==='patch'?'PATCH':'POST',payload);
   const receipt=await internal(path(doc.id,'/requests/'+id)),audit=await internal(path(doc.id,'/history'));
   const rows=audit.events.filter(e=>e.idempotency?.requestId===id);
   if(receipt.outcome!=='COMMITTED'||receipt.revision!==saved.revision||rows.length!==1||rows[0].proposal?.proposalId!==payload.proposalId||
      (batch? saved.blockIds?.length!==items.length||!items.every(i=>saved.blockIds.includes(i.targetId)) :saved.block?.id!==first.targetId&&first.mode==='patch'))throw Error('uncertain');
   return {...saved,saved:true,receipt:'COMMITTED',auditRecords:1};
  }catch(e){if(e.status===409)throw e;fail(503,'SAVE_UNCERTAIN');}
 }
 const requests=createAiRequests({canStart:()=>session.connected,document,now,initialRecords:persisted?.requests,prepare:async(body,{assertActive})=>{
  assertActive();if(body.model!=='synthetic-test')fail(400,'UNKNOWN_MODEL');const doc=await document(body.documentId);assertActive();
  if(doc.id!==body.documentId||doc.revision!==body.baseRevision)fail(409,'REVISION_CONFLICT');const b=doc.blocks.find(b=>b.id===body.targetId);
  if(!b||(body.mode==='patch'&&!isEditableParagraph(b)))fail(422,'UNSUPPORTED_EDIT_TARGET');
  const item = {scoped:true,mode:body.mode,documentId:doc.id,targetId:b.id,baseRevision:doc.revision,model:'synthetic-test',goal:body.goal,
    proposalId:'synthetic-'+randomUUID(),requestId:body.requestId,createdAt:now(),beforeHash:body.mode==='patch'?blockHash(b):undefined,
    originalContent:body.mode==='patch'?paragraphText(b):undefined,
    content:body.mode==='patch'?paragraphText(b)+' [합성 수정안] '+body.goal:'[합성 AI 시험] '+body.goal,reason:'실제 모델 호출이 없는 합성 시험입니다.'};
  return prepareHosted ? prepareHosted({body,doc,item,internal,assertActive}) : item;
 },commit:item=>commit([item],item.requestId)});
 const groups=createAiGroups({requests,initialGroups:persisted?.groups,commit:(g,items)=>commit(items,g.id,true)});
 return {
  drain:requests.drain,
  snapshot:()=>({requests:requests.snapshot(),groups:groups.snapshot()}),
  async settle(path,result){
   await requests.drain();
   return path==='/panel/requests'
    ? requests.get(result.requestId,result.documentId)
    : groups.get(result.groupId,result.documentId);
  },
  close(){session.connected=false;requests.invalidate(true);},
  async handle(req,res,body){
   const u=new URL(req.url,'https://synthetic.test');let result;
   try{
    if(u.pathname==='/panel/requests'){
     if(req.method==='GET')result={requests:await requests.list(u.searchParams.get('documentId'))};
     else if(req.method==='POST')result=requests.start(body);else fail(405,'METHOD_NOT_ALLOWED');
    }else if(u.pathname==='/panel/groups'&&req.method==='POST')result=groups.start(body);
    else{
     const m=u.pathname.match(/^\/panel\/(requests|groups)\/([A-Za-z0-9._:-]+)(?:\/(cancel|approve))?$/);if(!m)fail(404,'NOT_FOUND');const store=m[1]==='requests'?requests:groups;
     if(req.method==='GET'&&!m[3])result=await store.get(m[2],u.searchParams.get('documentId'));
     else if(req.method==='POST'&&m[3])result=m[3]==='cancel'?store.cancel(m[2],body):await store.approve(m[2],body);else fail(405,'METHOD_NOT_ALLOWED');
    }
   }catch(e){if(e instanceof RequestError)throw e;fail(e.status??503,e.code??'AI_REQUEST_FAILED');}
   res.writeHead(req.method==='POST'&&['/panel/requests','/panel/groups'].includes(u.pathname)?202:200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));
  },
 };
}

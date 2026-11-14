import {createAiGroups} from './ai-groups.mjs';
import {createAiRequests} from './ai-requests.mjs';
import {isEditableParagraph, paragraphText} from '../shared/block-edit.mjs';
import {extractBlockText} from '../shared/paragraph-selection.mjs';
import {POSTIT_LIMITS,isValidPostitId} from '../shared/postit-contract.mjs';
import {isLocalLoginPage} from '../shared/local-login-page.mjs';
import {blockHash} from '../server/block-edit.mjs';
/** F03-13: loopback-only in-memory AI collaboration controller.
 * Keep OAuth credentials OUT of the document API, Vite proxy and browser.
 * Run separately from npm run web: npm run ai-panel.
 */
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {lstatSync,realpathSync} from 'node:fs';
import {connectEphemeral} from './siwc-ephemeral.mjs';
import {listSubscriptionModels, requestSubscriptionProposal} from './siwc-provider.mjs';

const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const MAX_INPUT = 16384;
const PROPOSAL_TTL_MS = 10 * 60 * 1000;
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
function json(res, status, value) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415,'JSON_REQUIRED','JSON 요청만 허용합니다.');
  }
  let bytes=0, parts=[];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > MAX_INPUT) throw new ApiError(413,'TOO_LARGE','요청이 너무 큽니다.');
    parts.push(part);
  }
  try {
    const obj=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(!obj || Array.isArray(obj) || typeof obj !== 'object') throw Error('invalid');
    return obj;
  } catch { throw new ApiError(400,'INVALID_JSON','요청 JSON이 유효하지 않습니다.'); }
}
export function createAiPanelServer({
  connect=connectEphemeral, listModels=listSubscriptionModels,
  propose=requestSubscriptionProposal, fetchImpl=fetch,
  documentBase='http://127.0.0.1:8787', requestTimeoutMs=60000, requestTtlMs=PROPOSAL_TTL_MS, requestNow=Date.now,
  connectTimeoutMs=240000, allowedOrigins=DEFAULT_ORIGINS,
}={}) {
  if(!Array.isArray(allowedOrigins)||!allowedOrigins.length||allowedOrigins.some(origin=>!/^http:\/\/(127\.0\.0\.1|localhost):[1-9]\d{0,4}$/.test(origin)||Number(new URL(origin).port)>65535))throw Error('Invalid loopback origin');
  const allowed=new Set(allowedOrigins);
  const base=new URL(documentBase);
  if(base.protocol!=='http:' || base.hostname!=='127.0.0.1' ||
    base.username || base.password || base.search || base.hash || base.pathname!=='/') {
    throw Error('AI panel requires a loopback document server');
  }
  let session=null, catalog=[], pending=null, busy=null, stopping=false, shutdown;
  let connection={phase:'idle',attemptId:null,errorCode:null},attempt=null;
  const connectionTasks=new Set();
  const connecting=()=>['starting','waiting_browser','verifying'].includes(connection.phase);
  const lifetime=new AbortController();
  if(!Number.isFinite(connectTimeoutMs)||connectTimeoutMs<1)throw Error('Invalid connection timeout');
  // Only the current waiting attempt may expose its opaque LOCAL bridge page.
  const publicConnection=()=>({...connection,...(connection.phase==='waiting_browser'&&
    attempt?.id===connection.attemptId&&isLocalLoginPage(attempt.loginPage)?{loginPage:attempt.loginPage}:{})});
  function cancelConnection(phase='cancelled'){
    if(!connecting())return false;
    connection={...connection,phase,errorCode:phase==='expired'?'CONNECT_TIMEOUT':'CONNECT_CANCELLED'};
    if(attempt){attempt.loginPage=null;attempt.controller.abort();}
    if(busy==='connecting')busy=null;
    return true;
  }
  function checkSession(){
    if(!session)return;
    try{session.bearer();}catch{
      const active=session;session=null;catalog=[];pending=null;requests.invalidate();
      connection={...connection,phase:'expired',errorCode:'SESSION_EXPIRED'};
      void active.close().catch(()=>{});
    }
  }
  function beginConnection(){
    const current={id:randomUUID(),controller:new AbortController(),loginPage:null};attempt=current;
    connection={phase:'starting',attemptId:current.id,errorCode:null};busy='connecting';
    const timer=setTimeout(()=>{if(attempt===current)cancelConnection('expired');},connectTimeoutMs);
    const task=(async()=>{
      try{
        const connected=await connect({signal:AbortSignal.any([lifetime.signal,current.controller.signal]),
          timeoutMs:Math.min(180000,connectTimeoutMs),onLoginPage:page=>{
            if(attempt===current&&!current.controller.signal.aborted&&connection.phase==='waiting_browser')
              current.loginPage=isLocalLoginPage(page)?page:null;
          },onProgress:phase=>{
            if(attempt===current&&!current.controller.signal.aborted&&connecting()&&['starting','waiting_browser','verifying'].includes(phase)){
              if(phase!=='waiting_browser')current.loginPage=null;
              connection={...connection,phase};
            }
          }});
        if(stopping||attempt!==current||current.controller.signal.aborted){await connected.close();return;}
        session=connected;catalog=[];pending=null;
        connection={...connection,phase:'connected',errorCode:null};
      }catch(e){
        if(attempt===current&&connecting()){
          const expired=e?.message==='Sign-in timed out';
          connection={...connection,phase:expired?'expired':'failed',errorCode:expired?'CONNECT_TIMEOUT':'CONNECT_FAILED'};
        }
      }finally{
        clearTimeout(timer);current.loginPage=null;
        if(attempt===current&&busy==='connecting')busy=null;
      }
    })();
    connectionTasks.add(task);void task.finally(()=>connectionTasks.delete(task));
    return {id:current.id,task};
  }
  const read=(path, opts={})=>fetchImpl(new URL(path,base),{
    ...opts,signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(15000)]),
  });
  const docPath=(id,suffix)=>id?'/api/documents/'+encodeURIComponent(id)+suffix:'/api'+suffix;
  const document=async(id)=>{
    const r=await read(docPath(id,'/document'));
    if(!r.ok)throw new ApiError(502,'DOCUMENT_UNAVAILABLE','문서 서버를 읽지 못했습니다.');
    return r.json();
  };

  const publicProposal=p=>({proposalId:p.proposalId,model:p.model,documentId:p.documentId,baseRevision:p.baseRevision,
    targetId:p.targetId,mode:p.mode,originalContent:p.originalContent,content:p.content,reason:p.reason,
    ...(p.postitId?{postitId:p.postitId}:{}),...(p.postitSave?{postitSave:p.postitSave}:{}),...(p.postitDraft?{postitDraft:p.postitDraft}:{})});
  async function prepareProposal(body,{signal,requestId,assertActive=()=>{}}={}) {
    if(!session)throw new ApiError(409,'NOT_CONNECTED','먼저 ChatGPT를 연결하세요.');
        const {model,goal,targetId}=body;
        const mode=body.mode??'insert';
        if(!['insert','patch'].includes(mode) || (body.legacy!==undefined && typeof body.legacy!=='boolean'))throw new ApiError(400,'INVALID_REQUEST','작업 유형을 확인하세요.');
        if(mode==='patch' && (typeof body.documentId!=='string' || !body.documentId || !Number.isSafeInteger(body.baseRevision) || body.baseRevision<1))throw new ApiError(400,'INVALID_REQUEST','문서 ID와 기준 Revision이 필요합니다.');
        if(typeof model!=='string' || !model || typeof goal!=='string' || !goal.trim() ||
          goal.length>400 || typeof targetId!=='string' || !targetId || targetId.length>128){
          throw new ApiError(400,'INVALID_REQUEST','모델, 목표, 삽입 위치를 확인하세요.');
        }
          if(!catalog.length)catalog=await listModels({bearer:session.bearer()});
          if(!catalog.some(m=>m.slug===model))throw new ApiError(400,'UNKNOWN_MODEL','사용 가능한 모델을 선택하세요.');
          assertActive();
          const scoped=Boolean(body.documentId)&&!body.legacy;
          const doc=await document(scoped?body.documentId:undefined);
          assertActive();
          if(body.documentId!==undefined && (body.documentId!==doc.id || body.baseRevision!==doc.revision))throw new ApiError(409,'REVISION_CONFLICT','문서 ID 또는 기준 Revision이 다릅니다.');
          if(!doc.blocks.some(b=>b.id===targetId))throw new ApiError(409,'TARGET_CHANGED','대상 블록이 변경됐습니다.');
          const target=doc.blocks.find(b=>b.id===targetId);
          if(mode==='patch' && !isEditableParagraph(target))throw new ApiError(422,'UNSUPPORTED_EDIT_TARGET','서식 없는 일반 문단만 수정할 수 있습니다.');
          const originalContent=mode==='patch'?paragraphText(target):undefined;
          const beforeHash=mode==='patch'?blockHash(target):undefined;
          // Resolve selections from the revision-checked server document. Never
          // silently truncate or trust client-provided text as document content.
          let reference=null,referenceText='';
          const ids=body.targetIds??[];
          if(!Array.isArray(ids)||ids.length>POSTIT_LIMITS.maxTargetIds||new Set(ids).size!==ids.length||ids.some(id=>!isValidPostitId(id)))
            throw new ApiError(422,'INVALID_REFERENCE','선택 문단을 다시 확인하세요.');
          if(body.reaskedFromId){
            if(ids.length||!isValidPostitId(body.reaskedFromId))throw new ApiError(422,'INVALID_REFERENCE','참고 범위를 다시 확인하세요.');
            const reply=await read(docPath(scoped?doc.id:undefined,'/postits/'+encodeURIComponent(body.reaskedFromId)));
            if(!reply.ok)throw new ApiError(409,'REFERENCE_CHANGED','보관한 답변을 다시 확인하세요.');
            const note=(await reply.json()).postit;
            if(!note||note.documentId!==doc.id||!note.archived||typeof note.content!=='string'||!Number.isSafeInteger(body.reaskedItemRevision)||body.reaskedItemRevision!==note.itemRevision)throw new ApiError(409,'REFERENCE_CHANGED','보관한 답변을 다시 확인하세요.');
            reference={kind:'postit',postitId:note.id,itemRevision:note.itemRevision,title:note.title,content:note.content};
            referenceText=note.content;
          }else if(ids.length){
            const wanted=new Set(ids),blocks=doc.blocks.filter(block=>wanted.has(block.id));
            if(blocks.length!==ids.length)throw new ApiError(409,'REFERENCE_CHANGED','선택한 문단이 변경되었습니다. 다시 선택하세요.');
            reference={kind:'selection',blocks:blocks.map(block=>({id:block.id,type:block.type,text:extractBlockText(block)}))};
            referenceText=reference.blocks.map(block=>block.text).join('\n\n');
          }
          if(reference&&JSON.stringify(reference).length>POSTIT_LIMITS.maxScopeTextLength)
            throw new ApiError(413,'REFERENCE_TOO_LARGE','선택한 참고 내용이 너무 깁니다. 범위를 줄여 다시 요청하세요.');
          const result=await propose({document:doc,model,mode,targetId,goal:goal.trim(),reference,bearer:session.bearer(),signal:AbortSignal.any([lifetime.signal,signal??AbortSignal.timeout(60000)])});
          assertActive();
          if(stopping)throw new ApiError(503,'SHUTTING_DOWN','AI 실행부가 종료 중입니다.');
          const content=result?.proposal?.content,reason=result?.proposal?.reason;
          if(typeof content!=='string'||!content.trim()||content.length>20000 || typeof reason!=='string') {
            throw new ApiError(502,'INVALID_PROPOSAL','AI 제안 형식을 확인하지 못했습니다.');
          }
          if(mode==='patch' && content===originalContent)throw new ApiError(422,'NO_CHANGE','원문과 같은 제안입니다. 저장하지 않았습니다.');
          const item={scoped,mode,originalContent,beforeHash,proposalId:'siwc-'+randomUUID(),requestId:requestId??'siwc:'+randomUUID(),baseRevision:doc.revision,documentId:doc.id,
            model,goal:goal.trim(),targetId,content,reason,createdAt:Date.now()};
          // B-05: Automatically persist opinion responses as a temporary Post-it on the server
          // without changing main document revision or history.
          if(mode==='insert' && requestId){
            item.postitSave='failed';
            // Keep the original request metadata for an idempotent retry after
            // a reload. It remains in memory and is never sent to logs.
            item.postitDraft={requestId:item.requestId,proposalId:item.proposalId,documentId:doc.id,
              baseRevision:doc.revision,targetIds:ids,scopeText:referenceText,reaskedFromId:body.reaskedFromId??null,
              model,prompt:goal.trim(),rawContent:content};
            try{
              const postitReply=await read(docPath(scoped?doc.id:undefined,'/postits'),{
                method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(item.postitDraft),
              });
              if(postitReply.ok){
                const savedPostit=await postitReply.json();
                if(savedPostit?.postit?.id&&savedPostit.postit.requestId===item.requestId&&savedPostit.postit.proposalId===item.proposalId){item.postitId=savedPostit.postit.id;item.postitSave='saved';}
              }
            }catch{ /* Preserve the AI answer; the UI offers an idempotent retry. */ }
          }
          return item;
  }
  async function commitProposal(item) {
          const before=await document(item.scoped?item.documentId:undefined);
          if(before.id!==item.documentId || before.revision!==item.baseRevision || !before.blocks.some(b=>b.id===item.targetId)) {
            throw new ApiError(409,'REVISION_CONFLICT','문서가 바뀌어 이전 승인을 사용할 수 없습니다.');
          }
          const target=before.blocks.find(b=>b.id===item.targetId);
          if(item.mode==='patch' && (!isEditableParagraph(target) || blockHash(target)!==item.beforeHash))throw new ApiError(409,'EDIT_TARGET_CHANGED','대상 문단이 변경되어 승인할 수 없습니다.');
          const actor=('chatgpt-subscription '+item.model).replace(/[^a-zA-Z0-9가-힣_. -]/g,'_').slice(0,60);
          const payload={documentId:item.documentId,revision:item.baseRevision,actor,content:item.content,
            requestId:item.requestId,proposalId:item.proposalId,goal:item.goal,
            reason:item.reason,approval:'approved',type:'paragraph',afterId:item.targetId,
            ...(item.mode==='patch'?{edit:{model:item.model,documentId:item.documentId,blockId:item.targetId,baseRevision:item.baseRevision,beforeText:item.originalContent,afterText:item.content,beforeHash:item.beforeHash}}:{})};
          let saved;
          try {
            const reply=await read(docPath(item.scoped?item.documentId:undefined,'/blocks'+(item.mode==='patch'?'/'+encodeURIComponent(item.targetId):'')),{method:item.mode==='patch'?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
            if(!reply.ok){
              if(reply.status===409)throw new ApiError(409,'REVISION_CONFLICT','문서 변경 충돌로 저장되지 않았습니다.');
              throw Error('Commit response not confirmed');
            }
            saved=await reply.json();
          }catch(err){
            if(err instanceof ApiError)throw err;
            const error=new ApiError(503,'SAVE_UNCERTAIN','저장 결과가 불확실합니다. 자동 재시도하지 말고 영수증을 확인하세요.');
            error.requestId=item.requestId;throw error;
          }
          try{
            const receiptReply=await read(docPath(item.scoped?item.documentId:undefined,'/requests/'+encodeURIComponent(item.requestId)));
            const auditReply=await read(docPath(item.scoped?item.documentId:undefined,'/history'));
            if(!receiptReply.ok || !auditReply.ok)throw Error('verification unavailable');
            const receipt=await receiptReply.json(),history=await auditReply.json();
            const matches=history.events.filter(e=>e.idempotency?.requestId===item.requestId);
            if(receipt.outcome!=='COMMITTED'||receipt.revision!==saved.revision||matches.length!==1||
              matches[0].proposal?.proposalId!==item.proposalId || (item.mode==='patch' && (saved.block?.id!==item.targetId || matches[0].blockId!==item.targetId || matches[0].proposal?.edit?.documentId!==item.documentId || matches[0].proposal?.edit?.baseRevision!==item.baseRevision)))throw Error('verification mismatch');
          }catch{
            const error=new ApiError(503,'SAVE_UNCERTAIN','저장 요청 이후 검증이 불확실합니다. 재시도하지 말고 서버 기록을 확인하세요.');
            error.requestId=item.requestId;throw error;
          }
          return {saved:true,revision:saved.revision,receipt:'COMMITTED',auditRecords:1};
  }
  const requests=createAiRequests({prepare:prepareProposal,commit:commitProposal,document,
    canStart:()=>Boolean(session)&&!stopping&&!busy,timeoutMs:requestTimeoutMs,ttlMs:requestTtlMs,now:requestNow});

  const groups=createAiGroups({requests,commit:async(g,items)=>{
    const first=items[0],edits=items.map(i=>({model:i.model,documentId:i.documentId,blockId:i.targetId,baseRevision:i.baseRevision,beforeText:i.originalContent,afterText:i.content,beforeHash:i.beforeHash}));
    const payload={documentId:g.documentId,revision:g.baseRevision,actor:'ai-batch',requestId:g.id,proposalId:g.id,goal:first.goal,reason:'검토한 여러 문단 수정',approval:'approved',edits};
    try{
      const reply=await read(docPath(first.scoped?g.documentId:undefined,'/blocks'),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(reply.status===409)throw new ApiError(409,'GROUP_CHANGED','문서가 변경되어 다시 요청 필요');
      if(!reply.ok)throw Error('uncertain');const result=await reply.json();
      const receiptReply=await read(docPath(first.scoped?g.documentId:undefined,'/requests/'+g.id));
      const auditReply=await read(docPath(first.scoped?g.documentId:undefined,'/history'));
      if(!receiptReply.ok||!auditReply.ok)throw Error('uncertain');const receipt=await receiptReply.json(),audit=await auditReply.json();
      const matches=audit.events.filter(e=>e.idempotency?.requestId===g.id);
      if(receipt.outcome!=='COMMITTED'||receipt.revision!==result.revision||result.blockIds?.length!==items.length||!items.every(i=>result.blockIds.includes(i.targetId))||matches.length!==1||matches[0].proposal?.proposalId!==g.id||matches[0].proposal?.edits?.length!==items.length||!matches[0].proposal.edits.every(e=>e.documentId===g.documentId&&e.baseRevision===g.baseRevision&&items.some(i=>i.targetId===e.blockId&&i.model===e.model)))throw Error('uncertain');
      return {...result,saved:true,receipt:'COMMITTED'};
    }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,'SAVE_UNCERTAIN','저장 결과가 불확실합니다. 자동 재시도하지 않습니다.');}
  }});

  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    // No /panel API may be served through a LAN proxy or a DNS-rebinding host.
    const host='127.0.0.1:'+server.address()?.port;
    if(req.headers.host!==host) return json(res,403,{error:'로컬 호스트만 허용합니다.',code:'BAD_HOST'});
    const origin=req.headers.origin;
    if(!allowed.has(origin))return json(res,403,{error:'로컬 편집기에서만 호출할 수 있습니다.',code:'BAD_ORIGIN'});
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS'){
      res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','Content-Type');
      return res.writeHead(204).end();
    }
    checkSession();
    if(req.url?.startsWith('/panel/groups')){
      try{if(stopping)throw new ApiError(503,'SHUTTING_DOWN','종료 중입니다.');const u=new URL(req.url,'http://localhost');
        if(req.method==='POST'&&u.pathname==='/panel/groups')return json(res,202,groups.start(await readBody(req)));
        const m=u.pathname.match(/^\/panel\/groups\/([A-Za-z0-9._:-]+)(?:\/(cancel|approve))?$/);if(!m)throw new ApiError(404,'NOT_FOUND','요청을 찾을 수 없습니다.');
        if(req.method==='GET'&&!m[2])return json(res,200,await groups.get(m[1],u.searchParams.get('documentId')));
        if(req.method==='POST'&&m[2]){const b=await readBody(req);return json(res,200,m[2]==='cancel'?groups.cancel(m[1],b):await groups.approve(m[1],b));}
        throw new ApiError(405,'METHOD_NOT_ALLOWED','지원하지 않는 요청입니다.');
      }catch(e){return json(res,e.status??502,{error:e.status?e.message:'AI 요청 실패',code:e.code??'AI_REQUEST_FAILED'});}
    }
    if(req.url?.startsWith('/panel/requests')) {
      try {
        if(stopping)throw new ApiError(503,'SHUTTING_DOWN','AI 실행부가 종료 중입니다.');
        const url=new URL(req.url,'http://localhost');
        if(req.method==='GET' && url.pathname==='/panel/requests')return json(res,200,{requests:await requests.list(url.searchParams.get('documentId'))});
        if(req.method==='POST' && url.pathname==='/panel/requests')return json(res,202,requests.start(await readBody(req)));
        const match=url.pathname.match(/^\/panel\/requests\/([A-Za-z0-9._:-]+)(?:\/(cancel|approve))?$/);
        if(!match)throw new ApiError(404,'NOT_FOUND','요청 경로를 찾을 수 없습니다.');
        if(req.method==='GET'&&!match[2])return json(res,200,await requests.get(match[1],url.searchParams.get('documentId')));
        if(req.method==='POST'&&match[2]){
          const body=await readBody(req);
          return json(res,200,match[2]==='cancel'?requests.cancel(match[1],body):await requests.approve(match[1],body));
        }
        throw new ApiError(405,'METHOD_NOT_ALLOWED','지원하지 않는 요청입니다.');
      }catch(error){return json(res,error.status??502,{error:error.status?error.message:'AI 요청 실패',code:error.code??'AI_REQUEST_FAILED',...(error.requestId?{requestId:error.requestId}:{})});}
    }
    if(req.method==='GET'&&req.url==='/panel/status'){
      return json(res,200,{connected:Boolean(session),busy,hasProposal:Boolean(pending),mode:'memory-only',connection:publicConnection()});
    }
    if(req.method==='GET'&&req.url==='/panel/proposal'){
      if(pending&&Date.now()-pending.createdAt>PROPOSAL_TTL_MS)pending=null;
      const p=pending;
      return json(res,200,{proposal:p?{proposalId:p.proposalId,model:p.model,
        documentId:p.documentId,baseRevision:p.baseRevision,targetId:p.targetId,mode:p.mode,originalContent:p.originalContent,content:p.content,reason:p.reason}:null});
    }
    try {
      if(stopping)throw new ApiError(503,'SHUTTING_DOWN','AI 실행부가 종료 중입니다.');
      if(req.method==='GET'&&req.url==='/panel/models'){
        if(!session)throw new ApiError(409,'NOT_CONNECTED','먼저 ChatGPT를 연결하세요.');
        if(busy)throw new ApiError(409,'BUSY','다른 작업이 진행 중입니다.');
        busy='models';
        try {catalog=await listModels({bearer:session.bearer()});return json(res,200,{models:catalog});}
        finally {busy=null;}
      }
      if(req.method!=='POST' || !['/panel/connect','/panel/connect/cancel','/panel/preview','/panel/approve','/panel/reject','/panel/disconnect'].includes(req.url)){
        return json(res,404,{error:'지원하지 않는 경로입니다.',code:'NOT_FOUND'});
      }
      const body=await readBody(req);
      if(req.url==='/panel/connect/cancel'){
        if(body.attemptId!==connection.attemptId||!cancelConnection())throw new ApiError(409,'CONNECT_CHANGED','연결 상태가 바뀌었어요. 상태를 다시 확인하세요.');
        return json(res,200,{connected:false,connection:publicConnection()});
      }
      if(busy)throw new ApiError(409,'BUSY','다른 작업이 진행 중입니다.');
      if(req.url==='/panel/connect'){
        if(session)return json(res,200,{connected:true,connection:publicConnection()});
        if(body.background!==undefined&&typeof body.background!=='boolean')throw new ApiError(400,'INVALID_REQUEST','연결 요청을 확인하세요.');
        const started=beginConnection();
        // Modern UI receives a short ACK and polls /status. Legacy local callers
        // retain their synchronous contract, using the very same single attempt.
        if(body.background)return json(res,202,{connected:false,connection:publicConnection()});
        await started.task;
        if(attempt?.id!==started.id||!session)throw new ApiError(409,'CONNECT_INCOMPLETE','연결하지 못했어요. 연결 상태를 확인한 뒤 다시 시도하세요.');
        return json(res,200,{connected:true,connection:publicConnection()});
      }
      if(req.url==='/panel/disconnect'){
        if(requests.approving())throw new ApiError(409,'BUSY','승인 저장을 확인한 뒤 연결을 해제하세요.');
        requests.invalidate();
        busy='disconnecting';
        const active=session; session=null; catalog=[]; pending=null;
        connection={phase:'idle',attemptId:null,errorCode:null};
        try {if(active)await active.close();return json(res,200,{connected:false});}
        finally {busy=null;}
      }
      if(req.url==='/panel/reject'){
        if(pending && body.documentId && pending.documentId!==body.documentId)throw new ApiError(409,'DOCUMENT_ID_MISMATCH','문서 ID가 다릅니다.');
        if(body.proposalId && body.proposalId!==pending?.proposalId)throw new ApiError(409,'NO_PROPOSAL','거절할 제안이 변경되었습니다.');
        pending=null;
        return json(res,200,{rejected:true});
      }
      if(!session)throw new ApiError(409,'NOT_CONNECTED','먼저 ChatGPT를 연결하세요.');
      if(req.url==='/panel/preview'){
        if(pending)throw new ApiError(409,'PROPOSAL_PENDING','기존 제안을 먼저 승인하거나 거절하세요.');
        busy='proposing';
        try {pending=await prepareProposal(body);return json(res,200,publicProposal(pending));}
        finally {busy=null;}
      }
      if(req.url==='/panel/approve'){
        if(!pending || body.proposalId!==pending.proposalId)throw new ApiError(409,'NO_PROPOSAL','승인할 제안이 없습니다.');
        if(Date.now()-pending.createdAt>PROPOSAL_TTL_MS){pending=null;throw new ApiError(409,'EXPIRED','제안이 만료됐습니다. 다시 생성하세요.');}
        if((pending.scoped || pending.mode==='patch') && (body.documentId!==pending.documentId || body.baseRevision!==pending.baseRevision || (pending.mode==='patch' && body.targetId!==pending.targetId)))throw new ApiError(409,'DOCUMENT_ID_MISMATCH','승인 문서 ID 또는 기준 Revision이 다릅니다.');
        busy='approving';const item=pending;pending=null;
        try {return json(res,200,await commitProposal(item));} finally {busy=null;}
      }

    }catch(error){
      const status=error instanceof ApiError?error.status:502;
      const code=error instanceof ApiError?error.code:'PANEL_OPERATION_FAILED';
      // Never serialize native fetch/spawn errors or token-bearing URLs to clients.
      return json(res,status,{error:error instanceof ApiError?error.message:'요청 실패. Termux에서 실행부 상태를 확인하세요.',code,
        ...(error instanceof ApiError&&error.requestId?{requestId:error.requestId}:{})});
    }
  });
  // Explicit, awaitable shutdown makes best-effort OAuth revocation finish
  // before the CLI process exits. A direct server.close() still clears memory.
  server.shutdown=()=>{
    if(shutdown)return shutdown;
    stopping=true;cancelConnection();requests.invalidate(true);lifetime.abort();
    const active=session;session=null;catalog=[];pending=null;
    shutdown=(async()=>{
      await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
      await Promise.allSettled([...connectionTasks]);
      if(active)await active.close();
    })();
    return shutdown;
  };
  server.on('close',()=>{
    stopping=true;cancelConnection();requests.invalidate(true);lifetime.abort();
    const active=session;session=null;pending=null;catalog=[];
    if(active)void active.close().catch(()=>{});
  });
  return server;
}

if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){
  const port=Number(process.env.AI_PANEL_PORT||8788);
  const followup=process.env.LAB_B09_FOLLOWUP==='1';
  const b09=process.env.LAB_B09_ISOLATED==='1';
  const b06=process.env.LAB_B06_ISOLATED==='1';
  if([followup,b09,b06].filter(Boolean).length>1)throw Error('격리 모드는 하나만 선택하세요.');
  const isolated=followup||b09||b06;
  const authDir=followup?process.env.LAB_B09_FOLLOWUP_AUTH_DIR:b09?process.env.LAB_B09_AUTH_DIR:process.env.LAB_B06_AUTH_DIR;
  if(isolated){
    const root=join(homedir(),followup?'blocknote-b09-followup':b09?'blocknote-b09':'blocknote-argon-b06'),auth=join(root,'auth');
    if(port!==(followup?38788:b09?28788:18788)||!authDir||resolve(authDir)!==resolve(auth)||lstatSync(root).isSymbolicLink()||lstatSync(auth).isSymbolicLink()||realpathSync(auth)!==join(realpathSync(root),'auth'))throw Error('B06 인증 격리 경로를 확인하세요.');
    for(const name of ['host.json','registration.json','subscription.json']){try{const entry=lstatSync(join(auth,name));if(entry.isSymbolicLink()||!entry.isFile()||entry.nlink!==1)throw Error('B06 인증 파일이 안전하지 않습니다.');}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  const server=isolated?createAiPanelServer({
    documentBase:`http://127.0.0.1:${followup?38787:b09?28787:18787}`,allowedOrigins:[`http://127.0.0.1:${followup?35173:b09?25173:15173}`,`http://localhost:${followup?35173:b09?25173:15173}`],
    connect:options=>connectEphemeral({...options,dir:authDir}),
  }):createAiPanelServer();
  server.listen(port,'127.0.0.1',()=>console.log('BlockNote AI panel local only: http://127.0.0.1:'+port));
  for(const event of ['SIGINT','SIGTERM']){
    process.once(event,()=>{void server.shutdown().then(()=>process.exit(0),()=>process.exit(1));});
  }
}

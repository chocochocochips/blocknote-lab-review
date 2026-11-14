import {createCloudAi} from './cloud-ai.mjs';
/** F06-01: one private HTTPS gateway; no imports of OAuth/provider/launcher code. */
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFileSync,statSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,join,extname,relative} from 'node:path';
import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {createWorkspaceHandler,openWorkspace} from './workspace.mjs';
import {LIMITS,RequestError} from './validation.mjs';

const COOKIE='__Host-blocknote-test';
const SESSION_MS=8*60*60*1000, PROPOSAL_MS=10*60*1000;
const fail=(status,code)=>{throw new RequestError(status,code,'시험 요청을 처리하지 못했습니다.');};
const digest=s=>createHash('sha256').update(s).digest();
const same=(a,b)=>timingSafeEqual(digest(a),digest(b));
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const replay=(req,body)=>Object.assign(Readable.from(body.length?[body]:[]),{method:req.method,url:req.url,headers:req.headers});
const loginPage=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BlockNote 합성 시험실</title><h1>BlockNote 비공개 시험실</h1><p>합성 자료만 사용하세요. 재시작하면 시험 내용이 초기화됩니다.</p><form action="/login" method="post"><label>시험실 비밀번호 <input type="password" name="password" required autocomplete="current-password" maxlength="256"></label><button>입장</button></form></html>`;
async function bodyBytes(req,max=LIMITS.requestBytes){
 const size=Number(req.headers['content-length']);if(size>max)fail(413,'PAYLOAD_TOO_LARGE');
 let n=0,parts=[];for await(const part of req){n+=part.length;if(n>max)fail(413,'PAYLOAD_TOO_LARGE');parts.push(part);}return Buffer.concat(parts);
}
function objectBody(bytes){try{const b=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!b||Array.isArray(b)||typeof b!=='object')throw Error();return b;}catch{fail(400,'BAD_JSON');}}
function diskBytes(root){let total=0;for(const name of readdirSync(root)){const p=join(root,name),s=lstatSync(p);if(s.isSymbolicLink())fail(503,'UNSAFE_STORE');total+=s.isDirectory()?diskBytes(p):s.size;}return total;}
export function validateCloudConfig({password,publicOrigin='',synthetic,trustProxy}){
 if(synthetic!=='RESET_ON_START')throw Error('Explicit synthetic reset permission is required');
 if(typeof password!=='string'||password.length<32||password.length>256||/[\x00-\x20\x7f]/.test(password))throw Error('A separate random test password of 32-256 characters is required');
 if(trustProxy!==true)throw Error('HTTPS ingress proxy trust must be explicitly enabled');
 if(publicOrigin){let u;try{u=new URL(publicOrigin);}catch{throw Error('Invalid public origin');}if(u.protocol!=='https:'||u.origin!==publicOrigin||u.username||u.password)throw Error('Use one exact HTTPS origin without a path');}
}
/** root is created exclusively by cloud-start, never a local-data environment path. */
export function createCloudApp({root,dist,password,publicOrigin='',synthetic,trustProxy,now=Date.now,requestLimit=600,loginLimit=20,sessionMs=SESSION_MS}){
 validateCloudConfig({password,publicOrigin,synthetic,trustProxy});
 const workspace=openWorkspace(root),handler=createWorkspaceHandler({root,workspace});
 dist=resolve(dist);if(!statSync(join(dist,'index.html')).isFile()||!readFileSync(join(dist,'index.html'),'utf8').includes('name="blocknote-cloud-test"'))throw Error('Synthetic production UI build missing');
 let windowStart=now(),requests=0,logins=0;const sessions=new Map();
 const sessionOf=req=>{const m=(req.headers.cookie||'').match(/(?:^|;\s*)__Host-blocknote-test=([A-Za-z0-9_-]{43})(?:;|$)/);return m?sessions.get(digest(m[1]).toString('hex')):null;};
 const internal=async(path,method='GET',body)=>{
  let status,result;const res={writeHead(s){status=s;},end(text){result=JSON.parse(text);}};
  await handler(Object.assign(Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]),{url:path,method,headers:{}}),res);
  if(status>=400)fail(status,result.code||'DOCUMENT_REQUEST_FAILED');return result;
 };
 const pathFor=(id,suffix)=>'/api/documents/'+encodeURIComponent(id)+suffix;
 const panel=async(req,res,session,body)=>{
  const path=req.url;
  if(path.startsWith('/panel/requests')||path.startsWith('/panel/groups')){
   session.ai??=createCloudAi({session,internal,now});return await session.ai.handle(req,res,body);
  }
  if(session.pending&&now()-session.pending.createdAt>PROPOSAL_MS)session.pending=null;
  if(req.method==='GET'&&path==='/panel/status')return send(res,200,{connected:session.connected,busy:null,hasProposal:Boolean(session.pending),mode:'synthetic-only'});
  if(req.method==='GET'&&path==='/panel/models')return send(res,200,{models:[{slug:'synthetic-test',name:'합성 시험 응답'}]});
  if(req.method==='GET'&&path==='/panel/proposal')return send(res,200,{proposal:session.pending});
  if(req.method!=='POST')fail(404,'NOT_FOUND');
  if(path==='/panel/connect'){session.connected=true;return send(res,200,{connected:true,mode:'synthetic-only'});}
  if(path==='/panel/disconnect'){session.ai?.close();session.ai=null;session.connected=false;session.pending=null;return send(res,200,{connected:false});}
  if(path==='/panel/reject'){
   if(session.pending&&body.documentId!==session.pending.documentId)fail(409,'DOCUMENT_ID_MISMATCH');
   session.pending=null;return send(res,200,{rejected:true});
  }
  if(!session.connected)fail(409,'NOT_CONNECTED');
  if(path==='/panel/preview'){
   if(session.pending)fail(409,'PROPOSAL_PENDING');
   if(body.model!=='synthetic-test'||typeof body.goal!=='string'||!body.goal.trim()||body.goal.length>240||/[\x00-\x1f\x7f]/.test(body.goal)||typeof body.documentId!=='string')fail(400,'INVALID_REQUEST');
   const meta=workspace.metadata(body.documentId);if(meta.archived)fail(409,'DOCUMENT_ARCHIVED');
   const doc=await internal(pathFor(body.documentId,'/document'));
   if(body.baseRevision!==doc.revision)fail(409,'REVISION_CONFLICT');
   if(!doc.blocks.some(b=>b.id===body.targetId))fail(409,'TARGET_CHANGED');
   session.pending={proposalId:'synthetic-'+randomUUID(),requestId:'synthetic:'+randomUUID(),documentId:doc.id,baseRevision:doc.revision,targetId:body.targetId,model:'synthetic-test',goal:body.goal.trim(),content:'[합성 AI 시험] '+body.goal.trim()+' · 실제 모델 호출 없이 생성한 검토 의견입니다.',reason:'문서 격리와 승인 저장 동작을 확인하는 합성 응답입니다.',createdAt:now()};
   return send(res,200,session.pending);
  }
  if(path==='/panel/approve'){
   const p=session.pending;
   if(!p||body.proposalId!==p.proposalId)fail(409,'NO_PROPOSAL');
   if(body.documentId!==p.documentId||body.baseRevision!==p.baseRevision)fail(409,'DOCUMENT_ID_MISMATCH');
   session.pending=null; // one-shot: a lost reply never automatically repeats a commit
   const saved=await internal(pathFor(p.documentId,'/blocks'),'POST',{documentId:p.documentId,revision:p.baseRevision,actor:'synthetic AI',content:p.content,requestId:p.requestId,proposalId:p.proposalId,goal:p.goal,reason:p.reason,approval:'approved',type:'paragraph',afterId:p.targetId});
   const receipt=await internal(pathFor(p.documentId,'/requests/'+encodeURIComponent(p.requestId)));
   const audit=await internal(pathFor(p.documentId,'/history'));
   if(receipt.outcome!=='COMMITTED'||receipt.revision!==saved.revision||audit.events.filter(e=>e.idempotency?.requestId===p.requestId&&e.proposal?.proposalId===p.proposalId).length!==1)fail(503,'SAVE_UNCERTAIN');
   return send(res,200,{saved:true,revision:saved.revision,receipt:'COMMITTED',auditRecords:1});
  }
  fail(404,'NOT_FOUND');
 };
 const server=createServer(async(req,res)=>{
  // Native form POSTs under no-referrer send Origin:null, including same-origin
  // login. Preserve same-origin provenance without sending referrers off-site.
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Strict-Transport-Security','max-age=31536000');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  try{
   // Public liveness endpoint exposes neither data nor configuration. Cloudtype
   // probes internal HTTP; this is the sole authentication/HTTPS exception.
   if(req.url==='/healthz'&&['GET','HEAD'].includes(req.method)){res.writeHead(200,{'Content-Type':'text/plain'});return res.end(req.method==='HEAD'?undefined:'ok');}
   if(now()-windowStart>=60000){windowStart=now();requests=0;logins=0;}
   if(++requests>requestLimit){res.setHeader('Retry-After','60');fail(429,'RATE_LIMITED');}
   for(const [key,s] of sessions)if(s.expires<=now()){s.ai?.close();sessions.delete(key);}
   if(!publicOrigin)fail(503,'PUBLIC_ORIGIN_REQUIRED');
   const expected=new URL(publicOrigin);
   if(req.headers.host!==expected.host||(req.headers['x-forwarded-host']&&req.headers['x-forwarded-host']!==expected.host))fail(403,'BAD_HOST');
   // Trust only the configured HTTPS ingress, never X-Forwarded-For for limits.
   if(req.headers['x-forwarded-proto']!=='https')fail(403,'HTTPS_REQUIRED');
   if(req.headers.origin&&req.headers.origin!==publicOrigin)fail(403,'BAD_ORIGIN');
   if(req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site']))fail(403,'BAD_FETCH_SITE');
   if(!['GET','HEAD','POST','PUT','PATCH'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED');
   const write=!['GET','HEAD'].includes(req.method);
   if(write&&req.headers.origin!==publicOrigin)fail(403,'ORIGIN_REQUIRED');
   // Reject ambiguous/encoded routes before URL normalization or static lookup.
   if(!/^\/[A-Za-z0-9/_:.-]*(?:\?[^#]*)?$/.test(req.url)||req.url.split('?')[0].split('/').some(p=>p==='.'||p==='..')||req.url.startsWith('//'))fail(400,'BAD_PATH');
   if(req.url==='/login'&&req.method==='POST'){
    if(++logins>loginLimit){res.setHeader('Retry-After','60');fail(429,'LOGIN_RATE_LIMITED');}
    if(req.headers['content-type']!=='application/x-www-form-urlencoded')fail(415,'FORM_REQUIRED');
    const values=new URLSearchParams((await bodyBytes(req,1024)).toString('utf8'));
    if(!same(values.get('password')||'',password))fail(401,'AUTH_FAILED');
    if(sessions.size>=16)fail(429,'SESSION_LIMIT');
    const token=randomBytes(32).toString('base64url');sessions.set(digest(token).toString('hex'),{expires:now()+sessionMs,connected:false,pending:null});
    res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(sessionMs/1000)}`);
    res.writeHead(303,{Location:'/'});return res.end();
   }
   const session=sessionOf(req);
   if(!session){
    if(req.method==='GET'&&['/','/login'].includes(req.url)){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(loginPage);}
    fail(401,'AUTH_REQUIRED');
   }
   if(req.url==='/logout'&&req.method==='POST'){
    for(const [k,v]of sessions)if(v===session){v.ai?.close();sessions.delete(k);}
    res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);res.writeHead(303,{Location:'/'});return res.end();
   }
   let bytes=Buffer.alloc(0),body;
   if(write){
    // logout/form handling above is intentionally separate from JSON APIs.
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))fail(415,'JSON_REQUIRED');
    bytes=await bodyBytes(req,req.url.startsWith('/panel/')?16384:LIMITS.requestBytes);body=objectBody(bytes);
    if(diskBytes(root)>64*1024*1024)fail(507,'TEST_STORAGE_LIMIT');
   }
   // The local single-owner postit store has no per-user cloud identity.
   if(/^\/api\/(?:postits(?:\/|\?|$)|documents\/[^/]+\/postits(?:\/|\?|$))/.test(req.url))fail(404,'NOT_FOUND');
   if(req.url.startsWith('/panel/'))return await panel(req,res,session,body);
   if(req.url==='/api/documents'&&req.method==='POST'&&workspace.list().length>=24)fail(409,'TEST_DOCUMENT_LIMIT');
   if(req.url==='/api/cloud-status'&&req.method==='GET')return send(res,200,{mode:'synthetic-only',resetPolicy:'every-process-start',persistent:false});
   // Only scoped document routes; local legacy aliases/auth/token routes closed.
   if(/^\/api\/documents(?:\/|$)/.test(req.url))return await handler(replay(req,bytes),res);
   if(req.method!=='GET'&&req.method!=='HEAD')fail(404,'NOT_FOUND');
   let file=req.url==='/'?'index.html':req.url.slice(1);
   if(file!=='index.html'&&!/^assets\/[A-Za-z0-9._-]+$/.test(file))fail(404,'NOT_FOUND');
   const full=resolve(dist,file);if(relative(dist,full).startsWith('..'))fail(404,'NOT_FOUND');
   let content;try{content=readFileSync(full);}catch{fail(404,'NOT_FOUND');}
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2'};
   res.writeHead(200,{'Content-Type':types[extname(full)]||'application/octet-stream'});return res.end(req.method==='HEAD'?undefined:content);
  }catch(e){
   // Deliberately omit native error message, stack, URL, body and header logging.
   if(!res.headersSent)send(res,e instanceof RequestError?e.status:503,{error:'시험 요청을 처리하지 못했습니다.',code:e instanceof RequestError?e.code:'TEST_SERVER_ERROR'});
   else res.end();
  }
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=50;
 server.on('close',()=>{for(const s of sessions.values())s.ai?.close();sessions.clear();});
 return server;
}

import test from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCloudApp,validateCloudConfig} from '../server/cloud-app.mjs';
import {createSyntheticWorkspace} from '../scripts/workspace-fixture.mjs';
import {verifyExport} from '../server/workspace.mjs';

const password='synthetic-test-password-00000000000000000',origin='https://private.test';
const config={password,publicOrigin:origin,synthetic:'RESET_ON_START',trustProxy:true};
async function fixture(run,options={}){
 const dir=mkdtempSync(join(tmpdir(),'f06-')),root=join(dir,'workspace'),dist=join(dir,'dist');
 createSyntheticWorkspace(root);mkdirSync(dist);mkdirSync(join(dist,'assets'));
 writeFileSync(join(dist,'index.html'),'<html><meta name="blocknote-cloud-test" content="synthetic-only"></html>');writeFileSync(join(dist,'assets','app.js'),'console.log("test")');
 let clock=1000;const server=createCloudApp({...config,root,dist,now:()=>clock,...options});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let cookie='';
 const call=async(path,method='GET',data,extra={})=>{
  const headers={host:'private.test','x-forwarded-proto':'https',...(cookie?{cookie}:{}),...(method==='GET'?{}:{origin}),...(data===undefined?{}:{'content-type':'application/json'}),...extra};
  return await new Promise((resolve,reject)=>{const req=request(base+path,{method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}const h=new Headers();for(const[k,v]of Object.entries(res.headers))if(v!==undefined)h.set(k,Array.isArray(v)?v.join('; '):v);resolve({status:res.statusCode,data:body,headers:h});});});req.on('error',reject);req.end(data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data));});
 };
 const login=async()=>{const r=await call('/login','POST',new URLSearchParams({password}).toString(),{'content-type':'application/x-www-form-urlencoded'});assert.equal(r.status,303);cookie=r.headers.get('set-cookie').split(';')[0];return r;};
 const doc=(id,suffix='/document')=>'/api/documents/'+id+suffix;
 try{await run({dir,root,dist,server,call,login,doc,clearCookie:()=>{cookie='';},setCookie:v=>{cookie=v;},advance:n=>{clock+=n;}});}
 finally{await new Promise(r=>{server.close(r);server.closeAllConnections();});rmSync(dir,{recursive:true,force:true});}
}
test('cloud config fails closed without explicit synthetic permission, long password or HTTPS trust',()=>{
 for(const opts of [{synthetic:undefined},{password:'short'},{password:undefined},{publicOrigin:'http://test'},{publicOrigin:origin+'/'},{trustProxy:false}])assert.throws(()=>validateCloudConfig({...config,...opts}));
 assert.doesNotThrow(()=>validateCloudConfig(config));
});
test('bootstrap permits only health; unknown public origin never exposes login, UI or documents',()=>fixture(async({call})=>{
 assert.equal((await call('/healthz')).status,200);
 for(const p of ['/','/api/documents','/panel/status','/assets/app.js'])assert.equal((await call(p)).status,503);
},{publicOrigin:''}));
test('unauthenticated gateway blocks API, panel, exports, static files and crafted cookies',()=>fixture(async({call,setCookie})=>{
 assert.equal((await call('/healthz','GET',undefined,{host:'internal'})).status,200);
 assert.match((await call('/')).data,/시험실 비밀번호/);
 for(const c of ['', '__Host-blocknote-test='+ 'A'.repeat(43), 'blocknote-test=fake']){
  setCookie(c);for(const p of ['/api/documents','/api/documents/f05-synthetic-rev7/document','/api/documents/f05-synthetic-rev7/export','/panel/status','/panel/models','/assets/app.js','/api/document'])assert.equal((await call(p)).status,401,p);
 }
 for(const method of ['POST','PUT','PATCH'])assert.equal((await call('/api/documents',method,{title:'bad'})).status,401);
}));
test('Host, HTTPS, Origin, fetch-site and CORS checks cannot be bypassed using forwarding headers',()=>fixture(async({call,login})=>{
 await login();for(const h of [{host:'evil.test'},{'x-forwarded-host':'evil.test'},{'x-forwarded-proto':'http'},{'x-forwarded-proto':'https,http'},{origin:'https://evil.test'},{origin:'null'},{'sec-fetch-site':'cross-site'}])assert.equal((await call('/api/documents','GET',undefined,h)).status,403);
 for(const h of [{origin:''},{origin:'https://evil.test'},{origin:'null'}])assert.equal((await call('/api/documents','POST',{title:'bad'},h)).status,403);
 const preflight=await call('/api/documents','OPTIONS',undefined,{'access-control-request-method':'POST',origin:'https://evil.test'});assert.equal(preflight.status,403);assert.equal(preflight.headers.get('access-control-allow-origin'),null);
}));
test('native login form preserves same-origin provenance while null and foreign origins stay blocked',()=>fixture(async({call,setCookie})=>{
 const page=await call('/');assert.equal(page.status,200);
 // Fetch Standard: no-referrer turns a native form POST Origin into null.
 // same-origin retains the real Origin for this form and sends no off-site referrer.
 assert.equal(page.headers.get('referrer-policy'),'same-origin');
 assert.match(page.data,/<form action="\/login" method="post">/);
 const form=new URLSearchParams({password}).toString();
 for(const badOrigin of ['null','https://evil.test','']){
  const r=await call('/login','POST',form,{'content-type':'application/x-www-form-urlencoded',origin:badOrigin,'sec-fetch-site':'same-origin'});
  assert.equal(r.status,403);assert.equal(r.headers.get('set-cookie'),null);
 }
 assert.equal((await call('/api/documents')).status,401);
 const r=await call('/login','POST',form,{'content-type':'application/x-www-form-urlencoded','sec-fetch-site':'same-origin'});
 assert.equal(r.status,303);setCookie(r.headers.get('set-cookie').split(';')[0]);
 assert.equal((await call('/api/documents')).status,200);
}));
test('secure session cookie, sanitized login failure, expiry and logout revoke access',()=>fixture(async({call,login,advance})=>{
 const bad=await call('/login','POST','password=do-not-echo-secret',{'content-type':'application/x-www-form-urlencoded'});assert.equal(bad.status,401);assert.doesNotMatch(JSON.stringify(bad.data),/do-not-echo-secret/);
 const r=await login();for(const x of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.match(r.headers.get('set-cookie'),new RegExp(x));
 assert.equal((await call('/api/documents')).status,200);advance(8*60*60*1000+1);assert.equal((await call('/api/documents')).status,401);
 await login();assert.equal((await call('/logout','POST')).status,303);assert.equal((await call('/api/documents')).status,401);
}));
test('all real OAuth, token, local bridge and provider routes are unavailable',()=>fixture(async({call,login})=>{
 await login();for(const p of ['/auth/start','/auth/callback','/oauth/token','/api/auth','/api/document','/api/blocks','/panel/oauth','/panel/token']){
  const r=await call(p);assert.equal(r.status,404,p);assert.doesNotMatch(JSON.stringify(r.data),/Bearer|token=|\/tmp\/|stack/);
 }
 const r=await call('/panel/connect','POST',{});assert.equal(r.data.mode,'synthetic-only');
 assert.deepEqual((await call('/panel/models')).data.models.map(m=>m.slug),['synthetic-test']);
}));
test('request byte limits, JSON type and shape errors leave the document untouched',()=>fixture(async({call,login,root})=>{
 await login();const p=join(root,'documents/f05-synthetic-rev7/document.json'),before=readFileSync(p,'utf8');
 assert.equal((await call('/api/documents','POST',{title:'x'},{'content-type':'text/plain'})).status,415);
 for(const bad of ['null','[]','"x"','{bad'])assert.equal((await call('/api/documents','POST',bad)).status,400);
 assert.equal((await call('/api/documents','POST',{title:'x'.repeat(1_000_001)})).status,413);
 assert.equal((await call('/panel/preview','POST',{goal:'x'.repeat(17_000)})).status,413);
 assert.equal(readFileSync(p,'utf8'),before);
}));
test('global request/login throttles ignore spoofed client IP and recover after the window',()=>fixture(async({call,advance})=>{
 for(let n=0;n<2;n++)assert.equal((await call('/login','POST','password=bad',{'content-type':'application/x-www-form-urlencoded','x-forwarded-for':String(n)})).status,401);
 assert.equal((await call('/login','POST','password=bad',{'content-type':'application/x-www-form-urlencoded','x-forwarded-for':'different'})).status,429);
 advance(60001);assert.equal((await call('/login','POST','password=bad',{'content-type':'application/x-www-form-urlencoded'})).status,401);
},{loginLimit:2}));
test('global rate cap includes unauthorized requests',()=>fixture(async({call,advance})=>{
 assert.equal((await call('/api/documents')).status,401);assert.equal((await call('/api/documents')).status,401);assert.equal((await call('/api/documents')).status,429);advance(60001);assert.equal((await call('/api/documents')).status,401);
},{requestLimit:2}));
test('production static UI requires authentication and sends restrictive security headers',()=>fixture(async({call,login})=>{
 await login();for(const p of ['/','/assets/app.js']){
  const r=await call(p);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);assert.match(r.headers.get('strict-transport-security'),/max-age/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('cache-control'),'no-store');
 }
 for(const p of ['/server/cloud-app.mjs','/.env','/data/document.json','/scripts/siwc-auth.mjs','//api/documents','/assets/%2e%2e%2fserver'])assert.ok((await call(p)).status>=400,p);
}));
test('cloud document lifecycle, isolated revisions, stale requests and complete export',()=>fixture(async({call,login,doc})=>{
 await login();const a=(await call('/api/documents','POST',{title:'A'})).data,b=(await call('/api/documents','POST',{title:'B'})).data;
 for(const item of [a,b])assert.equal((await call(doc(item.id,'/blocks'),'POST',{documentId:item.id,revision:1,content:item.title})).status,201);
 assert.equal((await call(doc(a.id,'/blocks'),'POST',{documentId:a.id,revision:1,content:'stale'})).status,409);
 assert.equal((await call(doc(b.id,'/blocks'),'POST',{documentId:a.id,revision:2,content:'mixed'})).status,409);
 assert.equal((await call('/api/documents/'+a.id,'PATCH',{metadataVersion:1,title:'renamed'})).status,200);
 assert.equal((await call('/api/documents/'+a.id,'PATCH',{metadataVersion:2,archived:true})).status,200);
 assert.equal((await call(doc(a.id,'/blocks'),'POST',{documentId:a.id,revision:2,content:'bad'})).status,409);
 assert.equal((await call('/api/documents/'+a.id,'PATCH',{metadataVersion:3,archived:false})).status,200);
 const exp=(await call(doc(a.id,'/export'))).data;const verified=verifyExport(exp);assert.equal(verified.doc.revision,2);assert.equal(verified.events.length,1);
 const bd=(await call(doc(b.id))).data;assert.equal(bd.blocks.at(-1).content[0].text,'B');assert.equal(bd.revision,2);assert.doesNotMatch(JSON.stringify(exp),new RegExp(password));
}));
test('synthetic preview never writes before approval; cross-document and repeated approvals fail',()=>fixture(async({call,login,doc})=>{
 await login();await call('/panel/connect','POST',{});const a=(await call('/api/documents','POST',{title:'A'})).data,b=(await call('/api/documents','POST',{title:'B'})).data,d=(await call(doc(a.id))).data;
 const p=await call('/panel/preview','POST',{model:'synthetic-test',goal:'검토',documentId:a.id,baseRevision:1,targetId:d.blocks[0].id});assert.equal(p.status,200);assert.match(p.data.content,/합성/);assert.equal((await call(doc(a.id))).data.revision,1);
 const body={proposalId:p.data.proposalId,documentId:a.id,baseRevision:1};assert.equal((await call('/panel/approve','POST',{...body,documentId:b.id})).status,409);
 const approved=await call('/panel/approve','POST',body);assert.equal(approved.status,200);assert.equal(approved.data.receipt,'COMMITTED');assert.equal((await call('/panel/approve','POST',body)).status,409);assert.equal((await call(doc(b.id))).data.revision,1);
 assert.equal((await call(doc(a.id,'/history'))).data.events.length,1);
}));
for(const change of ['edit','archive','expire'])test('proposal invalidated after '+change,()=>fixture(async({call,login,doc,advance})=>{
 await login();await call('/panel/connect','POST',{});const a=(await call('/api/documents','POST',{title:'A'})).data,d=(await call(doc(a.id))).data;
 const p=(await call('/panel/preview','POST',{model:'synthetic-test',goal:'test',documentId:a.id,baseRevision:1,targetId:d.blocks[0].id})).data;
 if(change==='edit')await call(doc(a.id,'/blocks'),'POST',{documentId:a.id,revision:1,content:'edited'});
 if(change==='archive')await call('/api/documents/'+a.id,'PATCH',{metadataVersion:1,archived:true});
 if(change==='expire')advance(10*60*1000+1);
 assert.equal((await call('/panel/approve','POST',{proposalId:p.proposalId,documentId:a.id,baseRevision:1})).status,409);
}));
test('fixture import is side-effect free; explicit new datasets reset independently without overwriting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'f06-reset-'));try{
  const a=join(dir,'boot-a'),b=join(dir,'boot-b');createSyntheticWorkspace(a);const path=join(a,'documents/f05-synthetic-rev7/document.json');let d=JSON.parse(readFileSync(path));d.revision=8;writeFileSync(path,JSON.stringify(d));const before=readFileSync(path,'utf8');
  createSyntheticWorkspace(b);assert.equal(JSON.parse(readFileSync(join(b,'documents/f05-synthetic-rev7/document.json'))).revision,7);assert.throws(()=>createSyntheticWorkspace(a));assert.equal(readFileSync(path,'utf8'),before);assert.equal(existsSync(join(dir,'local-data')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Docker runtime allowlist contains no OAuth, external model, actual data or dependency runtime',()=>{
 const text=readFileSync(new URL('../Dockerfile',import.meta.url),'utf8').split('AS runtime')[1];assert.doesNotMatch(text,/COPY \.|siwc|provider|node_modules|data\//);assert.match(text,/USER node/);assert.match(text,/EXPOSE 8080/);
});
test('new local-only postit routes remain unavailable to authenticated or unauthenticated Cloudtype requests',()=>fixture(async({call,login})=>{
 const paths=['/api/postits','/api/documents/f05-synthetic-rev7/postits','/api/documents/f05-synthetic-rev7/postits/postit:fake'];
 for(const path of paths)assert.equal((await call(path)).status,401);
 await login();for(const path of paths){assert.equal((await call(path)).status,404);assert.equal((await call(path,'POST',{})).status,404);}
}));

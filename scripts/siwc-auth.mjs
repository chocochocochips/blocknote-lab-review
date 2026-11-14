/** Local-only Sign in with ChatGPT OAuth client for BlockNote Lab.
 * Uses the published OSS dynamic-agent flow. No API key, no ChatGPT backend-api,
 * no token is ever sent to BlockNote's document server or browser UI.
 * Test before using with personal accounts; one profile per local host in this prototype.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, rename, chmod, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DEFAULT_DIR = join(homedir(), '.config', 'blocknote-lab');
const APP_NAME = 'BlockNote Lab';

export const randomToken = () => randomBytes(32).toString('base64url');
export const pkceChallenge = verifier => createHash('sha256').update(verifier).digest('base64url');
export function authorizationURL({hostId, clientId='dynamic_agent_client', redirectUri, state, nonce, verifier}) {
  if (!/^urn:uuid:[\da-f-]{36}$/i.test(hostId)) throw Error('Invalid local host identifier');
  const uri = new URL(redirectUri);
  if (uri.hostname !== '127.0.0.1' || uri.protocol !== 'http:' || uri.pathname !== '/auth/callback') throw Error('Loopback callback required');
  const url = new URL(`${ISSUER}/api/accounts/authorize`);
  const params = {
    client_id:clientId, ext_agent_host_id:hostId, response_type:'code',
    redirect_uri:redirectUri, scope:SCOPE, resource:RESOURCE, state,nonce,
    code_challenge_method:'S256',code_challenge:pkceChallenge(verifier),
  };
  if (clientId === 'dynamic_agent_client') params.agent_name_hint = APP_NAME;
  for(const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  return url.toString();
}

function parseJWT(jwt){
  if (typeof jwt!=='string') throw Error('Missing identity token');
  const sections=jwt.split('.');
  if(sections.length!==3) throw Error('Invalid identity token');
  try{return {header:JSON.parse(Buffer.from(sections[0],'base64url').toString('utf8')),
    payload:JSON.parse(Buffer.from(sections[1],'base64url').toString('utf8')),
    data:Buffer.from(`${sections[0]}.${sections[1]}`),signature:Buffer.from(sections[2],'base64url')};}
  catch{throw Error('Invalid identity token encoding');}
}
export function verifyIdentityToken(jwt,{clientId,nonce,jwks,now=Math.floor(Date.now()/1000)}){
  const {header,payload,data,signature}=parseJWT(jwt);
  if(!['RS256','ES256'].includes(header.alg)||!header.kid||!Array.isArray(jwks?.keys))throw Error('Untrusted JWT algorithm or keys');
  const jwk=jwks.keys.find(k=>k.kid===header.kid && k.use!=='enc' && (k.alg===undefined||k.alg===header.alg));
  if(!jwk)throw Error('Signing key unavailable');
  const key=createPublicKey({key:jwk,format:'jwk'});
  const options=header.alg==='ES256'?{key,dsaEncoding:'ieee-p1363'}:key;
  if(!verifySignature('sha256',data,options,signature))throw Error('Invalid identity token signature');
  if(payload.iss!==ISSUER || ![payload.aud].flat().includes(clientId) || (nonce !== undefined && payload.nonce!==nonce) ||
    !Number.isSafeInteger(payload.exp) || payload.exp<=now ||
    (payload.nbf!==undefined && payload.nbf>now+5) ||
    (payload.iat!==undefined && payload.iat>now+5) ||
    typeof payload.sub!=='string' || !payload.sub)throw Error('Invalid identity claims');
  return {subject:payload.sub,email:typeof payload.email==='string'?payload.email:null,name:typeof payload.name==='string'?payload.name:null};
}

async function storageDir(dir=DEFAULT_DIR){
  const target=resolve(dir);
  await mkdir(target,{recursive:true,mode:0o700});
  await chmod(target,0o700);
  return target;
}
async function readJSON(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function privateWrite(path,obj){
  const temp=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temp,JSON.stringify(obj,null,2),{flag:'wx',mode:0o600});await chmod(temp,0o600);await rename(temp,path);}
  finally{try{await import('node:fs/promises').then(fs=>fs.unlink(temp));}catch{}}
}
export async function hostIdFor(dir=DEFAULT_DIR){
  const path=join(await storageDir(dir),'host.json');
  const existing=await readJSON(path);
  if(existing){if(!/^urn:uuid:[\da-f-]{36}$/i.test(existing.id))throw Error('Invalid saved host ID');return existing.id;}
  const id=`urn:uuid:${randomUUID()}`;
  await privateWrite(path,{id});return id;
}
/** Legacy persistent credential access is retired. Never read plaintext OAuth tokens. */
export async function readAccount(){throw Error('Plaintext OAuth credential storage was retired. Use a memory-only ChatGPT session.');}
export async function publicSession(){return {connected:false,sharing:false};}

export function startLoopbackCallback({state,timeoutMs=180000}){
  let resolveDone,rejectDone,closed=false;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const server=createServer((req,res)=>{
    const url=new URL(req.url??'/', 'http://127.0.0.1');
    if(url.pathname!=='/auth/callback'){res.writeHead(404).end('Not found');return;}
    if(url.searchParams.get('state')!==state){res.writeHead(400).end('Invalid state');return;}
    const error=url.searchParams.get('error');
    const code=url.searchParams.get('code');
    const clientId=url.searchParams.get('client_id');
    if(error || !code){res.writeHead(400).end('Authorization denied or incomplete');rejectDone(Error('Sign-in cancelled or denied'));}
    else{res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'}).end('BlockNote Lab: sign-in received. Return to the editor or terminal.');resolveDone({code,clientId});}
  });
  const start=(async()=>{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return `http://127.0.0.1:${server.address().port}/auth/callback`;
  })();
  const timer=setTimeout(()=>rejectDone(Error('Sign-in timed out')),timeoutMs);
  done.catch(()=>{}); // Prevent an unhandled rejection if launching the system browser fails.
  const close=async()=>{if(closed)return;closed=true;clearTimeout(timer);rejectDone(Error('Sign-in cancelled'));if(server.listening)await new Promise(resolve=>server.close(resolve));};
  const settled=done.finally(close);
  settled.catch(()=>{}); // The browser may fail before the caller awaits the callback.
  return {start,done:settled,close};
}

/** Android launches only this one-use loopback page, never the OAuth URL. */
export async function startAndroidBrowserBridge(authorization,{signal,timeoutMs=180000,onClose=()=>{}}={}){
  const fail=()=>Error('Could not open the system browser');
  try {
    const target=new URL(authorization);
    if(target.origin!==ISSUER || target.pathname!=='/api/accounts/authorize' || target.username || target.password || target.hash)throw fail();
  } catch { throw fail(); }
  if(signal?.aborted)throw fail();
  const path=`/sign-in/${randomToken()}`;
  let destination=authorization, used=false, timer, closing;
  const headers={
    'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  };
  const server=createServer((req,res)=>{
    for(const [key,value] of Object.entries(headers))res.setHeader(key,value);
    if(req.headers.host!==`127.0.0.1:${server.address()?.port}`){res.writeHead(403).end('Local host mismatch');return;}
    if(req.method!=='GET'){res.writeHead(405).end('Method not allowed');return;}
    if(req.url!==path && req.url!==`${path}/continue`){res.writeHead(404).end('Not found');return;}
    if(used || !destination){res.writeHead(410).end('Sign-in link expired');return;}
    if(req.url===path){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlockNote Lab 로그인</title><body style="font-family:sans-serif;padding:2rem;line-height:1.6"><h1>BlockNote Lab</h1><p>이 Chrome 탭에서 ChatGPT 로그인으로 이동합니다. 계정과 권한을 확인한 후 직접 동의해 주세요.</p><a href="${path}/continue" style="display:inline-block;padding:1rem;border:1px solid;border-radius:8px">ChatGPT로 로그인</a></body></html>`);
      return;
    }
    used=true;
    res.once('finish',()=>{void close();});
    res.once('close',()=>{void close();});
    res.writeHead(303,{Location:destination});
    destination=null;
    res.end();
  });
  const close=()=>{
    if(closing)return closing;
    destination=null;clearTimeout(timer);signal?.removeEventListener('abort',abort);
    try{onClose();}catch{}
    closing=new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
    return closing;
  };
  const abort=()=>{void close();};
  server.requestTimeout=10000;server.headersTimeout=10000;server.setTimeout(10000,socket=>socket.destroy());
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
    });
    server.on('error',abort);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)throw fail();
    timer=setTimeout(abort,timeoutMs);
    return {url:`http://127.0.0.1:${server.address().port}${path}`,close};
  } catch { await close();throw fail(); }
}

export async function openBrowser(url,{signal,launchSignal=signal,onLocalPage}={}){
  // URL has state/nonce and is sensitive. Do not log it or pass it to shell.
  const android=process.platform==='android'||process.env.PREFIX?.includes('com.termux');
  const manual=android&&typeof onLocalPage==='function';
  const publish=page=>{try{onLocalPage?.(page);}catch{}};
  const bridge=android?await startAndroidBrowserBridge(url,{signal,onClose:()=>publish(null)}):null;
  if(manual&&!signal?.aborted)publish(bridge.url);
  const command=process.platform==='darwin'?'open':android?'termux-open-url':'xdg-open';
  const launch=()=>new Promise((resolve,reject)=>{
      if(launchSignal?.aborted){reject(Error('Could not open the system browser'));return;}
      const child=spawn(command,[bridge?.url??url],{stdio:'ignore'});
      const abort=()=>{child.kill();reject(Error('Could not open the system browser'));};
      launchSignal?.addEventListener('abort',abort,{once:true});
      const cleanup=()=>{clearTimeout(timer);launchSignal?.removeEventListener('abort',abort);};
      const timer=android?setTimeout(()=>{child.kill();reject(Error('Could not open the system browser'));},30000):null;
      // Native errors may include spawnargs; expose only a fixed message.
      child.once('error',()=>{cleanup();reject(Error('Could not open the system browser'));});
      child.once('close',code=>{cleanup();code===0?resolve():reject(Error('Could not open the system browser'));});
      if(launchSignal?.aborted)abort();
    });
  // The panel can complete login by a real user click even if the native
  // utility fails, hangs, or reports success without opening a Chrome tab.
  // CLI callers retain the original awaited launch/failure behavior.
  if(manual){void launch().catch(()=>{});return bridge.close;}
  try {await launch();return bridge?.close;}
  catch {await bridge?.close();throw Error('Could not open the system browser');}
}
async function postToken(parameters,fetchImpl=fetch){
  const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(parameters),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`ChatGPT OAuth token request HTTP ${response.status}`);
  const body=await response.json();
  if(!body.access_token||!body.refresh_token||!body.id_token||!body.scope||!Number.isFinite(body.expires_in))throw Error('Incomplete OAuth token response');
  return body;
}
/** Disabled by design: v1.9 stored OAuth secrets in an unencrypted 0600 file. */
export async function signIn(){throw Error('Persistent OAuth login is disabled. Use connectEphemeral() from siwc-ephemeral.mjs.');}
export async function getBearer(){throw Error('Persistent OAuth credentials are disabled. Use a memory-only session.');}

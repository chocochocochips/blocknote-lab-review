/** F03-05D: session-only ChatGPT OAuth flow. No access/refresh/ID tokens on disk. */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile, mkdir, chmod, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  ISSUER, RESOURCE, TOKEN_URL, JWKS_URL, PLAN_SCOPE,
  randomToken, authorizationURL, startLoopbackCallback, verifyIdentityToken,
  hostIdFor, openBrowser,
} from './siwc-auth.mjs';

const DEFAULT_DIR = join(homedir(), '.config', 'blocknote-lab');
const REGISTRATION = 'registration.json';
const LEGACY = 'subscription.json';
const VALID_ID = /^[A-Za-z0-9._-]{3,200}$/;
const SECRET_PATTERN = /access_token|refresh_token|id_token|bearer|credentials|password/i;

async function secureDirectory(dir) {
  const target = resolve(dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  return target;
}
async function safeRead(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeRegistration(dir, obj) {
  const path = join(await secureDirectory(dir), REGISTRATION);
  if (Object.keys(obj).some(key => SECRET_PATTERN.test(key))) throw Error('Do not persist credentials');
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(obj, null, 2), { flag:'wx', mode:0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
export async function readRegistration(dir=DEFAULT_DIR) {
  const registration = await safeRead(join(await secureDirectory(dir), REGISTRATION));
  if (registration && (!VALID_ID.test(registration.clientId) || !registration.subject ||
      Object.keys(registration).some(key => SECRET_PATTERN.test(key)))) throw Error('Invalid registration metadata');
  return registration;
}
export async function assertNoLegacyCredentials(dir=DEFAULT_DIR) {
  // Never read or automatically migrate unencrypted tokens; require explicit user cleanup.
  try {
    await stat(join(await secureDirectory(dir), LEGACY));
    throw Error('Old plaintext subscription.json detected. Disconnect/revoke the old authorization and securely remove that file before using session-only login.');
  } catch(error) { if(error.code !== 'ENOENT') throw error; }
}
export async function revokeEphemeralSession({refreshToken,clientId,fetchImpl=fetch}) {
  // Discover only at the trusted issuer. Never follow credential-bearing redirects.
  try {
    const discovery=await fetchImpl(`${ISSUER}/.well-known/openid-configuration`,{redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!discovery.ok)return false;
    const config=await discovery.json();
    const endpoint=new URL(config.revocation_endpoint);
    if(config.issuer!==ISSUER || endpoint.origin!==ISSUER || endpoint.username || endpoint.password || endpoint.hash)return false;
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const result=await fetchImpl(endpoint.toString(),{method:'POST',redirect:'error',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({token:refreshToken,token_type_hint:'refresh_token',client_id:clientId}),
          signal:AbortSignal.timeout(10_000)});
        if(result.status===200)return true;
        if(result.status<500)return false;
      } catch {}
      if(attempt===0)await new Promise(resolve=>setTimeout(resolve,200));
    }
  } catch {}
  return false;
}
export async function connectEphemeral({ dir=DEFAULT_DIR, fetchImpl=fetch, browser=openBrowser, timeoutMs, signal, onProgress=()=>{}, onLoginPage,
  warn=message=>console.warn(message) } = {}) {
  if(signal?.aborted)throw Error('Sign-in cancelled');
  const progress=phase=>{try{onProgress(phase);}catch{}};
  const scopedSignal=ms=>signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);
  progress('starting');
  await assertNoLegacyCredentials(dir);
  const registered = await readRegistration(dir);
  const hostId = await hostIdFor(dir);
  const state = randomToken(), nonce=randomToken(), verifier=randomToken();
  const listener = startLoopbackCallback({state,timeoutMs});
  const cancel=()=>{void listener.start.then(()=>listener.close(),()=>listener.close());};
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const browserAbort=new AbortController();
  // Close the Android bridge even if the callback settles while opening Chrome.
  listener.done.then(()=>browserAbort.abort(),()=>browserAbort.abort());
  let browserCleanup;
  let accessToken=null, refreshToken=null, issuedClientId=null, closing=null;
  const close=()=>{
    accessToken=null;
    if(closing)return closing;
    const token=refreshToken;refreshToken=null;
    closing=(async()=>{
      if(!token)return;
      const revoked=await revokeEphemeralSession({refreshToken:token,clientId:issuedClientId,fetchImpl});
      if(!revoked)warn('Local session cleared; remote revocation was not confirmed. Disconnect BlockNote Lab in ChatGPT Settings.');
    })();
    return closing;
  };
  try {
    const redirectUri = await listener.start;
    const authorization = authorizationURL({hostId,clientId:registered?.clientId??'dynamic_agent_client',redirectUri,state,nonce,verifier});
    progress('waiting_browser');
    // Callback settlement closes the one-use bridge, while only user/server
    // cancellation should interrupt a still-exiting native launcher command.
    browserCleanup=await browser(authorization,{signal:browserAbort.signal,launchSignal:signal??null,onLocalPage:onLoginPage});
    const callback = await listener.done;
    if(signal?.aborted)throw Error('Sign-in cancelled');
    progress('verifying');
    const clientId = registered?.clientId ?? callback.clientId;
    if(!VALID_ID.test(clientId??'') || clientId==='dynamic_agent_client' ||
       (registered && callback.clientId && callback.clientId!==registered.clientId)) throw Error('Untrusted OAuth client registration');
    const reply=await fetchImpl(TOKEN_URL,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:callback.code,
        code_verifier:verifier,redirect_uri:redirectUri,resource:RESOURCE}), signal:scopedSignal(30_000)
    });
    if(!reply.ok)throw Error(`OAuth exchange failed HTTP ${reply.status}`);
    const tokens=await reply.json();
    issuedClientId=clientId;
    refreshToken=typeof tokens.refresh_token==='string'?tokens.refresh_token:null;
    if(typeof tokens.access_token!=='string' || !tokens.access_token ||
      !refreshToken || typeof tokens.id_token!=='string' || !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in<=0 || typeof tokens.scope!=='string')throw Error('Incomplete authorization response');
    const scopes=tokens.scope.trim().split(/\s+/);
    if(signal?.aborted)throw Error('Sign-in cancelled');
    if(!scopes.includes(PLAN_SCOPE))throw Error('ChatGPT plan sharing was not authorized');
    const keys=await fetchImpl(JWKS_URL,{signal:scopedSignal(10_000)});
    if(!keys.ok)throw Error('Identity verification keys unavailable');
    const identity=verifyIdentityToken(tokens.id_token,{clientId,nonce,jwks:await keys.json()});
    if(signal?.aborted)throw Error('Sign-in cancelled');
    if(registered && registered.subject!==identity.subject)throw Error('OAuth account mismatch');
    // Save *nonsecret* registration metadata only. Token fields are never serialized.
    await writeRegistration(dir,{version:1,clientId,subject:identity.subject,hostId});
    accessToken=tokens.access_token;
    const expiresAt=Date.now()+tokens.expires_in*1000;
    return {
      accountLabel:identity.email??'ChatGPT account', sharing:true,
      bearer() { if(!accessToken)throw Error('Session was closed');
        if(Date.now()+90_000>=expiresAt)throw Error('Session expired; connect again (tokens are not persisted)');
        return accessToken; },
      close,
    };
  } catch(error) {
    await close();
    throw error;
  } finally {
    signal?.removeEventListener('abort',cancel);
    browserAbort.abort();
    try { if(typeof browserCleanup==='function')await browserCleanup(); }
    finally { await listener.close(); }
  }
}

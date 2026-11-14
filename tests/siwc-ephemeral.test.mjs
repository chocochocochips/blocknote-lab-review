import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connectEphemeral, assertNoLegacyCredentials, readRegistration } from '../scripts/siwc-ephemeral.mjs';
import { ISSUER, PLAN_SCOPE, JWKS_URL, TOKEN_URL } from '../scripts/siwc-auth.mjs';

async function withDir(fn){const dir=await mkdtemp(join(tmpdir(),'bn-session-only-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
function mockFlow({subject='subject-1',scope=`openid ${PLAN_SCOPE}`,invalidSig=false}={}){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk=publicKey.export({format:'jwk'});Object.assign(jwk,{kid:'mock-key',alg:'RS256',use:'sig'});
  const clientId='oaiapp_safe_test';let nonce;
  const browser=async auth=>{
    const u=new URL(auth);nonce=u.searchParams.get('nonce');
    assert.equal(u.searchParams.get('ext_agent_host_id').startsWith('urn:uuid:'),true);
    const cb=new URL(u.searchParams.get('redirect_uri'));
    cb.searchParams.set('client_id',clientId);cb.searchParams.set('code','mock-code');cb.searchParams.set('state',u.searchParams.get('state'));
    process.nextTick(()=>fetch(cb).catch(()=>{}));
  };
  const fetchImpl=async url=>{
    if(url===`${ISSUER}/.well-known/openid-configuration`)return {ok:true,json:async()=>({issuer:ISSUER,revocation_endpoint:`${ISSUER}/synthetic-revoke`})};
    if(url===`${ISSUER}/synthetic-revoke`)return {status:200};
    if(url===JWKS_URL)return {ok:true,json:async()=>({keys:[jwk]})};
    assert.equal(url,TOKEN_URL);
    const h=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
    const p=Buffer.from(JSON.stringify({iss:ISSUER,aud:clientId,sub:subject,nonce,exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
    const signer=createSign('RSA-SHA256');signer.update(`${h}.${p}`);signer.end();
    const signature=invalidSig?'wrong-signature':signer.sign(privateKey).toString('base64url');
    return {ok:true,json:async()=>({access_token:'SECRET_ACCESS_TOKEN_TEST',refresh_token:'SECRET_REFRESH_TOKEN_TEST',id_token:`${h}.${p}.${signature}`,scope,expires_in:3600})};
  };
  return {browser,fetchImpl};
}
test('session-only: signed OAuth login returns ephemeral bearer and persists nonsecret registration only',()=>withDir(async dir=>{
  const session=await connectEphemeral({dir,...mockFlow(),timeoutMs:3000});
  assert.equal(session.sharing,true);
  assert.equal(session.bearer(),'SECRET_ACCESS_TOKEN_TEST');
  const names=await readdir(dir);
  assert.deepEqual(names.sort(),['host.json','registration.json']);
  assert.equal((await stat(join(dir,'registration.json'))).mode&0o777,0o600);
  const all=(await Promise.all(names.map(name=>readFile(join(dir,name),'utf8')))).join('\n');
  for(const secret of ['SECRET_ACCESS_TOKEN_TEST','SECRET_REFRESH_TOKEN_TEST','accessToken','refreshToken','idToken'])assert.equal(all.includes(secret),false);
  assert.equal((await readRegistration(dir)).clientId,'oaiapp_safe_test');
  await session.close();assert.throws(()=>session.bearer(),/closed/);
}));
test('session-only: UI progress contains only stages while using the unchanged signed CLI OAuth path',()=>withDir(async dir=>{
  const phases=[];const session=await connectEphemeral({dir,...mockFlow(),timeoutMs:3000,onProgress:p=>phases.push(p)});
  assert.deepEqual(phases,['starting','waiting_browser','verifying']);assert.doesNotMatch(JSON.stringify(phases),/token|nonce|code|subject|auth\.openai/);
  await session.close();
}));
test('session-only: cancellation during token exchange aborts promptly and persists no credentials',()=>withDir(async dir=>{
  const controller=new AbortController(),flow=mockFlow();let exchanged=false;
  const fetchImpl=async(url,opts)=>{
    if(url===TOKEN_URL){exchanged=true;controller.abort();opts.signal.throwIfAborted();}
    return flow.fetchImpl(url,opts);
  };
  await assert.rejects(connectEphemeral({dir,browser:flow.browser,fetchImpl,signal:controller.signal,timeoutMs:3000}));
  assert.equal(exchanged,true);assert.deepEqual((await readdir(dir)).sort(),['host.json']);
}));
test('session-only: refused scope prevents use and no persisted credentials',()=>withDir(async dir=>{
  await assert.rejects(connectEphemeral({dir,...mockFlow({scope:'openid profile'}),timeoutMs:3000}),/not authorized/);
  assert.deepEqual(await readdir(dir),['host.json']);
}));
test('session-only: invalid signature fails closed, registration stays unwritten',()=>withDir(async dir=>{
  await assert.rejects(connectEphemeral({dir,...mockFlow({invalidSig:true}),timeoutMs:3000}),/signature/);
  assert.equal((await readdir(dir)).includes('registration.json'),false);
}));
test('session-only: legacy plaintext secrets block login without reading or migrating old file',()=>withDir(async dir=>{
  const path=join(dir,'subscription.json');
  await writeFile(path,JSON.stringify({accessToken:'OLD_SECRET'}),{mode:0o600});
  await assert.rejects(assertNoLegacyCredentials(dir),/plaintext subscription/);
  await assert.rejects(connectEphemeral({dir,...mockFlow(),timeoutMs:300}),/plaintext subscription/);
  assert.equal((await readFile(path,'utf8')).includes('OLD_SECRET'),true);
}));
test('session-only: CLI legacy login/models/propose fail before OAuth or disk writes',async()=>{
  for (const cmd of ['login','models','propose']) {
    const child=spawn(process.execPath,['scripts/gpt-subscription.mjs',cmd],{cwd:new URL('../',import.meta.url).pathname});
    let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
    const [code]=await once(child,'close');assert.notEqual(code,0);assert.match(stderr,/disabled for safety/);
  }
});
test('session-only: without TTY --apply is rejected before auth',async()=>{
  const child=spawn(process.execPath,['scripts/gpt-subscription.mjs','session','--apply'],{cwd:new URL('../',import.meta.url).pathname});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const [code]=await once(child,'close');assert.notEqual(code,0);assert.match(stderr,/interactive TTY/);
});

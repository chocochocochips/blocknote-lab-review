import test from 'node:test';
import assert from 'node:assert/strict';
import {createSign,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,rm,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {request} from 'node:http';
import {connectEphemeral} from '../scripts/siwc-ephemeral.mjs';
import {ISSUER,TOKEN_URL,JWKS_URL,PLAN_SCOPE,startAndroidBrowserBridge} from '../scripts/siwc-auth.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const key={...publicKey.export({format:'jwk'}),kid:'synthetic-work-key',alg:'RS256',use:'sig'};
async function inDir(fn){const dir=await mkdtemp(join(tmpdir(),'bn-work-auth-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
function flow({scope=`openid ${PLAN_SCOPE}`,statuses=[200],foreignEndpoint=false,subject='synthetic-person',deny=false}={}){
 let nonce,attempts=0,tokenExchanges=0;const warnings=[],registrations=[];
 return {warnings,registrations,get attempts(){return attempts;},get tokenExchanges(){return tokenExchanges;},
 browser:async auth=>{const u=new URL(auth);registrations.push({clientId:u.searchParams.get('client_id'),host:u.searchParams.get('ext_agent_host_id')});nonce=u.searchParams.get('nonce');
 const cb=new URL(u.searchParams.get('redirect_uri'));cb.searchParams.set('state',u.searchParams.get('state'));
 if(deny)cb.searchParams.set('error','access_denied');else{cb.searchParams.set('code','synthetic-code');if(u.searchParams.get('client_id')==='dynamic_agent_client')cb.searchParams.set('client_id','oaiapp_synthetic_work');}
 process.nextTick(()=>fetch(cb).catch(()=>{}));},warn:message=>warnings.push(message),
 fetchImpl:async(url,options)=>{
 if(url===JWKS_URL)return {ok:true,json:async()=>({keys:[key]})};
 if(url===`${ISSUER}/.well-known/openid-configuration`)return {ok:true,json:async()=>({issuer:ISSUER,revocation_endpoint:foreignEndpoint?'https://untrusted.invalid/revoke':`${ISSUER}/synthetic-revoke`})};
 if(url===`${ISSUER}/synthetic-revoke`){assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.equal(options.body.get('token'),'synthetic-refresh');assert.equal(options.body.get('token_type_hint'),'refresh_token');assert.equal(options.body.get('client_id'),'oaiapp_synthetic_work');return {status:statuses[Math.min(attempts++,statuses.length-1)]};}
 assert.equal(url,TOKEN_URL);tokenExchanges++;assert.equal(options.body.get('client_id'),'oaiapp_synthetic_work');assert.ok(options.body.get('code_verifier'));
 const h=Buffer.from(JSON.stringify({alg:'RS256',kid:key.kid})).toString('base64url');const p=Buffer.from(JSON.stringify({iss:ISSUER,aud:'oaiapp_synthetic_work',sub:subject,nonce,exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
 const signer=createSign('RSA-SHA256');signer.update(`${h}.${p}`);signer.end();
 return {ok:true,json:async()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:`${h}.${p}.${signer.sign(privateKey).toString('base64url')}`,scope,expires_in:3600})};}};
}
test('Work: browser launch errors redact authorization URL and native spawn arguments',()=>{
 const script="import {openBrowser} from './scripts/siwc-auth.mjs';try{await openBrowser('https://auth.openai.com/api/accounts/authorize?state=synthetic');process.exitCode=2;}catch(e){if(JSON.stringify(e).includes('synthetic')||e.spawnargs)process.exitCode=3;}";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:'/__blocknote_test_no_browser__'},encoding:'utf8'});assert.equal(child.status,0);
});
test('Work: failed browser launch cleans callback without an unhandled rejection',()=>{
 const script="import {connectEphemeral} from './scripts/siwc-ephemeral.mjs';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const dir=await mkdtemp(join(tmpdir(),'bn-browser-fail-'));let n=0;process.on('unhandledRejection',()=>n++);try{try{await connectEphemeral({dir,browser:async()=>{throw Error('synthetic failure')},timeoutMs:100});}catch{}await new Promise(r=>setTimeout(r,20));if(n)process.exitCode=4;}finally{await rm(dir,{recursive:true,force:true});}";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),encoding:'utf8'});assert.equal(child.status,0);
});
test('Work: close revokes once and immediately disables bearer without storing tokens',()=>inDir(async dir=>{
 const f=flow();const session=await connectEphemeral({dir,...f});const closing=session.close();assert.throws(()=>session.bearer(),/closed/);await closing;await session.close();assert.equal(f.attempts,1);assert.deepEqual(f.warnings,[]);
 const files=await readdir(dir);assert.deepEqual(files.sort(),['host.json','registration.json']);for(const name of files)assert.doesNotMatch(await readFile(join(dir,name),'utf8'),/synthetic-access|synthetic-refresh/);
}));
test('Work: revocation retries a server failure once with bounded backoff',()=>inDir(async dir=>{const f=flow({statuses:[503,200]});const s=await connectEphemeral({dir,...f});await s.close();assert.equal(f.attempts,2);assert.deepEqual(f.warnings,[]);}));
test('Work: remote failure clears local use and gives a token-free warning',()=>inDir(async dir=>{const f=flow({statuses:[503]});const s=await connectEphemeral({dir,...f});await s.close();assert.equal(f.attempts,2);assert.throws(()=>s.bearer(),/closed/);assert.equal(f.warnings.length,1);assert.match(f.warnings[0],/remote revocation was not confirmed/);assert.doesNotMatch(f.warnings[0],/synthetic-refresh|synthetic-access/);}));
test('Work: discovery cannot send renewable credentials to another origin',()=>inDir(async dir=>{const f=flow({foreignEndpoint:true});const s=await connectEphemeral({dir,...f});await s.close();assert.equal(f.attempts,0);assert.equal(f.warnings.length,1);}));
test('Work: refused plan scope revokes issued session and saves no registration',()=>inDir(async dir=>{const f=flow({scope:'openid profile'});await assert.rejects(connectEphemeral({dir,...f}),/not authorized/);assert.equal(f.attempts,1);assert.deepEqual(await readdir(dir),['host.json']);}));
test('Work: returning sign-in reuses host and client; account mismatch preserves registration',()=>inDir(async dir=>{
 const a=flow();const s=await connectEphemeral({dir,...a});await s.close();const before=await readFile(join(dir,'registration.json'),'utf8');
 const b=flow();const t=await connectEphemeral({dir,...b});await t.close();assert.equal(b.registrations[0].clientId,'oaiapp_synthetic_work');assert.equal(a.registrations[0].host,b.registrations[0].host);
 const c=flow({subject:'different-person'});await assert.rejects(connectEphemeral({dir,...c}),/account mismatch/);assert.equal(await readFile(join(dir,'registration.json'),'utf8'),before);assert.equal(c.attempts,1);
}));
test('Work: declined consent stops before token exchange',()=>inDir(async dir=>{const f=flow({deny:true});await assert.rejects(connectEphemeral({dir,...f}),/cancelled or denied/);assert.equal(f.tokenExchanges,0);}));

const syntheticAuthorization='https://auth.openai.com/api/accounts/authorize?state=synthetic-private-state&agent_name_hint=BlockNote+Lab&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback';
test('Work: controller cancellation closes an OAuth listener and Android bridge before consent',()=>inDir(async dir=>{
 const controller=new AbortController();let bridge;
 const browser=async(auth,{signal})=>{
  bridge=await startAndroidBrowserBridge(auth,{signal});
  controller.abort();return bridge.close;
 };
 await assert.rejects(connectEphemeral({dir,browser,signal:controller.signal,timeoutMs:2000}),/cancelled/);
 await assert.rejects(fetch(bridge.url));
 await assert.rejects(connectEphemeral({dir,signal:controller.signal}),/cancelled/);
}));
const localFetch=(url,options={})=>fetch(url,{redirect:'manual',...options});
test('Android bridge: loopback page has a same-tab local link, protective headers and no OAuth URL',async()=>{
 const bridge=await startAndroidBrowserBridge(syntheticAuthorization);
 try {
  const u=new URL(bridge.url);assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/sign-in\/[A-Za-z0-9_-]{43}$/);
  const r=await localFetch(bridge.url);assert.equal(r.status,200);
  assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const html=await r.text();assert.ok(html.includes(`href="${u.pathname}/continue"`));
  assert.doesNotMatch(html,/auth\.openai\.com|synthetic-private-state|target=|<script/i);
 } finally {await bridge.close();await bridge.close();}
 await assert.rejects(fetch(bridge.url));
});
test('Android bridge: Host, exact route and GET method are enforced without consuming the link',async()=>{
 const bridge=await startAndroidBrowserBridge(syntheticAuthorization);
 try {
  const wrongHost=await new Promise((resolve,reject)=>{
   const req=request(bridge.url,{headers:{host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});
   req.on('error',reject);req.end();
  });
  assert.equal(wrongHost,403);
  assert.equal((await localFetch(bridge.url,{method:'POST'})).status,405);
  assert.equal((await localFetch(bridge.url+'?extra=1')).status,404);
  assert.equal((await localFetch(new URL('/unknown',bridge.url))).status,404);
  assert.equal((await localFetch(bridge.url)).status,200);
 } finally {await bridge.close();}
});
test('Android bridge: exactly one 303 preserves the original URL; duplicate redirects are blocked and server closes',async()=>{
 const bridge=await startAndroidBrowserBridge(syntheticAuthorization);
 try {
  const results=await Promise.allSettled([localFetch(bridge.url+'/continue'),localFetch(bridge.url+'/continue')]);
  const redirects=results.filter(r=>r.status==='fulfilled'&&r.value.status===303);
  assert.equal(redirects.length,1);assert.equal(redirects[0].value.headers.get('location'),syntheticAuthorization);
  for(const result of results)if(result.status==='fulfilled'&&result.value.status!==303)assert.equal(result.value.status,410);
  await bridge.close();await assert.rejects(localFetch(bridge.url+'/continue'));
 } finally {await bridge.close();}
});
test('Android bridge: timeout and cancellation release the listener; unsafe targets get only generic errors',async()=>{
 const timed=await startAndroidBrowserBridge(syntheticAuthorization,{timeoutMs:10});
 await new Promise(resolve=>setTimeout(resolve,30));await assert.rejects(localFetch(timed.url));await timed.close();
 const abort=new AbortController();const bridge=await startAndroidBrowserBridge(syntheticAuthorization,{signal:abort.signal});
 abort.abort();await bridge.close();await assert.rejects(localFetch(bridge.url));
 await assert.rejects(startAndroidBrowserBridge(syntheticAuthorization,{signal:abort.signal}),/^Error: Could not open the system browser$/);
 await assert.rejects(startAndroidBrowserBridge('https://untrusted.invalid/private'),/^Error: Could not open the system browser$/);
});
test('Android bridge: real default opener failure cleans bridge and callback and prints no authorization data',()=>{
 const script="import {connectEphemeral} from './scripts/siwc-ephemeral.mjs';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';const dir=await mkdtemp(join(tmpdir(),'bn-default-fail-'));let unhandled=0;process.on('unhandledRejection',()=>unhandled++);try{try{await connectEphemeral({dir,timeoutMs:100});process.exitCode=2;}catch(e){if(e.message!=='Could not open the system browser'||e.spawnargs)process.exitCode=3;}await new Promise(r=>setTimeout(r,20));if(unhandled)process.exitCode=4;}finally{await rm(dir,{recursive:true,force:true});}";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:'/__blocknote_test_no_browser__'},encoding:'utf8',timeout:5000});
 assert.equal(child.error,undefined);assert.equal(child.status,0);assert.doesNotMatch(child.stdout+child.stderr,/auth\.openai\.com|state=|nonce=|spawnargs/);
});
test('Android bridge: callback success, denial and timeout each close an unclicked bridge',()=>inDir(async dir=>{
 for(const outcome of ['success','denied','timeout']) {
  let bridge;
  const f=flow({deny:outcome==='denied'});
  const browser=async(auth,{signal})=>{
   bridge=await startAndroidBrowserBridge(auth,{signal});
   if(outcome!=='timeout')await f.browser(auth);
   return bridge.close;
  };
  const options={dir:join(dir,outcome),...f,browser,timeoutMs:outcome==='timeout'?50:3000};
  if(outcome==='success'){const session=await connectEphemeral(options);await session.close();}
  else await assert.rejects(connectEphemeral(options),outcome==='timeout'?/timed out/:/denied/);
  await assert.rejects(localFetch(bridge.url));
 }
}));
test('Android opener: launcher receives only loopback; simulated same-tab click gets unchanged 303',()=>inDir(async dir=>{
 const executable=join(dir,'termux-open-url');
 await writeFile(executable,`#!${process.execPath}\nconst u=new URL(process.argv[2]);if(u.hostname!=='127.0.0.1'||u.search)process.exit(2);const r=await fetch(u,{redirect:'manual'});const html=await r.text();if(r.status!==200||html.includes('auth.openai.com'))process.exit(3);const href=html.match(/href="([^"]+)"/)[1];const moved=await fetch(new URL(href,u),{redirect:'manual'});if(moved.status!==303||moved.headers.get('location')!==process.env.BN_SYNTHETIC_AUTH)process.exit(4);`,{mode:0o700});
 const script="import {openBrowser} from './scripts/siwc-auth.mjs';const close=await openBrowser(process.env.BN_SYNTHETIC_AUTH);if(typeof close!=='function')process.exitCode=5;await close();";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:dir,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
 assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout+child.stderr,'');
}));
test('Desktop opener: existing xdg-open still receives the original URL directly',{skip:process.platform!=='linux'},()=>inDir(async dir=>{
 await writeFile(join(dir,'xdg-open'),`#!${process.execPath}\nif(process.argv[2]!==process.env.BN_SYNTHETIC_AUTH)process.exitCode=2;`,{mode:0o700});
 const script="import {openBrowser} from './scripts/siwc-auth.mjs';if(await openBrowser(process.env.BN_SYNTHETIC_AUTH)!==undefined)process.exitCode=3;";
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'',PATH:dir,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
 assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout+child.stderr,'');
}));
test('Android opener: cancelling a stalled native launcher releases the bridge promptly without URL logs',()=>inDir(async dir=>{
  await writeFile(join(dir,'termux-open-url'),`#!${process.execPath}\nsetInterval(()=>{},1000);`,{mode:0o700});
  const script="import {openBrowser} from './scripts/siwc-auth.mjs';const start=Date.now();try{await openBrowser(process.env.BN_SYNTHETIC_AUTH,{signal:AbortSignal.timeout(80)});process.exitCode=2;}catch{if(Date.now()-start>2000)process.exitCode=3;}";
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:dir,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
  assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout+child.stderr,'');
}));
test('Android opener: callback bridge cleanup does not cancel a successful launcher still exiting',()=>inDir(async dir=>{
  await writeFile(join(dir,'termux-open-url'),`#!${process.execPath}\nsetTimeout(()=>{},250);`,{mode:0o700});
  const script="import {openBrowser} from './scripts/siwc-auth.mjs';const c=new AbortController();const opened=openBrowser(process.env.BN_SYNTHETIC_AUTH,{signal:c.signal,launchSignal:null});setTimeout(()=>c.abort(),100);const close=await opened;await close();";
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:dir,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
  assert.equal(child.error,undefined);assert.equal(child.status,0);assert.equal(child.stdout+child.stderr,'');
}));


test('Android manual fallback: native failure/missing utility keeps only a local page usable; consume clears it once',()=>inDir(async dir=>{
 await writeFile(join(dir,'termux-open-url'),`#!${process.execPath}\nprocess.exit(1);`,{mode:0o700});
 const script=`import assert from 'node:assert/strict';import {openBrowser} from './scripts/siwc-auth.mjs';let page,cleared=0,unhandled=0;process.on('unhandledRejection',()=>unhandled++);
 const close=await openBrowser(process.env.BN_SYNTHETIC_AUTH,{onLocalPage:value=>{if(value)page=value;else cleared++;}});
 const u=new URL(page);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.search,'');assert.equal(u.pathname.length,52);await new Promise(r=>setTimeout(r,100));
 const r=await fetch(page);assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/auth.openai.com|state=/);
 const moved=await fetch(page+'/continue',{redirect:'manual'});assert.equal(moved.status,303);assert.equal(moved.headers.get('location'),process.env.BN_SYNTHETIC_AUTH);
 await close();await close();assert.equal(cleared,1);await assert.rejects(fetch(page));assert.equal(unhandled,0);`;
 for(const path of [dir,'/__blocknote_test_no_browser__']){
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:path,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout+child.stderr,'');
 }
}));
test('Android manual fallback: stalled launcher does not delay page publication; cancellation closes it',()=>inDir(async dir=>{
 await writeFile(join(dir,'termux-open-url'),`#!${process.execPath}\nsetInterval(()=>{},1000);`,{mode:0o700});
 const script=`import assert from 'node:assert/strict';import {openBrowser} from './scripts/siwc-auth.mjs';const c=new AbortController();let page,cleared=0;const start=Date.now();
 const close=await openBrowser(process.env.BN_SYNTHETIC_AUTH,{signal:c.signal,onLocalPage:v=>{if(v)page=v;else cleared++;}});assert.ok(Date.now()-start<1000);assert.equal((await fetch(page)).status,200);c.abort();await close();assert.equal(cleared,1);await assert.rejects(fetch(page));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:new URL('../',import.meta.url),env:{...process.env,PREFIX:'/synthetic/com.termux',PATH:dir,BN_SYNTHETIC_AUTH:syntheticAuthorization},encoding:'utf8',timeout:5000});
 assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout+child.stderr,'');
}));
test('Work manual fallback: ephemeral path forwards only the bridge callback and preserves verified OAuth completion',()=>inDir(async dir=>{
 const f=flow(),pages=[];let bridge;
 const browser=async(auth,{signal,onLocalPage})=>{
  bridge=await startAndroidBrowserBridge(auth,{signal,onClose:()=>onLocalPage(null)});onLocalPage(bridge.url);
  const html=await localFetch(bridge.url).then(r=>r.text());assert.doesNotMatch(html,/auth.openai.com|state=/);
  const moved=await localFetch(bridge.url+'/continue');assert.equal(moved.status,303);await f.browser(moved.headers.get('location'));return bridge.close;
 };
 const s=await connectEphemeral({dir,...f,browser,onLoginPage:v=>pages.push(v)});assert.equal(s.bearer(),'synthetic-access');await s.close();
 assert.equal(pages[0],bridge.url);assert.equal(pages.at(-1),null);assert.doesNotMatch(JSON.stringify(pages),/auth.openai.com|state=|synthetic-code|synthetic-access|synthetic-refresh/);await assert.rejects(fetch(bridge.url));
}));

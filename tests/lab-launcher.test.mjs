import test from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createServer} from 'node:net';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer as createHttpServer} from 'node:http';
const dir=()=>mkdtemp(join(tmpdir(),'bn-launch-'));
async function data(d){await writeFile(join(d,'document.json'),JSON.stringify({id:'test',revision:7,blocks:[{id:'p',type:'paragraph',props:{},content:[{type:'text',text:'preserve',styles:{}}],children:[]}]}));await writeFile(join(d,'history.jsonl'),'');}
function launch(d,env={}){const p=spawn(process.execPath,['scripts/lab-launcher.mjs'],{env:{...process.env,LAB_DATA_DIR:d,DOC_PATH:'',HISTORY_PATH:'',...env}});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);return {p,output:()=>out};}
const done=p=>new Promise(r=>p.once('close',(code,signal)=>r({code,signal})));
async function waitFor(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout');}
test('launcher runs three real services and SIGINT shuts down preserving data',async()=>{const d=await dir();let run;try{await data(d);const before=await readFile(join(d,'document.json'),'utf8');run=launch(d);const closed=done(run.p);await waitFor(()=>run.output().includes('READY'));for(const port of [8787,5173,8788]){const options=port===8788?{headers:{Origin:'http://127.0.0.1:5173'}}:{};assert.equal((await fetch(`http://127.0.0.1:${port}`+(port===8787?'/api/document':port===8788?'/panel/status':'/'),options)).status,200);}run.p.kill('SIGINT');assert.equal((await closed).code,0,run.output());assert.equal(await readFile(join(d,'document.json'),'utf8'),before);for(const port of [8787,5173,8788])await assert.rejects(fetch(`http://127.0.0.1:${port}/`));}finally{run?.p.kill('SIGKILL');await rm(d,{recursive:true,force:true});}});
test('missing data is rejected without creating document',async()=>{const d=await dir();try{const p=launch(d);const result=await done(p.p);assert.equal(result.code,1);assert.match(p.output(),/파일이 없거나/);await assert.rejects(readFile(join(d,'document.json')));}finally{await rm(d,{recursive:true,force:true});}});
test('occupied port is reported and external listener survives',async()=>{const d=await dir(),s=createServer();try{await data(d);await new Promise(r=>s.listen(8788,'127.0.0.1',r));const p=launch(d);assert.equal((await done(p.p)).code,1);assert.match(p.output(),/8788/);assert.equal(s.listening,true);}finally{await new Promise(r=>s.close(r));await rm(d,{recursive:true,force:true});}});
test('port race: an external HTTP 200 cannot impersonate the Vite child',async()=>{
 const d=await dir();const outside=createHttpServer((req,res)=>res.end('external'));let run,closed,occupied;
 try {
  await data(d);
  const preload=join(d,'delay.cjs');
  await writeFile(preload,"if (process.argv[1]?.includes('vite/bin/vite.js')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);\n");
  const child=spawn(process.execPath,['scripts/lab-launcher.mjs'],{env:{...process.env,LAB_DATA_DIR:d,DOC_PATH:'',HISTORY_PATH:'',NODE_OPTIONS:`--require=${preload}`}});
  let out='',settled=false;run=child;closed=done(child).then(x=>{settled=true;return x;});
  occupied=new Promise((resolve,reject)=>child.stdout.on('data',chunk=>{
   out+=chunk;
   if(out.includes('[Document API]')&&!outside.listening)outside.listen(5173,'127.0.0.1',resolve);
  }).on('error',reject));
  child.stderr.on('data',chunk=>out+=chunk);
  await occupied;
  assert.equal((await fetch('http://127.0.0.1:5173/')).status,200);
  await waitFor(()=>settled||out.includes('\nREADY\n'));
  assert.equal(out.includes('\nREADY\n'),false,'external HTTP response must not count as child readiness');
  assert.notEqual((await closed).code,0);
  assert.equal(outside.listening,true);
  assert.equal((await fetch('http://127.0.0.1:5173/')).status,200);
  for(const port of [8787,8788])await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
 } finally {
  if(run&&run.exitCode===null){run.kill('SIGINT');await closed;}
  if(outside.listening)await new Promise(resolve=>outside.close(resolve));
  await rm(d,{recursive:true,force:true});
 }
});

async function assertReleased(){for(const port of [8787,5173,8788])await assert.rejects(fetch(`http://127.0.0.1:${port}/`));}
async function scenario(mode,fn){const d=await dir();let run,closed;try{
 await data(d);const before=await readFile(join(d,'document.json'),'utf8');
 const preload=join(d,'scenario.cjs');
 await writeFile(preload,`
 const path=require('node:path');const original=process.argv[1];
 const mode=process.env.BN_SCENARIO;
 if(mode==='vite-fail'&&original?.includes('vite/bin/vite.js'))process.exit(42);
 if(mode==='ai-fail'&&original?.endsWith('scripts/ai-panel-server.mjs'))process.exit(43);
 if(mode==='crash'&&original?.endsWith('scripts/ai-panel-server.mjs'))setTimeout(()=>process.exit(143),1200);
 if(mode==='startup-stop'&&original?.includes('vite/bin/vite.js'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
 if(['oauth-wait','session-close'].includes(mode)&&original?.endsWith('scripts/ai-panel-server.mjs')){
  process.argv[1]='synthetic-test-entry';
  import(require('node:url').pathToFileURL(path.resolve(original)).href).then(({createAiPanelServer})=>{
   const server=createAiPanelServer({connect:async({signal})=>{
    console.log('SYNTHETIC_OAUTH_STARTED');
    if(mode==='oauth-wait')await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{console.log('SYNTHETIC_OAUTH_CANCELLED');reject(Error('cancelled'));},{once:true});});
    return {bearer:()=> 'synthetic-only',close:async()=>{console.log('SYNTHETIC_REVOKE_STARTED');await new Promise(r=>setTimeout(r,400));console.log('SYNTHETIC_REVOKE_FINISHED');}};
   }});
   server.listen(8788,'127.0.0.1',()=>console.log('BlockNote AI panel local only: http://127.0.0.1:8788'));
   process.once('SIGTERM',()=>server.shutdown().then(()=>process.exit(0),()=>process.exit(1)));
  });
 }
 `);
 run=launch(d,{NODE_OPTIONS:`--require=${preload}`,BN_SCENARIO:mode});closed=done(run.p);
 await fn(run,closed,d);assert.equal(await readFile(join(d,'document.json'),'utf8'),before);await assertReleased();
 }finally{if(run?.p.exitCode===null){run.p.kill('SIGINT');await closed;}await rm(d,{recursive:true,force:true});}}
for(const mode of ['vite-fail','ai-fail'])test(`launcher cleans owned processes after ${mode}`,()=>scenario(mode,async(run,closed)=>{
 assert.equal((await closed).code,1);assert.equal(run.output().includes('\nREADY\n'),false);assert.match(run.output(),mode==='vite-fail'?/5173/:/8788/);
}));
test('unexpected code 143 after READY is a failure, not requested shutdown',()=>scenario('crash',async(run,closed)=>{
 await waitFor(()=>run.output().includes('\nREADY\n'));assert.equal((await closed).code,1);assert.match(run.output(),/프로세스 종료: AI Controller/);
}));
test('duplicate launcher leaves original processes and data intact',()=>scenario('normal',async(run,closed,d)=>{
 await waitFor(()=>run.output().includes('\nREADY\n'));const duplicate=launch(d);assert.equal((await done(duplicate.p)).code,1);
 assert.equal((await fetch('http://127.0.0.1:8787/api/document')).status,200);
 run.p.kill('SIGTERM');assert.equal((await closed).code,0);
}));
test('SIGINT during startup prevents READY and cleans owned processes',()=>scenario('startup-stop',async(run,closed)=>{
 await waitFor(()=>run.output().includes('[Document API]'));run.p.kill('SIGINT');assert.equal((await closed).code,0);assert.equal(run.output().includes('\nREADY\n'),false);
}));
for(const mode of ['oauth-wait','session-close'])test(`launcher shutdown awaits synthetic ${mode}`,()=>scenario(mode,async(run,closed)=>{
 await waitFor(()=>run.output().includes('\nREADY\n'));
 const request=fetch('http://127.0.0.1:8788/panel/connect',{method:'POST',headers:{Origin:'http://127.0.0.1:5173','Content-Type':'application/json'},body:'{}'}).catch(()=>null);
 await waitFor(()=>run.output().includes('SYNTHETIC_OAUTH_STARTED'));
 if(mode==='session-close')assert.equal((await request).status,200);
 run.p.kill('SIGINT');if(mode==='session-close'){await waitFor(()=>run.output().includes('SYNTHETIC_REVOKE_STARTED'));assert.equal(run.output().includes('종료 완료'),false);run.p.kill('SIGTERM');}
 assert.equal((await closed).code,0);await request;
 if(mode==='oauth-wait')assert.match(run.output(),/SYNTHETIC_OAUTH_CANCELLED/);
 else {assert.equal(run.output().split('SYNTHETIC_REVOKE_FINISHED').length-1,1);assert.ok(run.output().indexOf('SYNTHETIC_REVOKE_FINISHED')<run.output().lastIndexOf('종료 완료'));}
}));
for(const issue of ['invalid-document','invalid-history','pending-journal','missing-history'])test(`launcher refuses ${issue} without modifying data`,async()=>{
 const d=await dir();try {await data(d);
 if(issue==='invalid-document')await writeFile(join(d,'document.json'),'{}');
 if(issue==='invalid-history')await writeFile(join(d,'history.jsonl'),'not json');
 if(issue==='pending-journal')await writeFile(join(d,'document.json.txn.json'),'{}');
 if(issue==='missing-history')await rm(join(d,'history.jsonl'));
 const before=await readFile(join(d,'document.json'),'utf8');const run=launch(d);assert.equal((await done(run.p)).code,1);assert.equal(run.output().includes('\nREADY\n'),false);
 assert.equal(await readFile(join(d,'document.json'),'utf8'),before);await assertReleased();
 }finally{await rm(d,{recursive:true,force:true});}
});

test('F05 workspace launcher starts all services and stops without changing any document',async()=>{
 const {initializeWorkspace,openWorkspace}=await import('../server/workspace.mjs');const d=await dir();let run;
 try{const root=join(d,'workspace');const [first]=initializeWorkspace({destination:root});const second=openWorkspace(root).create('Second');const before=[first,second].map(x=>openWorkspace(root).get(x.id).storage.readDocument());
  run=launch(d,{LAB_WORKSPACE_DIR:root});const closed=done(run.p);try{await waitFor(()=>run.output().includes('READY'));}catch(e){throw Error(e.message+'\n'+run.output());}
  const list=await fetch('http://127.0.0.1:8787/api/documents').then(r=>r.json());assert.equal(list.documents.length,2);run.p.kill('SIGINT');assert.equal((await closed).code,0,run.output());assert.deepEqual([first,second].map(x=>openWorkspace(root).get(x.id).storage.readDocument()),before);await assertReleased();
 }finally{run?.p.kill('SIGKILL');await rm(d,{recursive:true,force:true});}
});
test('F05 workspace launcher refuses a missing secondary document history before startup',async()=>{
 const {initializeWorkspace,openWorkspace}=await import('../server/workspace.mjs');const {unlink}=await import('node:fs/promises');const d=await dir();
 try{const root=join(d,'workspace');initializeWorkspace({destination:root});const second=openWorkspace(root).create('Second');await unlink(join(root,'documents',second.id,'history.jsonl'));
  const run=launch(d,{LAB_WORKSPACE_DIR:root});assert.equal((await done(run.p)).code,1);assert.equal(run.output().includes('READY'),false);await assertReleased();
 }finally{await rm(d,{recursive:true,force:true});}
});

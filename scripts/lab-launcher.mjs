import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realpathSync,lstatSync,mkdirSync} from 'node:fs';
import {validateBlocks,validateStoredDocumentSize} from '../server/validation.mjs';

const followup=process.env.LAB_B09_FOLLOWUP==='1';
const b09=process.env.LAB_B09_ISOLATED==='1';
const b06=process.env.LAB_B06_ISOLATED==='1';
if([followup,b09,b06].filter(Boolean).length>1)throw Error('격리 모드는 하나만 선택하세요.');
const isolated=followup||b09||b06;
const folder=followup?'blocknote-b09-followup':b09?'blocknote-b09':'blocknote-argon-b06';
const base=join(homedir(),folder);
const workspace=process.env.LAB_WORKSPACE_DIR;
const authDir=join(base,'auth');
function assertIsolation(){
 if(!isolated)return;
 const expected=resolve(base), realHome=realpathSync(homedir());
 if(!workspace||resolve(workspace)!==join(expected,'run-data'))throw Error('B06 전용 작업실 경로가 필요합니다.');
 const rootStat=lstatSync(expected), realBase=realpathSync(expected);
 if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||realBase!==join(realHome,folder))throw Error('B06 격리 경로가 안전하지 않습니다.');
 const dataStat=lstatSync(workspace);
 if(dataStat.isSymbolicLink()||!dataStat.isDirectory()||realpathSync(workspace)!==join(realBase,'run-data'))throw Error('B06 작업실 경로가 안전하지 않습니다.');
 const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 if(realpathSync(sourceRoot)!==join(realBase,'source'))throw Error('B06 전용 소스 폴더에서 실행해야 합니다.');
 mkdirSync(authDir,{mode:0o700,recursive:true});
 if(lstatSync(authDir).isSymbolicLink()||realpathSync(authDir)!==join(realBase,'auth'))throw Error('B06 인증 경로가 안전하지 않습니다.');
 for(const name of ['host.json','registration.json','subscription.json']){try{const entry=lstatSync(join(authDir,name));if(entry.isSymbolicLink()||!entry.isFile()||entry.nlink!==1)throw Error('B06 인증 파일이 안전하지 않습니다.');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
const dir=isolated?join(base,'legacy-data'):(process.env.LAB_DATA_DIR||join(homedir(),'blocknote-f13-work','run-data'));
const doc=resolve((isolated?null:process.env.DOC_PATH)||join(dir,'document.json'));
const history=resolve((isolated?null:process.env.HISTORY_PATH)||join(dir,'history.jsonl'));
const ports=followup?[38787,35173,38788]:b09?[28787,25173,28788]:isolated?[18787,15173,18788]:[8787,5173,8788], [docPort,webPort,aiPort]=ports, children=[];
let shutting=false, shutdownPromise, failed=false;
function probe(port){return new Promise((resolve,reject)=>{const s=createServer();s.once('error',()=>reject(Error(`포트 ${port} 사용 중 또는 바인딩 불가. 기존 서버를 직접 확인하고 종료하세요.`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
async function validateData(){
 if(process.env.LAB_WORKSPACE_DIR){const {openWorkspace}=await import('../server/workspace.mjs');openWorkspace(process.env.LAB_WORKSPACE_DIR);return;}
 if(doc===history)throw Error('문서와 이력 경로가 같습니다.');
 try{await access(doc+'.txn.json');throw Error('미복구 저널이 있습니다. 기존 서버에서 복구 후 종료하세요.');}catch(e){if(e.code!=='ENOENT')throw e;}
 let d,lines;try{d=JSON.parse(await readFile(doc,'utf8'));lines=await readFile(history,'utf8');}catch{throw Error('기존 문서 또는 이력 파일이 없거나 JSON이 손상되었습니다. LAB_DATA_DIR 또는 DOC_PATH/HISTORY_PATH를 확인하세요.');}
 if(typeof d.id!=='string'||!d.id||!Number.isSafeInteger(d.revision)||d.revision<1)throw Error('문서 ID 또는 revision이 유효하지 않습니다.');
 validateBlocks(d.blocks);validateStoredDocumentSize(d);
 try{for(const line of lines.split('\n'))if(line.trim())JSON.parse(line);}catch{throw Error('이력 JSON이 손상되었습니다.');}
}
function start(name,port,args,env={}){
 const child=spawn(process.execPath,args,{env:{...process.env,...env},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 const entry={name,port,child,exited:false,exit:null,output:''};children.push(entry);
 child.stdout.on('data',data=>{entry.output=(entry.output+data.toString()).slice(-16384);process.stdout.write(`[${name}] ${data}`);});
 child.stderr.on('data',data=>process.stderr.write(`[${name}] ${data}`));
 child.on('error',()=>{failed=true;if(!shutting)void shutdown(`시작 실패: ${name} :${port}`);});
 child.on('exit',(code,signal)=>{entry.exited=true;entry.exit={code,signal};if(!shutting){failed=true;void shutdown(`프로세스 종료: ${name} :${port}`);}});
 return entry;
}
async function stop(entry){
 if(entry.exited)return;
 entry.child.kill('SIGTERM');
 await Promise.race([new Promise(r=>entry.child.once('exit',r)),new Promise(r=>{const t=setTimeout(r,30000);t.unref();})]);
 if(!entry.exited){failed=true;console.error(`${entry.name} 정상 종료 시간 초과; 원격 세션 폐기 확인 필요`);entry.child.kill('SIGKILL');await new Promise(r=>entry.child.once('exit',r));}
 if(entry.exit?.code && entry.exit.code!==0 && !(entry.name==='Web Editor' && entry.exit.code===143)){failed=true;console.error(`${entry.name} 종료 코드 ${entry.exit.code}`);}
}
function shutdown(reason){
 if(shutdownPromise)return shutdownPromise;
 shutting=true;shutdownPromise=(async()=>{console.log(reason);for(const name of ['AI Controller','Web Editor','Document API']){const e=children.find(x=>x.name===name);if(e)await stop(e);}console.log(failed?'종료 완료: 오류가 있었습니다.':'종료 완료');process.exitCode=failed?1:0;})();return shutdownPromise;
}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>void shutdown('작업실 종료 중…'));
async function ready(entry,url,options={}){
 const deadline=Date.now()+20000;
 const signals={
  'Document API':new RegExp(`BlockNote Lab API: http://127\\.0\\.0\\.1:${docPort}(?:\\r?\\n|$)`),
  'Web Editor':new RegExp(`Local:\\s+http://127\\.0\\.0\\.1:${webPort}/(?:\\s|$)`),
  'AI Controller':new RegExp(`BlockNote AI panel local only: http://127\\.0\\.0\\.1:${aiPort}(?:\\r?\\n|$)`),
 };
 while(Date.now()<deadline&&!shutting&&!entry.exited){
  if(signals[entry.name].test(entry.output)){
   try{const r=await fetch(url,{...options,signal:AbortSignal.timeout(800)});if(r.ok){if(entry.name==='Document API'){const d=await r.json();if(!d.id||!Number.isSafeInteger(d.revision))throw Error('bad document');}if(!entry.exited&&!shutting)return;}}catch{}
  }
  await new Promise(r=>setTimeout(r,150));
 }
 throw Error(`${entry.name} :${entry.port} 준비 실패`);
}
try{
 assertIsolation();await validateData();for(const port of ports){if(shutting)throw Error('종료 요청');await probe(port);}if(shutting)throw Error('종료 요청');
 const api=start('Document API',docPort,['server/index.mjs'],{HOST:'127.0.0.1',PORT:String(docPort),DOC_PATH:doc,HISTORY_PATH:history});
 await ready(api,`http://127.0.0.1:${docPort}/api/document`);
 if(shutting)throw Error('종료 요청');
 const web=start('Web Editor',webPort,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(webPort),'--strictPort'],followup?{VITE_LAB_B09_FOLLOWUP:'1'}:b09?{VITE_LAB_B09_ISOLATED:'1'}:isolated?{VITE_LAB_B06_ISOLATED:'1'}:{});
 await ready(web,`http://127.0.0.1:${webPort}/`);
 if(shutting)throw Error('종료 요청');
 const ai=start('AI Controller',aiPort,['scripts/ai-panel-server.mjs'],{AI_PANEL_PORT:String(aiPort),...(followup?{LAB_B09_FOLLOWUP_AUTH_DIR:authDir}:b09?{LAB_B09_AUTH_DIR:authDir}:isolated?{LAB_B06_AUTH_DIR:authDir}:{})});
 await ready(ai,`http://127.0.0.1:${aiPort}/panel/status`,{headers:{Origin:`http://127.0.0.1:${webPort}`}});
 if(shutting)throw Error('종료 요청');
 console.log(`BlockNote Lab\n✓ Document API :${docPort}\n✓ Web Editor :${webPort}\n✓ AI Controller :${aiPort}\nREADY\nOpen: http://127.0.0.1:${webPort}\nPress Ctrl+C to stop.`);
}catch(e){if(!shutting){failed=true;await shutdown(`작업실 시작 실패: ${e.message}`);}else await shutdownPromise;}

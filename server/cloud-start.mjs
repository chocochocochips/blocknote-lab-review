/** Startup owns a fresh /tmp directory; ignores every local-data/AI variable. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSyntheticWorkspace} from '../scripts/workspace-fixture.mjs';
import {createCloudApp,validateCloudConfig} from './cloud-app.mjs';

export function startCloud(env=process.env){
 const options={password:env.LAB_TEST_PASSWORD,publicOrigin:env.LAB_PUBLIC_ORIGIN||'',synthetic:env.LAB_SYNTHETIC_DATA,trustProxy:env.LAB_TRUST_PROXY==='1'};
 validateCloudConfig(options);
 const port=Number(env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
 const boot=mkdtempSync(join(tmpdir(),'blocknote-cloud-synthetic-'));
 const root=join(boot,'workspace');createSyntheticWorkspace(root);
 const dist=resolve(dirname(fileURLToPath(import.meta.url)),'../dist');
 const server=createCloudApp({...options,root,dist});
 server.on('close',()=>rmSync(boot,{recursive:true,force:true}));
 server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'cloud-test-ready',mode:'synthetic-only',reset:'every-process-start',configured:Boolean(options.publicOrigin),port})));
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const server=startCloud();
  server.on('error',()=>{console.error('Cloud test listener failed.');process.exitCode=1;});
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.close(()=>process.exit(0));server.closeAllConnections();setTimeout(()=>process.exit(1),5000).unref();});
 }catch{console.error('Cloud test startup refused. Check build, password and synthetic-only configuration.');process.exitCode=1;}
}

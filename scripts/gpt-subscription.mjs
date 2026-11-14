/** Subscription-first local BlockNote Lab CLI. Never share OAuth tokens with the document server. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { listSubscriptionModels, requestSubscriptionProposal, makeSubscriptionRequest } from './siwc-provider.mjs';
import { connectEphemeral, assertNoLegacyCredentials } from './siwc-ephemeral.mjs';

const args=process.argv.slice(2);
const flags=new Set(['session','login','status','models','propose','--apply','--dry-run']);
const options=['--model=','--mode=','--target=','--goal='];
if(args.some(a=>!flags.has(a)&&!options.some(p=>a.startsWith(p))))throw Error('Usage: npm run gpt-subscription -- login|status|models|propose [--model=slug] [--apply|--dry-run]');
const [cmd='status']=args;
const option=(key,fallback)=>args.find(a=>a.startsWith(`${key}=`))?.split('=').slice(1).join('=')??fallback;
const apply=args.includes('--apply'),dry=args.includes('--dry-run');
if(apply && dry)throw Error('Cannot use --dry-run and --apply simultaneously');
if(apply && !process.stdin.isTTY)throw Error('Explicit interactive TTY approval is required before any write');
if(['login','models','propose'].includes(cmd)) {
  throw Error('Persistent login was disabled for safety. Use `npm run ai -- session` for memory-only ChatGPT sign-in.');
}
if(cmd==='status'){
  await assertNoLegacyCredentials();
  console.log(JSON.stringify({connected:false,sharing:false,mode:'session-only',tokensPersisted:false},null,2));
  process.exit(0);
}
if(cmd!=='session')throw Error('Usage: npm run ai -- session [--dry-run] [--model=...] [--apply]');
const base=new URL(process.env.API_URL||'http://127.0.0.1:8787');
if(base.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.username||base.password||base.search||base.hash)throw Error('Only local loopback BlockNote document servers are supported');
const url=p=>new URL(p,base).toString();
async function get(p){const r=await fetch(url(p),{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(`BlockNote GET ${p}: HTTP ${r.status}`);return r.json();}
const mode=option('--mode','insert'),targetId=option('--target','lab-notes-body');
const goal=option('--goal','공유 문서의 목표를 더 명확하게 하는 짧은 단락 하나 제안');
const document=await get('/api/document');
const block=document.blocks.find(b=>b.id===targetId);
if(!block)throw Error('Target block does not exist');
if(mode==='patch'){
  const content=block.content?.[0];
  if(block.children?.length||block.content?.length!==1||content?.type!=='text'||Object.keys(content.styles??{}).length>0)throw Error('Rich text or nested blocks cannot be patched in this prototype');
}
if(dry){
  const candidate=option('--model','gpt-6.1-sol');
  makeSubscriptionRequest({document,model:candidate,mode,targetId,goal});
  console.log(JSON.stringify({status:'dry-run',revision:document.revision,model:candidate,mode,targetId,sentToProvider:false,savedToBlockNote:false},null,2));
  process.exit(0);
}
async function runSession(){
const connection=await connectEphemeral();
try {
const bearer=connection.bearer();
const catalog=await listSubscriptionModels({bearer});
console.log('Models available to this account: '+JSON.stringify(catalog.map(m=>m.slug)));

if(!catalog.length)throw Error('No models available to this ChatGPT account');
const selected=option('--model',catalog[0].slug);
if(!catalog.some(m=>m.slug===selected))throw Error(`Model is not available to this account: ${selected}`);
const generated=await requestSubscriptionProposal({document,model:selected,mode,targetId,goal,bearer});
const proposalId=`siwc-${randomUUID()}`, requestId=`siwc:${proposalId}`;
console.log('Proposal preview — NO document modifications yet:');
console.log(JSON.stringify({proposalId,model:selected,baseRevision:document.revision,mode,targetId,goal,content:generated.proposal.content,reason:generated.proposal.reason},null,2));
if(!apply){console.log('Preview-only. Use --apply and interactive confirmation to save.');return;}
const rl=createInterface({input:process.stdin,output:process.stdout});
let answer;
try{answer=await rl.question(`Type exactly approve ${proposalId} to save: `);}finally{rl.close();}
if(answer!==`approve ${proposalId}`){console.log('Rejected. No changes saved.');return;}
const latest=await get('/api/document');
if(latest.id!==document.id || latest.revision!==document.revision)throw Error('Document changed; approval is no longer valid. Request a fresh proposal.');
const path=mode==='insert'?'/api/blocks':`/api/blocks/${encodeURIComponent(targetId)}`;
// actor is a bounded display label; it must follow the document API's character contract.
const actor=`chatgpt-subscription ${selected}`.replace(/[^a-zA-Z0-9가-힣_. -]/g,'_').slice(0,60);
const body={revision:document.revision,actor,content:generated.proposal.content,
  requestId,proposalId,goal,reason:generated.proposal.reason,approval:'approved',
  ...(mode==='insert'?{type:'paragraph',afterId:targetId}:{})};
let response;
try{response=await fetch(url(path),{method:mode==='insert'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}
catch{throw Error(`Save outcome uncertain; do NOT automatically retry. Check receipt for requestId=${requestId}`);}
const result=await response.json().catch(()=>null);
if(!response.ok)throw Error(`Save HTTP ${response.status}, code=${result?.code??'unknown'}, requestId=${requestId}`);
const receipt=await get(`/api/requests/${encodeURIComponent(requestId)}`);
const history=await get('/api/history');
const audit=history.events.filter(e=>e.idempotency?.requestId===requestId);
if(receipt.outcome!=='COMMITTED'||receipt.revision!==result.revision||audit.length!==1||audit[0].proposal?.proposalId!==proposalId)
  throw Error(`Saved, but verification failed. requestId=${requestId}`);
console.log(JSON.stringify({saved:true,revision:result.revision,requestId,receipt:'COMMITTED',auditRecords:1}));

} finally { await connection.close(); }
}
await runSession();

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { MODELS, compactSnapshot, makeOpenAIRequest, parseOpenAIProposal, requestOpenAIProposal } from '../scripts/openai-provider.mjs';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const seed = { id:'board-lab', revision:1, blocks:[{id:'lab-notes-body',type:'paragraph',props:{},content:[{type:'text',text:'원본',styles:{}}],children:[]}] };
const options = { document:seed,model:'gpt-6-luna',mode:'insert',targetId:'lab-notes-body',goal:'하나의 안전한 새 단락 제안' };
const apiReply = (content='AI의 한 블록 제안', reason='명확성 향상') => ({
  id:'resp_mock_test',status:'completed', output:[{ type:'message',content:[{type:'output_text',text:JSON.stringify({content,reason})}] }],usage:{input_tokens:20,output_tokens:12},
});

test('F03-05B 네 종류의 GPT 모델을 선택할 수 있고 임의 모델은 거부', () => {
  assert.deepEqual(MODELS,['gpt-6-luna','gpt-6.1-terra','gpt-6.1-sol','gpt-6-astra']);
  for (const model of MODELS) assert.equal(makeOpenAIRequest({...options,model}).model,model);
  assert.throws(()=>makeOpenAIRequest({...options,model:'untrusted-model'}));
});

test('Responses API는 Structured Outputs, store=false, 단일 블록 스키마', () => {
  const req=makeOpenAIRequest(options);
  assert.equal(req.store,false);
  assert.equal(req.text.format.type,'json_schema');
  assert.equal(req.text.format.strict,true);
  assert.equal(req.text.format.schema.additionalProperties,false);
  assert.deepEqual(req.text.format.schema.required,['content','reason']);
  assert.equal(JSON.parse(req.input).document.revision,1);
});

test('모델 호출은 제안만 반환하고 승인/문서 쓰기는 수행하지 않음', async () => {
  let count=0;
  const result=await requestOpenAIProposal({...options,apiKey:'fake-key',fetchImpl:async (url,init)=>{
    count++;
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(init.method,'POST');
    assert.equal(init.headers.Authorization,'Bearer fake-key');
    assert.equal(JSON.parse(init.body).model,'gpt-6-luna');
    return {ok:true,json:async()=>apiReply()};
  }});
  assert.equal(count,1);
  assert.deepEqual(result.proposal,{content:'AI의 한 블록 제안',reason:'명확성 향상'});
});

test('API 키가 없으면 모델 HTTP 호출이 아예 일어나지 않음', async () => {
  let called=false;
  await assert.rejects(requestOpenAIProposal({...options,apiKey:'',fetchImpl:()=>{called=true;}}),/OPENAI_API_KEY/);
  assert.equal(called,false);
});

test('모델 거절·미완료·빈/과도한 결과를 승인 후보로 쓰지 않음', () => {
  for(const obj of [
    {...apiReply(),status:'incomplete'},
    {status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'안 됨'}]}]},
    apiReply(' ', '이유'), apiReply('a'.repeat(20001),'이유'), apiReply('내용',' '),
    apiReply('내용','x'.repeat(501)),
    {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'invalid'}]}]},
  ]) assert.throws(()=>parseOpenAIProposal(obj));
});

test('외부 본문 초과, 없는 대상 ID는 제안을 보내지 않음',()=>{
  assert.throws(()=>makeOpenAIRequest({...options,targetId:'nonexisting'}),/대상/);
  assert.throws(()=>compactSnapshot({...seed,blocks:[{...seed.blocks[0],content:[{type:'text',text:'X'.repeat(26000),styles:{}}]}]}),/24,000/);
});

async function withServer(fn) {
  const dir=mkdtempSync(join(tmpdir(),'blocknote-gptbridge-'));
  const file=join(dir,'document.json'), hist=join(dir,'history.jsonl');
  const server=createApp({documentFile:file,historyFile:hist});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  try { await fn({base:`http://127.0.0.1:${server.address().port}`,file,hist}); }
  finally {await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
}

async function runCli(args, env=process.env) {
  const child=spawn(process.execPath,['scripts/gpt-propose.mjs',...args],{cwd:new URL('../',import.meta.url).pathname,env});
  let stdout='', stderr='';
  child.stdout.setEncoding('utf8').on('data',chunk=>{ stdout+=chunk; });
  child.stderr.setEncoding('utf8').on('data',chunk=>{ stderr+=chunk; });
  const [code]=await once(child,'close');
  return {status:code,stdout,stderr};
}

test('CLI --models 및 --dry-run은 외부 모델 호출이나 BlockNote 쓰기 없이 완료',async()=>withServer(async({base,file,hist})=>{
  let r=await runCli(['--models']);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/gpt-6\.1-sol/);
  const before=await fetch(base+'/api/document').then(r=>r.json());
  r=await runCli(['--dry-run','--model=gpt-6.1-terra'],{...process.env,API_URL:base,OPENAI_API_KEY:''});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/"sentToProvider": false/);
  assert.deepEqual(await fetch(base+'/api/document').then(r=>r.json()),before);
  assert.equal(existsSync(hist),false);
}));

test('비TTY --apply는 모델 호출 이전에 차단',async()=>withServer(async({base,hist})=>{
  const r=await runCli(['--apply'],{...process.env,API_URL:base,OPENAI_API_KEY:'fake-key'});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/TTY/);
  assert.equal(existsSync(hist),false);
}));

test('모의 모델 제안 → 승인 주장 POST → 영수증·감사 연결(격리 서버)',async()=>withServer(async({base,hist})=>{
  const document=await fetch(base+'/api/document').then(r=>r.json());
  const originalBlocks=structuredClone(document.blocks);
  const ai=await requestOpenAIProposal({
    document, model:'gpt-6.1-terra', mode:'insert', targetId:'lab-notes-body',goal:'협업 규칙 단락 추가',apiKey:'mock',
    fetchImpl:async()=>({ok:true,json:async()=>apiReply('승인된 문서 협업 규칙','후속 협업자가 규칙을 이해하도록 명시')})
  });
  assert.equal((await fetch(base+'/api/document').then(r=>r.json())).revision,1);
  assert.equal(existsSync(hist),false);
  const requestId='mock:gpt-f03-e2e-1', proposalId='mock-gpt-f03-e2e-1';
  const body={revision:document.revision,actor:'openai-gpt-6.1-terra',afterId:'lab-notes-body',type:'paragraph',
    content:ai.proposal.content, requestId,proposalId,goal:'협업 규칙 단락 추가',reason:ai.proposal.reason,approval:'approved'};
  const saved=await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(saved.status,201);
  const result=await saved.json();
  const next=await fetch(base+'/api/document').then(r=>r.json());
  assert.equal(next.revision,2);
  assert.equal(next.blocks.length,originalBlocks.length+1);
  for(const b of originalBlocks) assert.deepEqual(next.blocks.find(x=>x.id===b.id),b);
  const receipt=await fetch(base+'/api/requests/'+encodeURIComponent(requestId)).then(r=>r.json());
  assert.equal(receipt.outcome,'COMMITTED');
  assert.equal(receipt.result.block.id,result.block.id);
  const history=await fetch(base+'/api/history').then(r=>r.json());
  assert.equal(history.events.length,1);
  assert.equal(history.events[0].proposal.proposalId,proposalId);
  assert.equal(history.events[0].idempotency.requestId,requestId);
  const replay=await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(replay.headers.get('Idempotent-Replay'),'true');
  assert.equal((await fetch(base+'/api/history').then(r=>r.json())).events.length,1);
}));

test('승인 전에 다른 수정이 발생하면 원래 baseRevision은 409로 보호',async()=>withServer(async({base,hist})=>{
  const document=await fetch(base+'/api/document').then(r=>r.json());
  const oldProposal={revision:document.revision,actor:'openai-gpt-6-luna',afterId:'lab-notes-body',type:'paragraph',
    content:'오래된 AI 제안',requestId:'mock:gpt-stale-1',proposalId:'mock-gpt-stale-1',goal:'안전성 확인',reason:'충돌을 감지한다',approval:'approved'};
  const humanSave=await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:1,actor:'test-user',content:'먼저 수정한 블록'})});
  assert.equal(humanSave.status,201);
  const outdated=await fetch(base+'/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(oldProposal)});
  assert.equal(outdated.status,409);
  assert.equal((await outdated.json()).code,'REVISION_CONFLICT');
  const history=await fetch(base+'/api/history').then(r=>r.json());
  assert.equal(history.events.length,1);
  assert.equal((await fetch(base+'/api/document').then(r=>r.json())).revision,2);
}));

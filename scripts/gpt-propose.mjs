/** F03-05B: one-model, one-proposal CLI bridge. Human confirmation gates ALL writes. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { MODELS, makeOpenAIRequest, requestOpenAIProposal } from './openai-provider.mjs';

const args = process.argv.slice(2);
const allowed = new Set(['--apply', '--models', '--dry-run']);
const argValue = (prefix, fallback) => args.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
if (args.some(arg => !allowed.has(arg) && !['--model=', '--mode=', '--target=', '--goal='].some(p=>arg.startsWith(p)))) {
  throw new Error('옵션: --models, --dry-run, --model=..., --mode=insert|patch, --target=..., --goal=..., --apply');
}
if (args.includes('--models')) {
  console.log(MODELS.join('\n'));
  process.exit(0);
}
const apply = args.includes('--apply');
const dryRun = args.includes('--dry-run');
if (apply && dryRun) throw new Error('--dry-run과 --apply를 함께 사용할 수 없습니다.');
if (apply && !process.stdin.isTTY) throw new Error('자동 승인은 불가합니다. --apply에는 실제 대화형 TTY가 필요합니다.');
const model = argValue('--model=', 'gpt-6-luna');
const mode = argValue('--mode=', 'insert');
const targetId = argValue('--target=', 'lab-notes-body');
const goal = argValue('--goal=', '문서의 협업 원칙을 명확하게 설명하는 짧은 단락 한 개 제안');
const baseUrl = new URL(process.env.API_URL || 'http://127.0.0.1:8787');
if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname) ||
    baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('인증 없는 BlockNote 서버는 로컬 루프백 HTTP 주소만 허용합니다.');
}
const url = path => new URL(path, baseUrl).toString();
async function get(path) {
  const res = await fetch(url(path), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`BlockNote ${path} 조회 실패: HTTP ${res.status}`);
  return res.json();
}
const document = await get('/api/document');
const target = document.blocks?.find(b => b.id === targetId);
if (!target) throw new Error('대상 블록이 존재하지 않습니다.');
if (mode === 'patch') {
  const text = target.content?.[0];
  if (target.children?.length || target.content?.length !== 1 || text?.type !== 'text' ||
      typeof text.text !== 'string' || Object.keys(text.styles ?? {}).length !== 0 ||
      Object.keys(text).some(key => !['type','text','styles'].includes(key))) {
    throw new Error('서식·중첩·링크 블록은 안전하게 PATCH할 수 없습니다.');
  }
}
const payload = makeOpenAIRequest({ document, model, mode, targetId, goal });
if (dryRun) {
  console.log(JSON.stringify({ mode, model, targetId, revision: document.revision,
    requestParameters: { model: payload.model, store: payload.store, schema: payload.text.format.name },
    sentToProvider: false, savedToBlockNote: false }, null, 2));
  process.exit(0);
}
// The user invokes this paid API call explicitly; never store secrets or full snapshots in CLI logs.
const generated = await requestOpenAIProposal({ document, model, mode, targetId, goal,
  apiKey: process.env.OPENAI_API_KEY, signal: AbortSignal.timeout(60_000) });
const proposalId = `gpt-${randomUUID()}`;
const requestId = `gpt:${proposalId}`;
const proposal = { proposalId, requestId, model, documentId: document.id, baseRevision: document.revision,
  mode, targetId, goal, reason: generated.proposal.reason, content: generated.proposal.content,
  approval: 'pending', responseId: generated.responseId, usage: generated.usage };
console.log('AI 제안 미리보기 (아직 저장되지 않음):');
console.log(JSON.stringify(proposal, null, 2));
if (!apply) { console.log('이번 실행은 미리보기 전용입니다. 수정하려면 --apply 옵션과 직접 승인이 필요합니다.'); process.exit(0); }
const rl = createInterface({ input: process.stdin, output: process.stdout });
let answer;
try { answer = await rl.question(`저장하려면 approve ${proposalId} 를 정확히 입력하세요: `); }
finally { rl.close(); }
if (answer !== `approve ${proposalId}`) { console.log('거절: 문서에 아무것도 저장하지 않았습니다.'); process.exit(0); }
// Preflight fast fail does not replace the server revision CAS; any later race still returns 409.
const latest = await get('/api/document');
if (latest.revision !== document.revision || latest.id !== document.id) throw new Error('승인 전에 서버 revision이 바뀌었습니다. 새로운 제안·승인이 필요합니다.');
const method = mode === 'insert' ? 'POST' : 'PATCH';
const path = mode === 'insert' ? '/api/blocks' : `/api/blocks/${encodeURIComponent(targetId)}`;
const body = {
  revision: document.revision, actor: `openai-${model}`, content: generated.proposal.content,
  requestId, proposalId, goal, reason: generated.proposal.reason, approval: 'approved',
  ...(mode === 'insert' ? { afterId: targetId, type: 'paragraph' } : {}),
};
let res;
try { res = await fetch(url(path), { method, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); }
catch {
  console.error(`결과 미확정, 자동 재전송 금지. requestId=${requestId}; GET /api/requests/${encodeURIComponent(requestId)} 로 조회하세요.`);
  process.exitCode = 1;
}
if (res) {
  let result;
  try { result = await res.json(); } catch { result = null; }
  if (!res.ok) {
    console.error(`저장 결과: HTTP ${res.status}, code=${result?.code ?? 'unknown'}, requestId=${requestId}`);
    if (res.status === 503) console.error('결과 미확정: 영수증·감사 기록 조회 전 자동 재시도하지 마세요.');
    if (res.status === 409) console.error('다른 수정과 충돌했습니다. 최신 문서를 읽고 다시 제안·승인해야 합니다.');
    process.exitCode = 1;
  } else {
    console.log(`저장 응답 HTTP ${res.status}; revision=${result?.revision}; blockId=${result?.block?.id}`);
    // Readback is a convenience, never a substitute for a transaction receipt on uncertainty.
    try {
      const receipt = await get(`/api/requests/${encodeURIComponent(requestId)}`);
      if (receipt.outcome !== 'COMMITTED' || receipt.revision !== result.revision ||
          receipt.result?.block?.id !== result.block?.id) throw new Error('영수증 내용이 응답과 다릅니다.');
      const history = await get('/api/history');
      const matches = history.events.filter(event => event.idempotency?.requestId === requestId);
      if (matches.length !== 1 || matches[0].proposal?.proposalId !== proposalId) throw new Error('감사 기록 불일치');
      console.log(`영수증/감사 확인: COMMITTED; requestId=${requestId}; audit=1`);
    } catch (error) {
      console.error(`저장은 성공했으나 사후 확인 실패: ${error.message}; requestId=${requestId}`);
      process.exitCode = 1;
    }
  }
}

/** C-03: local-only, preview-first mock AI writer. No actual model is called.
 * Preview: npm run agent-demo
 * Interactive commit: npm run agent-demo -- --apply [--mode=insert|patch]
 * The typed confirmation is a demo workflow, NOT a server-side identity proof.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const modeArg = args.find(arg => arg.startsWith('--mode='));
const mode = modeArg ? modeArg.slice('--mode='.length) : 'insert';
if (!['insert', 'patch'].includes(mode) || args.some(arg => !['--apply', '--mode=insert', '--mode=patch'].includes(arg))) {
  throw new Error('사용법: npm run agent-demo -- [--apply] [--mode=insert|patch]');
}
const api = new URL(process.env.API_URL || 'http://127.0.0.1:8787');
if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) {
  throw new Error('C-03 데모는 인증이 없으므로 로컬 HTTP API만 허용합니다.');
}
const endpoint = path => new URL(path, api).toString();
const read = await fetch(endpoint('/api/document'));
if (!read.ok) throw new Error(`GET 문서 읽기 실패: ${read.status}`);
const doc = await read.json();
if (!doc || !Number.isSafeInteger(doc.revision) || !Array.isArray(doc.blocks)) {
  throw new Error('문서 스냅샷이 유효하지 않습니다.');
}
const targetId = 'lab-notes-body';
const target = doc.blocks.find(block => block.id === targetId);
if (!target) throw new Error('대상 루트 블록이 없습니다. 임의 위치에 쓰지 않습니다.');
if (mode === 'patch') {
  const plain = Array.isArray(target.children) && target.children.length === 0 &&
    Array.isArray(target.content) && target.content.length === 1 &&
    target.content[0]?.type === 'text' && typeof target.content[0]?.text === 'string' &&
    target.content[0]?.styles && Object.keys(target.content[0].styles).length === 0 &&
    Object.keys(target.content[0]).every(key => ['type', 'text', 'styles'].includes(key));
  if (!plain) throw new Error('서식/중첩 블록은 평문 PATCH로 덮어쓰지 않습니다.');
}
const proposalId = `demo-${randomUUID()}`;
const requestId = `demo:${proposalId}`;
const content = mode === 'insert'
  ? 'AI 데모: 승인된 제안을 HTTP API로 새 블록에 추가했습니다.'
  : 'AI 데모: 승인된 제안으로 기존 평문 블록을 수정했습니다.';
const proposal = {
  proposalId, documentId: doc.id, baseRevision: doc.revision,
  operation: mode === 'insert' ? 'insert' : 'replacePlainText',
  target: mode === 'insert' ? { afterId: targetId } : { blockId: targetId },
  actor: 'demo-agent',
  goal: '공유 문서의 승인 기반 AI 변경 흐름을 시연',
  reason: '블록 단위 API 변경과 감사 로그 출처를 추적하기 위한 데모',
  content, approval: 'pending',
};
console.log('C-03 제안 미리보기 (서버 쓰기 전):');
console.log(JSON.stringify(proposal, null, 2));
if (!apply) {
  console.log('미리보기만 수행했습니다. 실제 변경하려면 --apply를 추가하고 승인 문구를 직접 입력하세요.');
  process.exit(0);
}
if (!process.stdin.isTTY) throw new Error('비대화형 환경에서 자동 승인하지 않습니다. --apply는 TTY가 필요합니다.');
const rl = createInterface({ input: process.stdin, output: process.stdout });
let answer;
try { answer = await rl.question(`승인하려면 approve ${proposalId} 를 정확히 입력하세요: `); }
finally { rl.close(); }
if (answer !== `approve ${proposalId}`) {
  console.log('승인 거절: 문서를 변경하지 않았습니다.');
  process.exit(0);
}
proposal.approval = 'approved';
const method = mode === 'insert' ? 'POST' : 'PATCH';
const path = mode === 'insert' ? '/api/blocks' : `/api/blocks/${encodeURIComponent(targetId)}`;
const body = {
  revision: proposal.baseRevision, actor: proposal.actor,
  content: proposal.content, requestId,
  proposalId: proposal.proposalId, goal: proposal.goal,
  reason: proposal.reason, approval: proposal.approval,
  ...(mode === 'insert' ? { afterId: targetId, type: 'paragraph' } : {}),
};
console.log(`요청 전송: ${method} ${path} / requestId=${requestId}`);
let reply;
try {
  reply = await fetch(endpoint(path), {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
} catch (error) {
  console.error(`응답 유실/네트워크 오류: 결과 미확정. 자동 재전송 금지. requestId=${requestId}`);
  console.error(`확인: GET /api/requests/${encodeURIComponent(requestId)} (404만으로 미실행 단정 금지)`);
  process.exitCode = 1;
}
if (reply) {
  const data = await reply.json();
  if (!reply.ok) {
    console.error(`쓰기 실패(${reply.status}): ${JSON.stringify(data)}; requestId=${requestId}`);
    if (reply.status === 503) console.error('결과 미확정: 복구/영수증 확인 전 자동 재시도 금지.');
    if (reply.status === 409) console.error('revision/요청 충돌: GET 재조회 후 새 제안과 재승인이 필요합니다.');
    process.exitCode = 1;
  } else {
    console.log(`변경 반영: revision=${data.revision}, blockId=${data.block.id}, requestId=${requestId}`);
    console.log('감사 출처 확인: GET /api/history');
  }
}

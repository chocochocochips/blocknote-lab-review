/** C-03 prepared regression tests. DO NOT RUN before F-01 validation batch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

async function fixture(run, storageFaults) {
  const dir = mkdtempSync(join(tmpdir(), 'blocknote-c03-'));
  const documentFile = join(dir, 'doc.json');
  const historyFile = join(dir, 'history.jsonl');
  const server = createApp({ documentFile, historyFile, storageFaults });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), replay: response.headers.get('Idempotent-Replay') };
  };
  const audit = () => existsSync(historyFile)
    ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try { await run({ send, audit, documentFile }); }
  finally { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
}
const proposal = (id = 'c03-proposal-1') => ({
  requestId: `c03:${id}`, proposalId: id,
  goal: '문서 협업 검토', reason: '수정 목적과 근거를 감사 로그에 보존', approval: 'approved',
});
const insert = (id = 'c03-proposal-1') => ({
  revision: 1, actor: 'demo-agent', afterId: 'lab-notes-body',
  type: 'paragraph', content: '승인된 새 블록', ...proposal(id),
});

test('C03 승인된 POST는 감사 이벤트에 proposal과 C02 영수증을 함께 보존한다', async () => fixture(async ({ send, audit }) => {
  const payload = insert();
  const saved = await send('/api/blocks', 'POST', payload);
  assert.equal(saved.status, 201);
  assert.equal(audit().length, 1);
  assert.deepEqual(audit()[0].proposal, {
    proposalId: payload.proposalId, goal: payload.goal, reason: payload.reason, approval: 'approved',
  });
  assert.equal(audit()[0].idempotency.requestId, payload.requestId);
  const history = await send('/api/history');
  assert.deepEqual(history.body.events[0].proposal, audit()[0].proposal);
}));

test('C03 승인된 PATCH는 평문 블록을 변경하고 감사 이유를 기록한다', async () => fixture(async ({ send, audit }) => {
  const payload = { revision: 1, actor: 'demo-agent', content: '평문 업데이트', ...proposal('patch-1') };
  const saved = await send('/api/blocks/lab-notes-body', 'PATCH', payload);
  assert.equal(saved.status, 200);
  assert.equal(audit()[0].operation, 'block.update');
  assert.equal(audit()[0].proposal.proposalId, 'patch-1');
}));

test('C03 pending/rejected 및 필드 누락은 422, 문서/감사 무변경', async () => fixture(async ({ send, audit }) => {
  for (const payload of [
    { ...insert(), approval: 'pending' },
    { ...insert(), approval: 'rejected' },
    { ...insert(), reason: undefined },
  ]) {
    const res = await send('/api/blocks', 'POST', payload);
    assert.equal(res.status, 422);
  }
  assert.equal((await send('/api/document')).body.revision, 1);
  assert.equal(audit().length, 0);
}));

test('C03 goal/reason/proposalId 검증과 requestId 필수', async () => fixture(async ({ send, audit }) => {
  for (const [payload, status, code] of [
    [{ ...insert(), goal: ' '.repeat(3) }, 422, 'INVALID_PROPOSAL_GOAL'],
    [{ ...insert(), reason: 'x'.repeat(501) }, 422, 'INVALID_PROPOSAL_REASON'],
    [{ ...insert(), proposalId: 'bad id' }, 422, 'INVALID_PROPOSAL_ID'],
    [{ ...insert(), requestId: undefined }, 400, 'INVALID_REQUEST_ID'],
  ]) {
    const res = await send('/api/blocks', 'POST', payload);
    assert.equal(res.status, status);
    assert.equal(res.body.code, code);
  }
  assert.equal(audit().length, 0);
}));

test('C03 같은 ID+동일 metadata는 201 재생, reason 변경은 409', async () => fixture(async ({ send, audit }) => {
  const payload = insert('replay-1');
  const first = await send('/api/blocks', 'POST', payload);
  const replay = await send('/api/blocks', 'POST', payload);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.replay, 'true');
  assert.deepEqual(replay.body, first.body);
  const conflict = await send('/api/blocks', 'POST', { ...payload, reason: '변경된 이유' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'REQUEST_ID_REUSED');
  assert.equal(audit().length, 1);
}));

test('C03 503 후 복구하면 proposal/receipt가 감사 로그에 정확히 한 번 남는다', async () => {
  let once = true;
  await fixture(async ({ send, audit }) => {
    const payload = insert('recovery-1');
    const uncertain = await send('/api/blocks', 'POST', payload);
    assert.equal(uncertain.status, 503);
    assert.equal((await send('/api/document')).body.revision, 2);
    const receipt = await send('/api/requests/c03%3Arecovery-1');
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.outcome, 'COMMITTED');
    const replay = await send('/api/blocks', 'POST', payload);
    assert.equal(replay.replay, 'true');
    assert.equal(audit().length, 1);
    assert.equal(audit()[0].proposal.proposalId, 'recovery-1');
  }, stage => {
    if (stage === 'afterDocument' && once) { once = false; throw new Error('C03 injected fault'); }
  });
});

test('C03 레거시 POST는 provenance 없이 이전 계약을 유지한다', async () => fixture(async ({ send, audit }) => {
  const result = await send('/api/blocks', 'POST', { revision: 1, actor: 'demo-agent', content: 'legacy' });
  assert.equal(result.status, 201);
  assert.equal(audit().length, 1);
  assert.equal(audit()[0].proposal, undefined);
  assert.equal(audit()[0].idempotency, undefined);
}));

/** C-02 idempotency regression tests: PREPARED ONLY; execute in F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'blocknote-c02-'));
  const documentFile = join(dir, 'doc.json');
  const historyFile = join(dir, 'history.jsonl');
  let server;
  async function start(storageFaults) {
    server = createApp({ documentFile, historyFile, storageFaults });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (path, method = 'GET', body) => {
      const response = await fetch(base + path, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
      });
      return { status: response.status, data: await response.json(), replay: response.headers.get('Idempotent-Replay') };
    };
  }
  async function stop() {
    if (server) { await new Promise(resolve => server.close(resolve)); server = undefined; }
  }
  const audit = () => existsSync(historyFile) ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try { await run({ start, stop, audit, documentFile }); }
  finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
}
const insert = (id, content = '안전한 재시도') => ({ revision: 1, actor: 'demo-agent', content, requestId: id });

test('C02 POST 같은 ID/내용 재시도는 원래 201 응답을 재생하고 revision/감사/블록이 증가하지 않는다', async () => fixture(async ({ start, audit }) => {
  const send = await start();
  const payload = insert('agent:post-001');
  const first = await send('/api/blocks', 'POST', payload);
  assert.equal(first.status, 201);
  const retry = await send('/api/blocks', 'POST', { requestId: payload.requestId, content: payload.content, actor: payload.actor, revision: payload.revision });
  assert.equal(retry.status, 201);
  assert.equal(retry.replay, 'true');
  assert.deepEqual(retry.data, first.data);
  assert.equal((await send('/api/document')).data.revision, 2);
  assert.equal(audit().length, 1);
  assert.equal(audit()[0].idempotency.requestId, payload.requestId);
}));

test('C02 같은 ID에 다른 payload/HTTP 대상은 409 REQUEST_ID_REUSED이고 원본을 보존한다', async () => fixture(async ({ start, audit, documentFile }) => {
  const send = await start();
  assert.equal((await send('/api/blocks', 'POST', insert('same-id'))).status, 201);
  const before = readFileSync(documentFile, 'utf8');
  const changed = await send('/api/blocks', 'POST', insert('same-id', '다른 내용'));
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'REQUEST_ID_REUSED');
  const differentTarget = await send('/api/blocks/lab-intro', 'PATCH', { revision: 1, content: '안전한 재시도', actor: 'demo-agent', requestId: 'same-id' });
  assert.equal(differentTarget.status, 409);
  assert.equal(differentTarget.data.code, 'REQUEST_ID_REUSED');
  assert.equal(readFileSync(documentFile, 'utf8'), before);
  assert.equal(audit().length, 1);
}));

test('C02 재시작 이후에도 requestId 조회/재생이 유지된다', async () => fixture(async ({ start, stop, audit }) => {
  let send = await start();
  const payload = insert('persist-001');
  const original = await send('/api/blocks', 'POST', payload);
  assert.equal(original.status, 201);
  await stop();
  send = await start();
  const found = await send('/api/requests/persist-001');
  assert.equal(found.status, 200);
  assert.equal(found.data.outcome, 'COMMITTED');
  assert.equal(found.data.httpStatus, 201);
  assert.deepEqual(found.data.result, original.data);
  assert.ok(found.data.transactionId);
  const replay = await send('/api/blocks', 'POST', payload);
  assert.equal(replay.replay, 'true');
  assert.deepEqual(replay.data, original.data);
  assert.equal(audit().length, 1);
}));

test('C02 503 미확정 후 GET 복구로 요청 확정, 같은 ID 재전송해도 중복 없음', async () => fixture(async ({ start, audit }) => {
  let failOnce = true;
  const send = await start(stage => {
    if (stage === 'afterDocument' && failOnce) { failOnce = false; throw new Error('C02 injected crash'); }
  });
  const payload = insert('recover-001');
  const unknown = await send('/api/blocks', 'POST', payload);
  assert.equal(unknown.status, 503);
  assert.equal(unknown.data.code, 'RECOVERY_REQUIRED');
  assert.equal((await send('/api/document')).data.revision, 2);
  const lookup = await send('/api/requests/recover-001');
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.outcome, 'COMMITTED');
  assert.equal(lookup.data.result.revision, 2);
  const replay = await send('/api/blocks', 'POST', payload);
  assert.equal(replay.status, 201);
  assert.equal(replay.replay, 'true');
  assert.equal(replay.data.block.id, lookup.data.result.block.id);
  assert.equal(audit().length, 1);
}));

test('C02 PATCH는 동일 requestId를 재생하되 다른 ID+stale revision은 기존 409', async () => fixture(async ({ start, audit }) => {
  const send = await start();
  const payload = { revision: 1, content: '수정 완료', actor: 'demo-agent', requestId: 'patch-001' };
  const first = await send('/api/blocks/lab-intro', 'PATCH', payload);
  assert.equal(first.status, 200);
  const replay = await send('/api/blocks/lab-intro', 'PATCH', payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.replay, 'true');
  assert.deepEqual(replay.data, first.data);
  const stale = await send('/api/blocks/lab-intro', 'PATCH', { ...payload, requestId: 'patch-002' });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'REVISION_CONFLICT');
  assert.equal(audit().length, 1);
}));

test('C02 동일 ID 동시 요청은 하나의 변경만 기록한다', async () => fixture(async ({ start, audit }) => {
  const send = await start();
  const payload = insert('concurrent-001');
  const [a, b] = await Promise.all([send('/api/blocks', 'POST', payload), send('/api/blocks', 'POST', payload)]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(a.data, b.data);
  assert.equal([a.replay, b.replay].filter(Boolean).length, 1);
  assert.equal(audit().length, 1);
}));

test('C02 알 수 없는 requestId는 404, 잘못된 ID는 400, 레거시 POST는 유지', async () => fixture(async ({ start, audit }) => {
  const send = await start();
  assert.equal((await send('/api/requests/missing-id')).status, 404);
  const invalid = await send('/api/blocks', 'POST', insert('bad id with spaces'));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'INVALID_REQUEST_ID');
  const legacy = await send('/api/blocks', 'POST', { revision: 1, content: 'legacy' });
  assert.equal(legacy.status, 201);
  assert.equal(audit().length, 1);
  assert.equal(audit()[0].idempotency, undefined);
}));

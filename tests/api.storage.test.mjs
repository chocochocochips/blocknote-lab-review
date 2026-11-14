/** B-03 failure-injection tests: PREPARED ONLY. Execute in F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';
import { createStorage } from '../server/storage.mjs';

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'blocknote-b03-'));
  const documentFile = join(dir, 'doc.json');
  const historyFile = join(dir, 'audit.jsonl');
  let server;
  async function start(storageFaults) {
    server = createApp({ documentFile, historyFile, storageFaults });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return async (path, method = 'GET', body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
  }
  async function stop() {
    if (server) { await new Promise(resolve => server.close(resolve)); server = undefined; }
  }
  const audit = () => existsSync(historyFile) ? readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try { await run({ start, stop, documentFile, historyFile, audit }); }
  finally { await stop(); rmSync(dir, { recursive: true, force: true }); }
}
const post = send => send('/api/blocks', 'POST', { revision: 1, content: 'new text', actor: 'test-agent' });

test('B03 정상 커밋: 문서+감사 txId 1건, 이전 revision 백업, 저널 제거', async () => fixture(async ({ start, documentFile, audit }) => {
  const send = await start();
  const saved = await post(send);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.revision, 2);
  const events = audit();
  assert.equal(events.length, 1);
  assert.match(events[0].transactionId, /^[0-9a-f-]{36}$/);
  assert.equal(events[0].revision, 2);
  assert.equal(JSON.parse(readFileSync(`${documentFile}.bak`, 'utf8')).revision, 1);
  assert.equal(existsSync(`${documentFile}.txn.json`), false);
}));

test('B03 문서 rename 직후 장애: 503 미확정, 다음 GET이 저널 복구, 감사 정확히 1건', async () => fixture(async ({ start, documentFile, audit }) => {
  let failOnce = true;
  const send = await start(stage => {
    if (stage === 'afterDocument' && failOnce) { failOnce = false; throw new Error('injected after document'); }
  });
  const result = await post(send);
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'RECOVERY_REQUIRED');
  assert.ok(result.data.transactionId);
  assert.equal(existsSync(`${documentFile}.txn.json`), true);
  const recovered = await send('/api/document');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.revision, 2);
  assert.equal(audit().length, 1);
  assert.equal(existsSync(`${documentFile}.txn.json`), false);
  assert.equal((await post(send)).status, 409);
}));

test('B03 감사 기록 직후 장애: 재시작 복구 시 감사 중복 없음', async () => fixture(async ({ start, stop, documentFile, audit }) => {
  let failOnce = true;
  const send = await start(stage => {
    if (stage === 'afterAudit' && failOnce) { failOnce = false; throw new Error('injected after audit'); }
  });
  const result = await post(send);
  assert.equal(result.status, 503);
  assert.equal(audit().length, 1);
  assert.equal(existsSync(`${documentFile}.txn.json`), true);
  await stop();
  const restarted = await start();
  assert.equal((await restarted('/api/document')).data.revision, 2);
  assert.equal(audit().length, 1);
  assert.equal(existsSync(`${documentFile}.txn.json`), false);
}));

test('B03 저널 작성 전 장애: 500, 문서 바이트와 감사 로그 불변', async () => fixture(async ({ start, documentFile, audit }) => {
  const send = await start(stage => {
    if (stage === 'beforeJournal') throw new Error('injected before journal');
  });
  const before = readFileSync(documentFile, 'utf8');
  const result = await post(send);
  assert.equal(result.status, 500);
  assert.equal(result.data.code, 'STORAGE_PREPARE_FAILED');
  assert.equal(readFileSync(documentFile, 'utf8'), before);
  assert.equal(audit().length, 0);
  assert.equal(existsSync(`${documentFile}.txn.json`), false);
}));

test('B03 지속적 감사 장애: 503 동안 읽기 차단, 재시작 후 roll-forward', async () => fixture(async ({ start, stop, documentFile, audit }) => {
  const send = await start(stage => {
    if (stage === 'beforeAudit') throw new Error('injected audit failure');
  });
  assert.equal((await post(send)).status, 503);
  assert.equal((await send('/api/document')).status, 503);
  assert.equal((await send('/api/history')).status, 503);
  assert.equal(existsSync(`${documentFile}.txn.json`), true);
  await stop();
  const restarted = await start();
  assert.equal((await restarted('/api/document')).data.revision, 2);
  assert.equal(audit().length, 1);
}));

test('B03 수동 백업 복원은 revision을 증가시키고 recovery.restore 이벤트를 남김', async () => fixture(async ({ start, stop, documentFile, historyFile, audit }) => {
  const send = await start();
  assert.equal((await post(send)).status, 201);
  await stop();
  const store = createStorage({ documentFile, historyFile, initialDocument: null });
  const result = store.restoreBackup();
  assert.equal(result.revision, 3);
  assert.equal(store.readDocument().revision, 3);
  assert.equal(audit().length, 2);
  assert.equal(audit()[1].operation, 'recovery.restore');
  assert.ok(existsSync(result.archive));
}));

test('B03 1시간 이상 지난 잔여 임시 파일만 제거하고 정상 파일은 보존', async () => fixture(async ({ start, stop, documentFile, historyFile }) => {
  const { writeFileSync, utimesSync } = await import('node:fs');
  await start(); await stop();
  const stale = `${documentFile}.123.abc.tmp`;
  const fresh = `${historyFile}.123.def.tmp`;
  writeFileSync(stale, 'old');
  writeFileSync(fresh, 'new');
  const old = new Date(Date.now() - 7200000);
  utimesSync(stale, old, old);
  const store = createStorage({ documentFile, historyFile, initialDocument: null });
  assert.equal(store.cleanupStaleTemps(3600000), 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(documentFile), true);
}));

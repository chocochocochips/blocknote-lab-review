/** B-02 regression scenarios: code prepared, execution intentionally deferred to F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

async function fixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'blocknote-b02-'));
  const docFile = join(dir, 'doc.json');
  const auditFile = join(dir, 'audit.jsonl');
  const server = createApp({ documentFile: docFile, historyFile: auditFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
    return { status: response.status, data: await response.json() };
  };
  const snapshot = () => ({
    bytes: readFileSync(docFile, 'utf8'),
    audit: existsSync(auditFile) ? readFileSync(auditFile, 'utf8') : null,
  });
  try { await callback({ send, snapshot }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = (id, value, styles = {}) => ({
  id, type: 'paragraph', props: {},
  content: [{ type: 'text', text: value, styles }], children: [],
});

test('동일 revision의 동시 PATCH 두 개 중 정확히 하나만 성공하고 다른 요청은 409', async () => fixture(async ({ send }) => {
  const [a, b] = await Promise.all([
    send('/api/blocks/lab-intro', 'PATCH', { revision: 1, content: 'AI A' }),
    send('/api/blocks/lab-intro', 'PATCH', { revision: 1, content: 'AI B' }),
  ]);
  assert.deepEqual([a.status, b.status].sort((x, y) => x - y), [200, 409]);
  const rejected = [a, b].find(x => x.status === 409);
  assert.equal(rejected.data.code, 'REVISION_CONFLICT');
  assert.equal(rejected.data.currentRevision, 2);
  const after = (await send('/api/document')).data;
  assert.equal(after.revision, 2);
  assert.ok(['AI A', 'AI B'].includes(after.blocks.find(x => x.id === 'lab-intro').content[0].text));
  const history = (await send('/api/history')).data.events;
  assert.equal(history.length, 1);
  assert.equal(history[0].revision, 2);
}));

test('서식 있는 text 블록 PATCH는 422, 저장 바이트·revision·감사 로그 보존', async () => fixture(async ({ send, snapshot }) => {
  const initial = (await send('/api/document')).data;
  const blocks = initial.blocks.map(x => x.id === 'lab-intro' ? text(x.id, '서식', { bold: true }) : x);
  assert.equal((await send('/api/document', 'PUT', { revision: 1, blocks })).status, 200);
  const before = snapshot();
  const result = await send('/api/blocks/lab-intro', 'PATCH', { revision: 2, content: '덮어쓰기 금지' });
  assert.equal(result.status, 422);
  assert.equal(result.data.code, 'RICH_CONTENT_REQUIRES_SAFE_EDIT');
  assert.deepEqual(snapshot(), before);
}));

test('링크·복합 인라인·추가 메타데이터는 모두 PATCH 거부', async () => fixture(async ({ send, snapshot }) => {
  const variants = [
    [{ type: 'link', href: 'https://example.invalid', content: [{ type: 'text', text: '링크', styles: {} }] }],
    [{ type: 'text', text: '앞', styles: {} }, { type: 'text', text: '뒤', styles: {} }],
    [{ type: 'text', text: '메타', styles: {}, custom: 'preserve' }],
  ];
  for (const content of variants) {
    const beforeDoc = (await send('/api/document')).data;
    const blocks = beforeDoc.blocks.map(x => x.id === 'lab-intro' ? { ...x, content } : x);
    const saved = await send('/api/document', 'PUT', { revision: beforeDoc.revision, blocks });
    assert.equal(saved.status, 200);
    const before = snapshot();
    const bad = await send('/api/blocks/lab-intro', 'PATCH', { revision: saved.data.revision, content: '평문' });
    assert.equal(bad.status, 422);
    assert.equal(bad.data.code, 'RICH_CONTENT_REQUIRES_SAFE_EDIT');
    assert.deepEqual(snapshot(), before);
  }
}));

test('중첩 afterId/중첩 PATCH/자식 있는 루트 PATCH는 422 및 원본 보존', async () => fixture(async ({ send, snapshot }) => {
  const initial = (await send('/api/document')).data;
  const nested = text('nested-id', '자식');
  const blocks = initial.blocks.map(x => x.id === 'lab-intro' ? { ...x, children: [nested] } : x);
  const saved = await send('/api/document', 'PUT', { revision: 1, blocks });
  assert.equal(saved.status, 200);
  const before = snapshot();
  const requests = [
    ['/api/blocks', 'POST', { revision: 2, afterId: 'nested-id', content: '추가' }, 'UNSUPPORTED_NESTED_POSITION'],
    ['/api/blocks/nested-id', 'PATCH', { revision: 2, content: '수정' }, 'UNSUPPORTED_NESTED_OPERATION'],
    ['/api/blocks/lab-intro', 'PATCH', { revision: 2, content: '부모 수정' }, 'UNSUPPORTED_NESTED_OPERATION'],
  ];
  for (const [path, method, payload, code] of requests) {
    const result = await send(path, method, payload);
    assert.equal(result.status, 422);
    assert.equal(result.data.code, code);
    assert.deepEqual(snapshot(), before);
  }
}));

test('존재하지 않는 afterId와 PATCH ID는 404; stale revision은 409 우선', async () => fixture(async ({ send, snapshot }) => {
  const before = snapshot();
  const missingPosition = await send('/api/blocks', 'POST', { revision: 1, afterId: 'missing', content: 'a' });
  assert.equal(missingPosition.status, 404);
  assert.equal(missingPosition.data.code, 'POSITION_NOT_FOUND');
  const missingBlock = await send('/api/blocks/missing', 'PATCH', { revision: 1, content: 'b' });
  assert.equal(missingBlock.status, 404);
  assert.equal(missingBlock.data.code, 'BLOCK_NOT_FOUND');
  assert.deepEqual(snapshot(), before);
  const inserted = await send('/api/blocks', 'POST', { revision: 1, content: 'success' });
  assert.equal(inserted.status, 201);
  const stale = await send('/api/blocks/missing', 'PATCH', { revision: 1, content: 'x' });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'REVISION_CONFLICT');
}));

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

function withFixture(name, callback) {
  return test(name, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'blocknote-lab-'));
    const documentFile = join(directory, 'document.json');
    const historyFile = join(directory, 'history.jsonl');
    const server = createApp({ documentFile, historyFile });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const json = async (path, method = 'GET', body) => {
      const response = await fetch(url + path, {
        method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    try { await callback({ json, documentFile, historyFile }); }
    finally { await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); }
  });
}

withFixture('초기 문서 읽기와 AI 블록 삽입 및 기록', async ({ json, documentFile, historyFile }) => {
  const initial = await json('/api/document');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.revision, 1);
  assert.ok(initial.data.blocks.find(b => b.id === 'lab-notes-body'));
  const inserted = await json('/api/blocks', 'POST', {
    revision: 1, actor: 'model-test', afterId: 'lab-notes-body', content: '독립적인 API 쓰기',
  });
  assert.equal(inserted.status, 201);
  assert.equal(inserted.data.revision, 2);
  const after = await json('/api/document');
  assert.ok(after.data.blocks.some(b => b.id === inserted.data.block.id));
  assert.equal(JSON.parse(readFileSync(documentFile, 'utf8')).revision, 2);
  const history = await json('/api/history');
  assert.equal(history.data.events[0].actor, 'model-test');
  assert.equal(history.data.events[0].operation, 'block.insert');
  assert.match(readFileSync(historyFile, 'utf8'), /model-test/);
});

withFixture('충돌한 이전 버전 쓰기는 409이며 기존 문서는 보존', async ({ json }) => {
  const saved = await json('/api/blocks', 'POST', { revision: 1, content: '최신 기록' });
  assert.equal(saved.status, 201);
  const old = await json('/api/blocks', 'POST', { revision: 1, content: '늦은 수정' });
  assert.equal(old.status, 409);
  const doc = await json('/api/document');
  assert.equal(doc.data.revision, 2);
  assert.equal(doc.data.blocks.filter(b => b.content[0]?.text === '늦은 수정').length, 0);
});

withFixture('기존 블록 PATCH 및 에디터 전체 문서 저장', async ({ json }) => {
  const patched = await json('/api/blocks/lab-goal-body', 'PATCH', {
    revision: 1, actor: 'reviewer', content: '검증 성공',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.block.content[0].text, '검증 성공');
  const before = await json('/api/document');
  const saved = await json('/api/document', 'PUT', {
    revision: before.data.revision, actor: 'human-editor', blocks: before.data.blocks,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.revision, 3);
});

withFixture('중복 블록 ID가 있는 전체 문서 저장은 거절', async ({ json }) => {
  const before = await json('/api/document');
  const duplicated = [...before.data.blocks, before.data.blocks[0]];
  const bad = await json('/api/document', 'PUT', { revision: before.data.revision, blocks: duplicated });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.code, 'DUPLICATE_BLOCK_ID');
  assert.equal((await json('/api/document')).data.revision, 1);
});

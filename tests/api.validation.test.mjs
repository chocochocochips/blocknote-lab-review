/** B-01 API regression cases. Prepared only; run in F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/index.mjs';

async function fixture(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'blocknote-b01-'));
  const docFile = join(dir, 'doc.json');
  const auditFile = join(dir, 'history.jsonl');
  const server = createApp({ documentFile: docFile, historyFile: auditFile });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = async (path, method = 'GET', payload, raw = false) => {
    const response = await fetch(url + path, {
      method,
      ...(payload === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: raw ? payload : JSON.stringify(payload),
      }),
    });
    return { status: response.status, data: await response.json() };
  };
  try { await callback({ send, docFile, auditFile }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('중복 ID 거절 422; 파일/감사 로그 변경 없음', async () => fixture(async ({ send, docFile, auditFile }) => {
  const original = (await send('/api/document')).data;
  const bytes = readFileSync(docFile, 'utf8');
  const bad = await send('/api/document', 'PUT', {
    revision: original.revision, blocks: [...original.blocks, original.blocks[0]],
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.code, 'DUPLICATE_BLOCK_ID');
  assert.equal(readFileSync(docFile, 'utf8'), bytes);
  assert.equal(existsSync(auditFile), false);
}));

test('요청 본문 1,000,000바이트 초과 시 413; JSON 문법 오류 시 400', async () => fixture(async ({ send }) => {
  const big = await send('/api/document', 'PUT', 'x'.repeat(1_000_001), true);
  assert.equal(big.status, 413);
  assert.equal(big.data.code, 'PAYLOAD_TOO_LARGE');
  const malformed = await send('/api/document', 'PUT', '{broken', true);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.data.code, 'BAD_JSON');
}));

test('POST에 잘못된 content/type/actor와 PUT 중첩 개수 위반 시 422', async () => fixture(async ({ send }) => {
  for (const payload of [
    { revision: 1, content: 12 },
    { revision: 1, content: 'hi', type: 'table' },
    { revision: 1, content: 'hi', actor: '!' },
  ]) {
    const result = await send('/api/blocks', 'POST', payload);
    assert.equal(result.status, 422);
    assert.equal(typeof result.data.error, 'string');
  }
  const before = (await send('/api/document')).data;
  const root = before.blocks[0];
  const tooMany = [{ ...root, children: Array.from({ length: 1000 }, (_, i) => ({
    ...root, id: `child-${i}`, children: [],
  })) }];
  const result = await send('/api/document', 'PUT', { revision: before.revision, blocks: tooMany });
  assert.equal(result.status, 422);
  assert.equal(result.data.code, 'INVALID_BLOCKS');
  assert.equal((await send('/api/document')).data.revision, 1);
}));

test('최종 저장 JSON 크기 초과 시 원본과 revision 보존', async () => fixture(async ({ send, docFile }) => {
  const before = (await send('/api/document')).data;
  const original = readFileSync(docFile, 'utf8');
  // One request stays under the 1MB wire limit, but pretty-printed stored JSON exceeds it.
  const large = Array.from({ length: 440 }, (_, i) => ({
    id: `b-${i}`, type: 'paragraph', props: {},
    content: [{ type: 'text', text: '가'.repeat(700), styles: {} }], children: [],
  }));
  const result = await send('/api/document', 'PUT', { revision: 1, blocks: large });
  assert.equal(result.status, 422);
  assert.equal(result.data.code, 'DOCUMENT_TOO_LARGE');
  assert.equal(readFileSync(docFile, 'utf8'), original);
  assert.equal((await send('/api/document')).data.revision, before.revision);
}));

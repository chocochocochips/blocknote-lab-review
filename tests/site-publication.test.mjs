import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../site/worker.mjs';

test('Site publication validates the saved Markdown and keeps trial runs private', async t => {
  let stored, saves = 0, writes = 0, published;
  const api = 'https://api.github.com/repos/chocochocochips/blocknote-shared-memory';
  const siteOrigin = 'https://blocknote.test';
  const token = 'test-only-server-credential';
  const env = { BUCKET: {
    async get() {
      const bytes = stored;
      return bytes ? { etag: String(saves), size: Buffer.byteLength(bytes), json: async () => JSON.parse(bytes) } : null;
    },
    async put(key, bytes) { stored = bytes; saves++; return { etag: String(saves) }; },
  } };
  const blobSha = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex');
  let beforeWrite;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    if (url === api) return Response.json({ visibility: 'public' });
    assert.match(url, /\/contents\/memory\/blocknote-[a-f0-9]{64}\.md/);
    if (options.method === 'GET') {
      await beforeWrite?.();
      return published ? Response.json({ type: 'file', sha: blobSha(published) }) : new Response(null, { status: 404 });
    }
    const payload = JSON.parse(options.body);
    assert.equal(payload.sha, published ? blobSha(published) : undefined);
    published = Buffer.from(payload.content, 'base64').toString();
    writes++;
    return Response.json({});
  });
  const request = async (path, method = 'GET', body, headers = {}) => {
    const r = await worker.fetch(new Request(siteOrigin + path, {
      method, headers: { 'oai-authenticated-user-id': 'test-owner', origin: siteOrigin,
        'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: r.status, data: await r.json() };
  };
  const list = await request('/api/documents');
  const id = list.data.defaultDocumentId;
  const path = '/api/documents/' + id;
  const postits = '/api/postits?documentId=' + id;
  const preview = () => request(path + '/publication/preview', 'POST', {});
  const approve = (snapshot, extra) => request(path + '/publication', 'POST',
    { confirmed: true, digest: snapshot.digest, testMode: snapshot.testMode, ...extra });
  const initial = (await request(path + '/document')).data;
  const text = text => ({ type: 'text', text, styles: {} });
  const insertedOpinion = { id: 'test-opinion', type: 'paragraph', props: {}, children: [], content: [
    text('검토 답변\n한 줄 더\n\n확인할 질문\n1. 첫 질문\n2. 두 번째 질문\n\n마지막 문단'),
  ] };
  const table = { id: 'test-table', type: 'table', props: {}, children: [], content: {
    type: 'tableContent', columnWidths: [null, null], headerRows: 1,
    rows: [{ cells: [[text('기준')], [text('상태')]] }, { cells: [[text('테스트')], [text('성공 | 확인')]] }],
  } };
  assert.equal((await request(path + '/document', 'PUT', {
    documentId: id, revision: initial.revision, blocks: [...initial.blocks, table, insertedOpinion],
  })).status, 200);
  await request('/api/postits', 'POST', { documentId: id, requestId: 'publication:test', rawContent: '별도 포스트잇' });
  const notes = (await request(postits)).data;
  const snapshotSaves = saves;
  assert.equal((await request(path + '/publication/preview', 'POST', {}, { 'oai-authenticated-user-id': '' })).status, 401);
  assert.equal((await request(path + '/publication/preview', 'POST', {}, { origin: 'https://different.test' })).status, 403);
  const trial = (await preview()).data;
  assert.equal(trial.testMode, true);
  assert.ok(trial.markdown.includes('| 기준 | 상태 |\n| --- | --- |\n| 테스트 | 성공 \\| 확인 |'));
  assert.ok(trial.markdown.includes('검토 답변  \n한 줄 더\n\n확인할 질문\n\n1. 첫 질문\n2. 두 번째 질문\n\n마지막 문단'));
  assert.doesNotMatch(trial.markdown, /별도 포스트잇/);
  assert.equal((await approve(trial, { confirmed: false })).status, 409);
  const rehearsal = await approve(trial);
  assert.deepEqual(rehearsal.data, { testMode: true, revision: initial.revision + 1 });
  assert.equal(writes, 0);
  assert.equal(saves, snapshotSaves);

  env.LAB_PUBLICATION_GITHUB_TOKEN = token;
  assert.equal((await approve(trial)).status, 409);
  const live = (await preview()).data;
  assert.equal(live.testMode, false);
  const first = await approve(live);
  assert.equal(first.status, 200);
  assert.match(first.data.publicUrl, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(published, live.markdown);
  assert.doesNotMatch(JSON.stringify(first.data), new RegExp(token));
  assert.equal((await approve(live)).data.unchanged, true);
  assert.equal(writes, 1);

  const edit = () => request(path + '/blocks', 'POST', {
    documentId: id, revision: live.revision, content: '추가한 본문',
  });
  beforeWrite = async () => { assert.equal((await edit()).status, 201); };
  assert.equal((await approve(live)).data.code, 'PUBLICATION_PREVIEW_CHANGED');
  beforeWrite = undefined;
  const next = (await preview()).data;
  const republished = await approve(next);
  assert.equal(republished.data.publicUrl, first.data.publicUrl);
  assert.match(published, /추가한 본문/);
  assert.equal(writes, 2);
  assert.equal((await request(path + '/document')).data.revision, next.revision);
  assert.deepEqual((await request(postits)).data, notes);
  assert.equal(saves, snapshotSaves + 1);
});

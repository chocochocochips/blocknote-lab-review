import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

test('GitHub requests run in the Workers runtime and never follow redirects', async t => {
  const calls = [];
  const worker = new Miniflare({
    compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'],
    modules: [
      { type: 'ESModule', path: 'test-worker.mjs', contents: `
        import { githubPublication } from './site/github-publication.mjs';
        export default { async fetch() {
          try {
            return Response.json(await githubPublication('synthetic-token').publish({
              key: 'synthetic-test', markdown: '# Test', verifyCurrent: async () => {},
            }));
          } catch (error) {
            return Response.json({ code: error.code }, { status: error.status || 500 });
          }
        } };
      ` },
      ...await Promise.all(['site/github-publication.mjs', 'server/validation.mjs'].map(async path => ({
        type: 'ESModule', path, contents: await readFile(new URL('../' + path, import.meta.url), 'utf8'),
      }))),
    ],
    outboundService: async request => {
      calls.push([request.method, request.url, request.headers.get('Authorization'), request.headers.get('User-Agent')]);
      const { pathname } = new URL(request.url);
      if (pathname.endsWith('/blocknote-shared-memory')) {
        if (calls.length > 3) return Response.redirect('https://another-host.test/');
        return Response.json({ visibility: 'public' });
      }
      if (request.method === 'GET') return new Response(null, { status: 404 });
      assert.equal(Buffer.from((await request.json()).content, 'base64').toString(), '# Test');
      return Response.json({}, { status: 201 });
    },
  });
  t.after(() => worker.dispose());
  const approved = await worker.dispatchFetch('http://localhost/');
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).unchanged, false);
  assert.deepEqual(calls.map(([method]) => method), ['GET', 'GET', 'PUT']);
  assert.ok(calls.every(([, url, token, agent]) => new URL(url).hostname === 'api.github.com'
    && token === 'Bearer synthetic-token' && agent === 'BlockNote-Lab-Publication'));

  const redirected = await worker.dispatchFetch('http://localhost/');
  assert.equal(redirected.status, 502);
  assert.equal((await redirected.json()).code, 'PUBLICATION_DESTINATION_REDIRECT');
  assert.equal(calls.length, 4);
});

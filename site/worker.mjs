import { Buffer } from 'node:buffer';
import { createWorkspaceHandler } from '../server/workspace.mjs';
import { createCloudAi } from '../server/cloud-ai.mjs';
import { LIMITS, RequestError, readJsonBody } from '../server/validation.mjs';
import { withWorkspace } from './workspace.mjs';
import { prepareTestReply } from './prepare-test-reply.mjs';
import { handleMcp } from './mcp.mjs';
import { insertArchivedPostit } from './postit-insertion.mjs';
import { approvePublication, publicationKey, publicationSnapshot } from './publication.mjs';
import { githubPublication } from './github-publication.mjs';
import { providerModels } from './ai-providers.mjs';
import { requestOpinion } from './ai-opinion.mjs';

const model = { slug: 'synthetic-test', name: '시험 응답' };
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function streamExaoneOpinion(request, env, userId, id, payload) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([request.signal, stopped.signal]);
  const encoder = new TextEncoder();
  let heartbeat;
  const stream = new ReadableStream({
    start(controller) {
      const send = event => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      };
      send({ type: 'waiting' });
      heartbeat = setInterval(() => send({ type: 'waiting' }), 10_000);
      void requestOpinion(env, userId, id, payload, {
        signal, onDelta: text => send({ type: 'delta', text }),
      }).then(result => send({ type: 'result', result }), error => {
        if (signal.aborted) return;
        if (error instanceof RequestError) {
          send({ type: 'error', status: error.status, code: error.code, message: error.message });
        } else {
          console.error('BlockNote EXAONE stream failure', error?.name, error?.code);
          send({ type: 'error', status: 503, message: '시험실 요청을 처리하지 못했어요.' });
        }
      }).finally(() => {
        clearInterval(heartbeat);
        if (!stopped.signal.aborted) controller.close();
      });
    },
    cancel() {
      clearInterval(heartbeat);
      stopped.abort();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff' },
  });
}

async function bodyBytes(request, max) {
  if (!request.body) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new RequestError(413, 'PAYLOAD_TOO_LARGE', '요청 크기가 너무 큽니다.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function nodeRequest(url, method, headers, bytes) {
  return {
    url, method, headers,
    async *[Symbol.asyncIterator]() { if (bytes.length) yield bytes; },
  };
}

async function callHandler(handler, request) {
  let status, headers, body;
  await handler(request, {
    writeHead(code, fields) { status = code; headers = fields; },
    end(data) { body = data; },
  });
  return new Response(body, { status, headers });
}

function scopedDocumentApi(root, workspace) {
  const handler = createWorkspaceHandler({ root, workspace, hosted: true });
  return (path, method, headers, bytes) =>
    callHandler(handler, nodeRequest(path, method, headers, bytes));
}

function documentApiClient(documents) {
  return async (path, method = 'GET', body) => {
    const response = await documents(path, method, { 'content-type': 'application/json' },
      body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
    const result = await response.json();
    if (!response.ok) throw new RequestError(response.status, result.code, result.error);
    return result;
  };
}

async function panelResponse(url, request, bytes, documents, state) {
  const session = state.panel;
  const path = url.pathname;
  if (request.method === 'GET' && path === '/panel/status') return json({ connected: session.connected });
  if (request.method === 'GET' && path === '/panel/models') return json({ models: [model] });
  if (request.method === 'POST' && path === '/panel/connect') {
    session.connected = true;
    return json({ connected: true });
  }
  if (request.method === 'POST' && path === '/panel/disconnect') {
    state.panel = { connected: false, ai: null };
    return json({ connected: false });
  }
  if (!/^\/panel\/(requests|groups)(?:\/|$)/.test(path)) return json({ code: 'NOT_FOUND' }, 404);

  let body;
  if (request.method !== 'GET') {
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    } catch {
      return json({ code: 'BAD_JSON', error: '요청 내용을 확인하세요.' }, 400);
    }
  }
  const internal = documentApiClient(documents);
  const ai = createCloudAi({ session, internal, persisted: session.ai, prepareHosted: prepareTestReply });
  try {
    const response = await callHandler((req, res) => ai.handle(req, res, body),
      nodeRequest(path + url.search, request.method, {}, bytes));
    if (request.method === 'POST' && (path === '/panel/requests' || path === '/panel/groups')) {
      const ready = await ai.settle(path, await response.json());
      return json(ready, 202);
    }
    return response;
  } catch (error) {
    if (error instanceof RequestError) return json({ code: error.code, error: error.message }, error.status);
    throw error;
  } finally {
    await ai.drain();
    session.ai = ai.snapshot();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') {
      const identity = request.headers.get('oai-authenticated-user-id');
      return handleMcp(request, () => bodyBytes(request, LIMITS.requestBytes), operation =>
        withWorkspace(env.BUCKET, identity, ({ root, workspace }) =>
          operation(documentApiClient(scopedDocumentApi(root, workspace)))));
    }
    if (!/^\/(api|panel)(?:\/|$)/.test(url.pathname)) return env.ASSETS.fetch(request);
    const userId = request.headers.get('oai-authenticated-user-id');
    if (!userId) return json({ code: 'AUTH_REQUIRED', error: 'ChatGPT로 로그인해 주세요.' }, 401);
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    if ((origin && origin !== url.origin) || (fetchSite && !['same-origin', 'none'].includes(fetchSite))) {
      return json({ code: 'BAD_ORIGIN', error: '이 시험실에서 다시 요청하세요.' }, 403);
    }
    if (!['GET', 'POST', 'PUT', 'PATCH'].includes(request.method)) {
      return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    }
    const write = request.method !== 'GET';
    if (write && (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || origin !== url.origin)) {
      return json({ code: 'SAME_ORIGIN_JSON_REQUIRED', error: '이 시험실에서 다시 요청하세요.' }, 403);
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/site-ai/models') {
        return json({ models: await providerModels(env, url.searchParams.get('provider')) });
      }
      const opinion = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/site-ai$/);
      if (opinion && request.method === 'POST') {
        const bytes = await bodyBytes(request, 16_384);
        const payload = await readJsonBody(nodeRequest(url.pathname, request.method, {}, bytes));
        if (payload?.provider === 'exaone' && request.headers.get('accept') === 'application/x-ndjson') {
          return streamExaoneOpinion(request, env, userId, opinion[1], payload);
        }
        return json(await requestOpinion(env, userId, opinion[1], payload));
      }
      const panel = url.pathname.startsWith('/panel/');
      const bytes = write ? await bodyBytes(request, panel ? 16_384 : LIMITS.requestBytes) : Buffer.alloc(0);
      const publication = url.pathname.match(/^\/api\/documents\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/publication(\/preview)?$/);
      if (publication && request.method === 'POST') {
        const id = publication[1];
        const token = env.LAB_PUBLICATION_GITHUB_TOKEN?.trim();
        const preview = () => withWorkspace(env.BUCKET, userId,
          ({ workspace }) => publicationSnapshot(workspace, id, userId, token), { readOnly: true });
        if (publication[2]) return json(await preview());
        const body = await readJsonBody(nodeRequest(url.pathname, request.method, {}, bytes));
        return json(await approvePublication({
          body, preview, destination: githubPublication(token), key: publicationKey(userId, id),
        }));
      }
      return await withWorkspace(env.BUCKET, userId, async ({ root, workspace, state }) => {
        const documents = scopedDocumentApi(root, workspace);
        const insertion = url.pathname.match(/^\/api\/documents\/([^/]+)\/postits\/([^/]+)\/insert$/);
        if (insertion && request.method === 'POST') {
          const payload = await readJsonBody(nodeRequest(url.pathname, request.method, {}, bytes));
          const result = await insertArchivedPostit(documentApiClient(documents), {
            documentId: decodeURIComponent(insertion[1]),
            postitId: decodeURIComponent(insertion[2]),
            itemRevision: payload?.itemRevision,
            revision: payload?.revision,
          }, 'human-editor');
          return json(result, result.alreadyInserted ? 200 : 201);
        }
        return panel ? panelResponse(url, request, bytes, documents, state) :
          documents(url.pathname + url.search, request.method, Object.fromEntries(request.headers), bytes);
      });
    } catch (error) {
      if (error instanceof RequestError) return json({
        code: error.code, error: error.message, ...(error.fallback && { fallback: error.fallback }),
      }, error.status);
      console.error('BlockNote Site storage or route failure', error?.name, error?.code);
      return json({ code: 'SITE_ERROR', error: '시험실 요청을 처리하지 못했어요. 잠시 후 다시 확인해 주세요.' }, 503);
    }
  },
};

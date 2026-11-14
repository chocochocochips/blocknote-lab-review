import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../site/worker.mjs';

test('Cloudflare Workers AI restricts model selection and sends authenticated chat requests', async t => {
  const { generateOpinion, providerModels, validateProviderRequest } = await import('../site/ai-providers.mjs');
  const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'fake-cloudflare-token' };
  assert.throws(() => validateProviderRequest(env, 'cloudflare', '@cf/other/model'), { code: 'AI_MODEL_INVALID' });
  await assert.rejects(providerModels({ ...env, CLOUDFLARE_ACCOUNT_ID: '../other' }, 'cloudflare'),
    { code: 'AI_PROVIDER_UNCONFIGURED' });
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID + '/ai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer fake-cloudflare-token');
    assert.equal(options.redirect, 'manual');
    const payload = JSON.parse(options.body);
    assert.equal(payload.max_completion_tokens, 2048);
    assert.equal(payload.stream, false);
    assert.match(payload.messages[0].content, /합성 질문/);
    return Response.json({ choices: [{ message: { content: '합성 답변' } }] });
  });
  const models = ['@cf/qwen/qwen3.8-27b', '@cf/zai-org/glm-4.7-flash'];
  assert.deepEqual((await providerModels(env, 'cloudflare')).map(model => model.id), models);
  for (const model of models) {
    validateProviderRequest(env, 'cloudflare', model);
    assert.equal(await generateOpinion(env, 'cloudflare', model, '합성 질문', ''), '합성 답변');
  }
  const payloads = upstream.mock.calls.map(call => JSON.parse(call.arguments[1].body));
  assert.deepEqual(payloads.map(payload => [payload.model, payload.reasoning_effort]),
    [[models[0], 'low'], [models[1], undefined]]);
});

test('provider opinion uses only the selected context and the existing Post-it lifecycle', async t => {
  const origin = 'https://blocknote.test';
  const vercel = 'https://ai-gateway.vercel.sh/v1';
  const google = 'https://generativelanguage.googleapis.com/v1beta';
  const exaone = 'https://api.exaone.ai/v1/chat/completions';
  let data, generationCalls = 0, forceSaveConflict = false, injectedConflict = false;
  const env = {
    AI_GATEWAY_API_KEY: 'fake-vercel-key',
    GOOGLE_GENERATIVE_AI_API_KEY: 'fake-google-key',
    BUCKET: {
      async get() {
        const snapshot = data;
        return snapshot ? { etag: snapshot, size: Buffer.byteLength(snapshot), json: async () => JSON.parse(snapshot) } : null;
      },
      async put(_, bytes, { onlyIf }) {
        if (forceSaveConflict) { forceSaveConflict = false; injectedConflict = true; return null; }
        if (data ? onlyIf.etagMatches !== data : onlyIf.etagDoesNotMatch !== '*') return null;
        data = bytes;
        return {};
      },
    },
  };
  const selectedText = '선택한 합성 문단';
  const privateText = '선택하지 않은 합성 문단';
  const reply = '합성 의견입니다.';
  const selectedModel = 'alibaba/qwen3.8-27b';
  const allowedModels = [selectedModel, 'deepseek/deepseek-v4-pro-0813', 'anthropic/claude-sonnet-5.5',
    'anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash', 'zai/glm-5.3'];
  const googleModel = 'gemini-4-hydrogen';
  const addedGoogleModels = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
  let hydrogenStatus = 500;
  let fallbackStatus = 200;
  const googleCalls = [];
  let exaoneStatus = 401;
  let exaoneCalls = 0;
  let exaoneAbort;
  let waitForExaone;
  const reachedExaone = new Promise(resolve => { waitForExaone = resolve; });
  const exaoneLogs = [];
  const warn = console.warn;
  t.mock.method(console, 'warn', (message, ...details) => {
    if (message === 'BlockNote EXAONE upstream response') exaoneLogs.push(JSON.parse(details[0]));
    else warn(message, ...details);
  });
  let finishVercel, waitForVercel;
  const reachedVercel = new Promise(resolve => { waitForVercel = resolve; });
  const finish = new Promise(resolve => { finishVercel = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === exaone) {
      exaoneCalls++;
      assert.equal(options.headers.Authorization, 'Bearer fake-exaone-key');
      assert.equal(options.headers['x-goog-api-key'], undefined);
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, 'k-exaone_v2.5');
      assert.equal(payload.reasoning_effort, 'low');
      assert.equal(payload.max_tokens, 4096);
      assert.equal(payload.stream, true);
      assert.equal(options.headers.Accept, 'text/event-stream');
      assert.match(payload.messages[0].content, new RegExp(selectedText));
      assert.doesNotMatch(payload.messages[0].content, new RegExp(privateText));
      if (exaoneStatus === 'pending') {
        exaoneAbort = options.signal;
        waitForExaone();
        return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      if (exaoneStatus === 403) {
        return Response.json({ error: { code: 'forbidden', message: 'upstream private details: fake-exaone-key' } },
          { status: 403, headers: { 'cf-ray': '1234567890abcdef-ICN', server: 'cloudflare' } });
      }
      if (exaoneStatus !== 200) return Response.json({ description: 'upstream private details' }, { status: exaoneStatus });
      return new Response([
        'data: {"choices":[{"delta":{"reasoning_content":"추론 과정"}}]}',
        'data: {"choices":[{"delta":{"content":"엑사원 검토 "}}]}',
        'data: {"choices":[{"delta":{"content":"답변"},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.startsWith(vercel)) {
      assert.equal(options.headers.Authorization, 'Bearer fake-vercel-key');
      assert.equal(options.headers['x-goog-api-key'], undefined);
      if (url.endsWith('/models')) return Response.json({ data: [
        ...[...allowedModels].reverse().map(id => ({ id, type: 'language' })),
        { id: 'google/gemini-2.5-flash', name: 'Gemini Flash', type: 'language' },
        { id: 'google/imagen', name: 'Image', type: 'image' },
      ] });
      assert.equal(url, vercel + '/chat/completions');
      const payload = JSON.parse(options.body);
      assert.equal(payload.model, selectedModel);
      assert.equal(payload.stream, false);
      assert.match(payload.messages[0].content, new RegExp(selectedText));
      assert.doesNotMatch(payload.messages[0].content, new RegExp(privateText));
      assert.doesNotMatch(payload.messages[0].content, /client-forged/);
      generationCalls++;
      waitForVercel();
      await finish;
      forceSaveConflict = true;
      return Response.json({ choices: [{ message: { content: reply } }] });
    }
    assert.equal(options.headers['x-goog-api-key'], 'fake-google-key');
    assert.equal(options.headers.Authorization, undefined);
    if (url.includes('?pageSize=')) return Response.json({ models: [
      ...['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-1.5-flash', 'gemini-3.5-flash-lite', googleModel, 'gemini-2.5-pro']
        .map(id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })),
      ...addedGoogleModels.map(id => ({ name: 'models/' + id, supportedGenerationMethods: ['generateContent'] })),
      { name: 'models/gemini-test-image', supportedGenerationMethods: ['generateContent'] },
    ] });
    const calledModel = url.slice((google + '/models/').length, -':generateContent'.length);
    assert.ok([googleModel, 'gemini-3.6-flash'].includes(calledModel));
    googleCalls.push(calledModel);
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload).sort(), ['contents', 'generationConfig']);
    assert.deepEqual(payload.generationConfig, {
      thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: calledModel === googleModel ? 32768 : 8192,
    });
    assert.match(payload.contents[0].parts[0].text, new RegExp(reply));
    assert.doesNotMatch(JSON.parse(options.body).contents[0].parts[0].text, new RegExp(privateText));
    generationCalls++;
    const status = calledModel === googleModel ? hydrogenStatus : fallbackStatus;
    if (status !== 200) return Response.json({ error: { status: 'UNAVAILABLE' } }, { status });
    return Response.json({ candidates: [{ content: { parts: [{ text: '생각', thought: true }, { text: '재검토 완료' }] } }] });
  });
  const call = async (path, method = 'GET', body, headers = {}) => {
    const response = await worker.fetch(new Request(origin + path, {
      method, headers: { 'oai-authenticated-user-id': 'owner', origin, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, data: await response.json() };
  };
  const models = '/api/site-ai/models?provider=';
  assert.equal((await call(models + 'vercel', 'GET', undefined, { 'oai-authenticated-user-id': '' })).status, 401);
  assert.deepEqual((await call(models + 'vercel')).data.models.map(model => model.id), allowedModels);
  assert.deepEqual((await call(models + 'google')).data.models.map(model => model.id),
    ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', googleModel]);
  assert.equal((await call(models + 'unknown')).status, 400);
  assert.equal((await call(models + 'exaone')).data.code, 'AI_PROVIDER_UNCONFIGURED');
  env.EXAONE_API_KEY = 'fake-exaone-key';
  assert.deepEqual((await call(models + 'exaone')).data.models, [{ id: 'k-exaone_v2.5', name: 'K-EXAONE 2.5' }]);
  const { defaultDocumentId: id } = (await call('/api/documents')).data;
  const root = '/api/documents/' + id;
  const doc = (await call(root + '/document')).data;
  const block = (id, text) => ({ id, type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text, styles: {} }] });
  const save = await call(root + '/document', 'PUT', { documentId: id, revision: doc.revision,
    blocks: [block('chosen-block', selectedText), block('private-block', privateText)] });
  assert.equal(save.status, 200);
  const request = {
    provider: 'vercel', model: selectedModel, baseRevision: save.data.revision, targetIds: ['chosen-block'],
    prompt: '검토해 줘', requestId: 'site-ai:11111111-1111-4111-8111-111111111111', scopeText: 'client-forged',
  };
  const endpoint = root + '/site-ai';
  assert.equal((await call(endpoint, 'POST', request, { origin: 'https://else.test' })).status, 403);
  assert.equal((await call(endpoint, 'POST', { ...request, baseRevision: doc.revision })).status, 409);
  assert.equal((await call(endpoint, 'POST', { ...request, targetIds: ['missing-block'] })).status, 409);
  assert.equal((await call(endpoint, 'POST', { ...request, model: 'google/gemini-2.5-flash' })).data.code, 'AI_MODEL_INVALID');
  assert.equal(generationCalls, 0);
  const first = call(endpoint, 'POST', request);
  await reachedVercel;
  try { assert.equal((await call(endpoint, 'POST', request)).status, 409); }
  finally { finishVercel(); }
  const created = await first;
  assert.equal(created.status, 200);
  assert.equal(created.data.postit.rawContent, reply);
  assert.equal(created.data.postit.archived, false);
  assert.ok(injectedConflict);
  assert.doesNotMatch(JSON.stringify(created), /fake-(?:google|vercel)-key/);
  assert.equal((await call(endpoint, 'POST', request)).data.postit.id, created.data.postit.id);
  assert.equal(generationCalls, 1);
  const notePath = root + '/postits/' + encodeURIComponent(created.data.postit.id);
  const archived = await call(notePath + '/archive', 'POST', {});
  assert.equal(archived.data.postit.archived, true);
  const reopened = (await call(notePath)).data.postit;
  assert.equal(reopened.content, reply);
  const reviewRequest = {
    ...request, provider: 'google', model: googleModel, targetIds: [],
    reaskedFromId: reopened.id, reaskedItemRevision: reopened.itemRevision,
    requestId: 'site-ai:22222222-2222-4222-8222-222222222222',
  };
  assert.equal((await call(endpoint, 'POST', reviewRequest)).data.code, 'AI_PROVIDER_TEMPORARY');
  hydrogenStatus = 200;
  assert.equal((await call(endpoint, 'POST', reviewRequest)).status, 409);
  const reviewed = await call(endpoint, 'POST', {
    ...reviewRequest, requestId: 'site-ai:33333333-3333-4333-8333-333333333333',
  });
  assert.equal(reviewed.data.postit.rawContent, '재검토 완료');
  assert.equal(generationCalls, 3);
  assert.equal(reviewed.data.postit.model, 'Google AI Studio · ' + googleModel);
  assert.deepEqual(googleCalls, [googleModel, googleModel]);
  for (const [index, status] of [429, 503].entries()) {
    hydrogenStatus = status;
    const requestId = 'site-ai:44444444-4444-4444-8444-44444444444' + index;
    const retried = await call(endpoint, 'POST', { ...reviewRequest, requestId });
    assert.equal(retried.status, 200);
    assert.equal(retried.data.postit.model, 'Google AI Studio · gemini-3.6-flash');
    assert.equal(retried.data.postit.rawContent, '재검토 완료');
    assert.deepEqual(retried.data.fallback, { model: 'gemini-3.6-flash', httpStatus: status });
    assert.deepEqual(googleCalls.slice(-2), [googleModel, 'gemini-3.6-flash']);
  }
  fallbackStatus = 503;
  const bothFailed = await call(endpoint, 'POST', {
    ...reviewRequest, requestId: 'site-ai:55555555-5555-4555-8555-555555555555',
  });
  assert.equal(bothFailed.status, 502);
  assert.equal(bothFailed.data.code, 'AI_PROVIDER_TEMPORARY');
  assert.deepEqual(bothFailed.data.fallback, { model: 'gemini-3.6-flash', httpStatus: 503 });
  assert.equal(googleCalls.length, 8);
  assert.deepEqual((await call(root + '/document')).data, save.data);
  const insertion = { revision: save.data.revision, itemRevision: reopened.itemRevision };
  const inserted = await call(notePath + '/insert', 'POST', insertion);
  assert.equal(inserted.status, 201);
  assert.equal(inserted.data.block.content[0].text, 'AI 의견 · ' + reopened.model + '\n\n' + reply);
  assert.equal((await call(notePath + '/insert', 'POST', insertion)).data.alreadyInserted, true);
  assert.equal((await call(root + '/document')).data.revision, insertion.revision + 1);
  assert.equal((await call(notePath)).data.postit.content, reply);

  const exaoneRequest = { ...request, provider: 'exaone', model: 'k-exaone_v2.5', baseRevision: insertion.revision + 1,
    requestId: 'site-ai:44444444-4444-4444-8444-444444444444' };
  assert.equal((await call(endpoint, 'POST', { ...exaoneRequest, model: selectedModel })).data.code, 'AI_MODEL_INVALID');
  for (const [status, code] of [[401, 'AI_EXAONE_AUTH'], [403, 'AI_EXAONE_FORBIDDEN'], [429, 'AI_PROVIDER_QUOTA'], [500, 'AI_PROVIDER_TEMPORARY']]) {
    exaoneStatus = status;
    const failed = await call(endpoint, 'POST', { ...exaoneRequest, requestId: `site-ai:44444444-4444-4444-8444-444444444${status}` });
    assert.equal(failed.data.code, code);
    assert.match(failed.data.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(JSON.stringify(failed), /upstream private details|fake-exaone-key/);
  }
  assert.deepEqual(exaoneLogs.find(log => log.status === 403), {
    status: 403, bodyFormat: 'json', code: 'forbidden', message: 'upstream private details: [redacted]',
    edge: 'cloudflare', ray: '1234567890abcdef-ICN',
  });
  exaoneStatus = 200;
  const exaoneResult = await call(endpoint, 'POST', exaoneRequest);
  assert.equal(exaoneResult.status, 200);
  assert.equal(exaoneResult.data.postit.rawContent, '엑사원 검토 답변');
  assert.equal(exaoneCalls, 5);
  const exaoneNotePath = root + '/postits/' + encodeURIComponent(exaoneResult.data.postit.id);
  const exaoneArchived = await call(exaoneNotePath + '/archive', 'POST', {});
  assert.equal(exaoneArchived.data.postit.archived, true);
  const exaoneInserted = await call(exaoneNotePath + '/insert', 'POST', {
    revision: exaoneRequest.baseRevision, itemRevision: exaoneArchived.data.postit.itemRevision,
  });
  assert.equal(exaoneInserted.status, 201);
  assert.match(exaoneInserted.data.block.content[0].text, /엑사원 검토 답변/);

  const streamRequest = requestId => worker.fetch(new Request(origin + endpoint, {
    method: 'POST',
    headers: { 'oai-authenticated-user-id': 'owner', origin, 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify({ ...exaoneRequest, baseRevision: exaoneInserted.data.revision, requestId }),
  }), env);
  const streamEvents = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  exaoneStatus = 'pending';
  const pending = await streamRequest('site-ai:77777777-7777-4777-8777-777777777777');
  const reader = pending.body.getReader();
  assert.equal(JSON.parse(new TextDecoder().decode((await reader.read()).value)).type, 'waiting');
  await reachedExaone;
  await reader.cancel();
  assert.equal(exaoneAbort.aborted, true);
  // Allow the rejected request to release its document claim.
  await new Promise(resolve => setImmediate(resolve));

  exaoneStatus = 429;
  const limited = await streamRequest('site-ai:88888888-8888-4888-8888-888888888888');
  assert.match(limited.headers.get('content-type'), /application\/x-ndjson/);
  const failureEvents = await streamEvents(limited);
  assert.deepEqual(failureEvents.map(event => event.type), ['waiting', 'error']);
  assert.equal(failureEvents.at(-1).status, 429);

  exaoneStatus = 200;
  const successEvents = await streamEvents(await streamRequest('site-ai:99999999-9999-4999-8999-999999999999'));
  assert.deepEqual(successEvents.map(event => event.type), ['waiting', 'delta', 'delta', 'result']);
  assert.equal(successEvents.at(-1).result.postit.rawContent, '엑사원 검토 답변');
  assert.doesNotMatch(JSON.stringify(successEvents), /추론 과정/);
});

test('Gemini failures report a classified cause without forwarding upstream diagnostics', async t => {
  const { generateOpinion } = await import('../site/ai-providers.mjs');
  const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'test-credential' };
  const responses = [
    [400, { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] }, 'AI_GOOGLE_KEY_INVALID'],
    [400, { status: 'FAILED_PRECONDITION', message: 'User location is not supported' }, 'AI_GOOGLE_REGION'],
    [400, { status: 'FAILED_PRECONDITION', message: 'Project inactive' }, 'AI_GOOGLE_PROJECT_CONDITION'],
    [403, { details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] }, 'AI_GOOGLE_KEY_RESTRICTED'],
    [404, { status: 'NOT_FOUND' }, 'AI_GOOGLE_MODEL_UNAVAILABLE'],
    [400, { status: 'INVALID_ARGUMENT' }, 'AI_GOOGLE_BAD_REQUEST'],
    [503, {}, 'AI_PROVIDER_TEMPORARY'],
  ];
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const [status, error] = responses.shift();
    return Response.json({ error: { message: 'sensitive upstream details', ...error } }, { status });
  });
  for (const [, , code] of [...responses]) {
    await assert.rejects(generateOpinion(env, 'google', 'gemini-test', '질문', '문서'), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /sensitive upstream details|test-credential/);
      return true;
    });
  }
  assert.equal(warn.mock.callCount(), 7);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls.map(call => call.arguments)), /sensitive upstream details|test-credential/);
});

test('Google generation timeout is reported separately and never retries', async t => {
  const { generateOpinion } = await import('../site/ai-providers.mjs');
  const timeout = new DOMException('synthetic timeout', 'TimeoutError');
  const startTimeout = t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(timeout));
  const upstream = t.mock.method(globalThis, 'fetch', async (_, { signal }) => { throw signal.reason; });
  const env = { GOOGLE_GENERATIVE_AI_API_KEY: 'fake-key' };
  await assert.rejects(generateOpinion(env, 'google', 'gemini-3.5-flash', '질문', ''),
    { code: 'AI_PROVIDER_TIMEOUT', status: 504 });
  await assert.rejects(generateOpinion(env, 'google', 'gemini-4-hydrogen', '질문', ''),
    { code: 'AI_PROVIDER_TIMEOUT', status: 504, message: /60초.*Gemini 3\.6 Flash/ });
  assert.deepEqual(startTimeout.mock.calls.map(call => call.arguments), [[75_000], [60_000]]);
  assert.equal(upstream.mock.callCount(), 2);
});

test('Vercel HTTP statuses reach the UI and logs without upstream bodies or credentials', async t => {
  const { generateOpinion } = await import('../site/ai-providers.mjs');
  const secret = 'sensitive-test-credential';
  let upstreamStatus;
  const logger = t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    return Response.json({ error: { message: secret } }, { status: upstreamStatus });
  });
  for (const [status, code] of [
    [401, 'AI_VERCEL_UNAUTHORIZED'], [402, 'AI_VERCEL_PAYMENT_REQUIRED'],
    [403, 'AI_VERCEL_FORBIDDEN'], [404, 'AI_VERCEL_NOT_FOUND'], [429, 'AI_VERCEL_RATE_LIMIT'],
  ]) {
    upstreamStatus = status;
    await assert.rejects(generateOpinion({ AI_GATEWAY_API_KEY: secret }, 'vercel', 'alibaba/qwen3.8-27b', '질문', ''),
      error => error.code === code && error.message.includes('HTTP ' + status) && !error.message.includes(secret));
    assert.deepEqual(logger.mock.calls.at(-1).arguments, ['BlockNote Vercel AI Gateway generate HTTP ' + status]);
  }
});

import { isEditableParagraph, paragraphText } from '../shared/block-edit.mjs';
import { blockHash } from '../server/block-edit.mjs';
import { RequestError } from '../server/validation.mjs';
import { insertArchivedPostit, readReceipt } from './postit-insertion.mjs';

const version = '2026-07-28';
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const overwrite = { ...write, destructiveHint: true };
const fail = (status, code, message) => { throw new RequestError(status, code, message); };
const segment = encodeURIComponent;
const doc = (id, suffix = '') => '/api/documents/' + segment(id) + suffix;
const note = ({documentId, postitId}, suffix = '') => doc(documentId, '/postits/' + segment(postitId) + suffix);
const post = (api, path, body) => api(path, 'POST', body);
const patch = (api, path, body) => api(path, 'PATCH', body);

function check(schema, value, path = 'arguments') {
  const invalid = () => fail(400, 'INVALID_ARGUMENTS', '입력값을 확인해 주세요 (' + path + ').');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        schema.required.some(key => !Object.hasOwn(value, key))) invalid();
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) invalid();
      check(schema.properties[key], child, path + '.' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) invalid();
    value.forEach((child, index) => check(schema.items, child, path + '.' + index));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < schema.minLength || value.length > schema.maxLength ||
        (schema.pattern && !new RegExp(schema.pattern).test(value))) invalid();
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) invalid();
  } else if (typeof value !== schema.type) invalid();
}

async function savePostit(api, a) {
  const document = await api(doc(a.documentId, '/document'));
  const previous = (await api(doc(a.documentId, '/postits'))).postits.find(item => item.requestId === a.requestId);
  if (!previous && document.revision !== a.baseRevision) fail(409, 'REVISION_CONFLICT', '문서를 다시 읽고 답변의 근거를 확인하세요.');
  const targetIds = a.targetIds ?? [];
  if (!previous && targetIds.some(id => !document.blocks.some(block => block.id === id))) {
    fail(422, 'TARGET_CHANGED', '문서의 대상 문단을 확인하세요.');
  }
  const { postit } = await post(api, doc(a.documentId, '/postits'), {
    documentId: a.documentId, requestId: a.requestId, baseRevision: a.baseRevision,
    prompt: a.prompt, title: a.title, rawContent: a.content, targetIds, model: 'ChatGPT',
  });
  return postit.archived ? { postit } : post(api, note({ documentId: a.documentId, postitId: postit.id }, '/archive'), {});
}

async function applyEdits(api, a) {
  const prior = await readReceipt(api, a.documentId, a.requestId);
  if (prior) fail(409, 'REQUEST_ALREADY_COMMITTED', '이 요청 ID로 이미 저장했어요. 문서와 이력을 확인하세요.');
  const document = await api(doc(a.documentId, '/document'));
  if (document.revision !== a.revision) fail(409, 'REVISION_CONFLICT', '문서를 다시 읽고 수정 대상을 확인하세요.');
  const edits = a.edits.map(edit => {
    const block = document.blocks.find(entry => entry.id === edit.blockId);
    if (!isEditableParagraph(block) || paragraphText(block) !== edit.beforeText) {
      fail(409, 'EDIT_TARGET_CHANGED', '문단 내용이 바뀌었거나 서식이 있는 문단이에요.');
    }
    return { ...edit, model: 'ChatGPT', documentId: a.documentId, baseRevision: a.revision, beforeHash: blockHash(block) };
  });
  return patch(api, doc(a.documentId, '/blocks'), {
    documentId: a.documentId, revision: a.revision, requestId: a.requestId, proposalId: a.requestId,
    actor: 'ChatGPT', goal: a.goal, reason: '사용자가 대화에서 요청한 문단 수정', approval: 'approved', edits,
  });
}

const tool = (name, description, inputSchema, annotations, run) => ({ name, description, inputSchema, annotations, run });
const tools = [
  tool('list_documents', '현재 사용자의 BlockNote Site 문서 목록, 문서 ID와 변경 번호를 조회합니다.', object({}), readOnly,
    api => api('/api/documents')),
  tool('read_document', '문서의 본문 블록, 서식, 블록 ID, 변경 번호를 조회합니다.', object({documentId:id}), readOnly,
    (api, a) => api(doc(a.documentId, '/document'))),
  tool('read_document_history', '문서의 최근 저장 및 수정 이력을 조회합니다.', object({documentId:id}), readOnly,
    (api, a) => api(doc(a.documentId, '/history'))),
  tool('create_document', '사용자가 요청한 새 빈 문서를 Site에 만듭니다.', object({title:text(120)}), write,
    (api, a) => post(api, '/api/documents', a)),
  tool('update_document_details', '요청한 문서의 이름 또는 보관 상태를 바꿉니다. 최신 metadataVersion을 사용하세요.',
    object({documentId:id,metadataVersion:revision,title:text(120),archived:{type:'boolean'}}, ['documentId','metadataVersion']), overwrite,
    (api, {documentId,...a}) => {
      if (a.title === undefined && a.archived === undefined) fail(400, 'NO_CHANGE', '제목 또는 보관 상태를 지정하세요.');
      return patch(api, doc(documentId), a);
    }),
  tool('list_postits', '지정 문서의 포스트잇 목록을 조회합니다. 본문은 read_postit에서 읽으세요.', object({documentId:id}), readOnly,
    async (api, a) => {
      const { postits } = await api(doc(a.documentId, '/postits'));
      return {postits:postits.map(({ id, title, archived, itemRevision, baseRevision, createdAt }) => ({id,title,archived,itemRevision,baseRevision,createdAt}))};
    }),
  tool('read_postit', '포스트잇 원문과 편집본을 조회합니다. 재검토의 참고 자료로 사용할 수 있습니다.', object({documentId:id,postitId:id}), readOnly,
    (api, a) => api(note(a))),
  tool('save_postit', '이 대화에서 만든 의견이나 수정 제안을 문서의 보관함에 남깁니다. 문서 본문에는 적용하지 않습니다. requestId는 새 UUID를 쓰고 같은 저장을 재시도할 때 재사용하세요.',
    object({documentId:id,baseRevision:revision,requestId:id,title:text(90),prompt:text(240),content:text(20_000),targetIds:array(id,20)},
      ['documentId','baseRevision','requestId','title','prompt','content']), write, savePostit),
  tool('archive_postit', '기존 임시 포스트잇을 보관함에 넣습니다.', object({documentId:id,postitId:id}), write,
    (api, a) => post(api, note(a, '/archive'), {})),
  tool('edit_postit', '보관한 포스트잇의 제목과 편집본을 수정합니다. 원문은 유지됩니다.',
    object({documentId:id,postitId:id,itemRevision:revision,title:text(90),content:text(20_000)}), overwrite,
    (api, {documentId,postitId,...a}) => patch(api, note({documentId,postitId}), a)),
  tool('insert_postit', '사용자가 본문 삽입을 명시적으로 요청한 경우에만 보관한 포스트잇을 삽입합니다. afterId를 생략하면 문서 끝에 넣습니다.',
    object({documentId:id,postitId:id,itemRevision:revision,revision,afterId:id}, ['documentId','postitId','itemRevision','revision']), write, (api, args) => insertArchivedPostit(api, args, 'ChatGPT')),
  tool('apply_paragraph_edits', '사용자가 본문 수정을 명시적으로 요청한 경우에만 서식 없는 일반 문단 1~5개를 수정합니다. 최신 변경 번호와 각 문단의 정확한 원문을 사용하세요. 의견이나 제안만 요청한 경우 save_postit을 사용하세요.',
    object({documentId:id,revision,requestId:id,goal:text(240),edits:array(object({
      blockId:id,beforeText:{...text(20_000),minLength:0},afterText:{...text(20_000),minLength:0},
    }),5,1)}), overwrite, applyEdits),
];

const rpc = (id, payload, status = 200) => Response.json({ jsonrpc: '2.0', id, ...payload }, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const error = (id, code, message, status) => rpc(id, { error: { code, message } }, status);
const toolResult = (id, result, isError = false) => rpc(id, {
  result: { content: [{ type: 'text', text: JSON.stringify(result) }], ...(isError ? { isError } : {}) },
});

export async function handleMcp(request, readBody, withApi) {
  if (request.method !== 'POST') return error(null, -32600, 'POST required', 405);
  let message;
  try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody())); }
  catch { return error(null, -32700, 'Invalid JSON', 400); }
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (id !== undefined && typeof id !== 'string' && !Number.isSafeInteger(id))) {
    return error(null, -32600, 'Invalid JSON-RPC request', 400);
  }
  if (id === undefined) return new Response(null, { status: 202 });
  if (message.method === 'server/discover') {
    return rpc(id, { result: { supportedVersions: [version], capabilities: { tools: {} } } });
  }
  if (message.method === 'tools/list') return rpc(id, { result: { tools: tools.map(({ run, ...definition }) => definition) } });
  if (message.method !== 'tools/call') return error(id, -32601, 'Unknown method');
  if (!request.headers.get('oai-authenticated-user-id')) return error(id, -32001, 'Authentication required', 401);
  const selected = tools.find(tool => tool.name === message.params?.name);
  if (!selected) return error(id, -32602, 'Unknown tool');
  const args = message.params?.arguments ?? {};
  try {
    check(selected.inputSchema, args);
    return await withApi(async api => toolResult(id, await selected.run(api, args)));
  } catch (error) {
    if (error instanceof RequestError) return toolResult(id, { code: error.code, message: error.message }, true);
    console.error('BlockNote MCP tool failed', selected.name, error?.name);
    return toolResult(id, { code: 'SITE_ERROR', message: '작업실 요청을 처리하지 못했어요.' }, true);
  }
}

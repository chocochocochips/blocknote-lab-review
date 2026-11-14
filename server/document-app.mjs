import {isEditableParagraph, paragraphText} from '../shared/block-edit.mjs';
import {blockHash} from './block-edit.mjs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createStorage } from './storage.mjs';
import { createPostitStore, handlePostitHttp } from './postits.mjs';
import { sanitizeSingleLine } from '../shared/postit-contract.mjs';
import { readJsonBody, validateWriteRequest, validateBlocks, validateBlockType, validatePlainText, validateAfterId, validateStoredDocumentSize, validateProposalMetadata, RequestError } from './validation.mjs';

const defaultDataFile = (name) => resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', name);
const textBlock = (id, type, content, props = {}) => ({
  id, type, props, content: [{ type: 'text', text: content, styles: {} }], children: [],
});

function seed() {
  return {
    id: 'board-lab',
    revision: 1,
    updatedAt: new Date().toISOString(),
    blocks: [
      textBlock('lab-title', 'heading', 'AI Board · 공동 문서 실험', { level: 1 }),
      textBlock('lab-intro', 'paragraph', '사람은 화면을 편집하고 AI는 브라우저 없이 API로 블록을 수정합니다.'),
      textBlock('lab-goal', 'heading', '현재 목표', { level: 2 }),
      textBlock('lab-goal-body', 'paragraph', '문서 저장, 블록 ID 유지, 외부 수정 감지, 충돌 거부를 확인합니다.'),
      textBlock('lab-notes', 'heading', '검토 기록', { level: 2 }),
      textBlock('lab-notes-body', 'paragraph', '여기에 직접 작성하거나 npm run agent-demo 명령을 실행해 보세요.'),
    ],
  };
}

function respond(res, status, data, headers = {}) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(json);
}
function fail(status, message, code = 'REQUEST_REJECTED', extra = {}) {
  throw new RequestError(status, code, message, extra);
}

/** C-02: stable JSON fingerprint (key order independent), including HTTP operation/target.
 * requestId is intentionally excluded: it identifies the retry, not its payload.
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function parseRequestId(id, required = false) {
  if (id === undefined && !required) return null; // legacy callers still supported
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    fail(400, 'requestId는 1~128자의 영숫자 시작 식별자여야 합니다.', 'INVALID_REQUEST_ID');
  }
  return id;
}
function fingerprint(method, path, body) {
  const { requestId: _ignored, ...payload } = body;
  return createHash('sha256').update(stableJson({ method, path, payload })).digest('hex');
}

/** The B-02 write gate serializes revision-check + commit within ONE Node process.
 * Cross-process writers must not share documentFile until a separate lock/store exists.
 */
function createWriteGate() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function hasNestedBlockId(blocks, id) {
  const stack = blocks.flatMap(block => block.children ?? []);
  while (stack.length) {
    const block = stack.pop();
    if (block.id === id) return true;
    stack.push(...(block.children ?? []));
  }
  return false;
}

/** Reject any inline structure that a text-only PATCH would silently destroy. */
function isSafePlainTextLeaf(block) {
  if (block.children.length !== 0 || block.content.length !== 1) return false;
  const inline = block.content[0];
  if (!inline || inline.type !== 'text' || typeof inline.text !== 'string' ||
      !inline.styles || Array.isArray(inline.styles) || typeof inline.styles !== 'object') return false;
  if (Object.keys(inline.styles).length !== 0) return false;
  // Reject link/mention/custom metadata even if the base node is type=text.
  return Object.keys(inline).every(key => key === 'type' || key === 'text' || key === 'styles');
}

export function createDocumentHandler({ documentFile = defaultDataFile('document.json'), historyFile = defaultDataFile('history.jsonl'), postitsFile, postitStore, getDocumentTitle, storageFaults, strict = false, requireDocumentId = false, canWrite = () => true } = {}) {
  const storage = createStorage({ documentFile, historyFile, initialDocument: seed(), faults: storageFaults, strict });
  const postits = postitStore ?? createPostitStore({ filePath: postitsFile ?? resolve(dirname(documentFile), 'postits.json') });
  const readDoc = storage.readDocument;
  const withWriteGate = createWriteGate();
  const commit = (previous, updated, actor, operation, blockId = null, receipt = null, proposal = null) => {
    const next = { ...updated, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
    validateStoredDocumentSize(next);
    storage.writeDocument(previous, next, actor, operation, blockId, receipt, proposal);
    return next;
  };
  // Called inside the same write gate as revision CAS and commit. Replays must be
  // checked BEFORE revision validation because a successful first write advances it.
  const lookupReplay = (req, res, data, statusPath) => {
    validateDocumentId(data, readDoc());
    const requestId = parseRequestId(data.requestId);
    if (!requestId) return { requestId: null, fingerprint: null, handled: false };
    const digest = fingerprint(req.method, statusPath, data);
    const existing = storage.findRequest(requestId); // also recovers any B-03 pending journal
    if (!existing) return { requestId, fingerprint: digest, handled: false };
    if (existing.fingerprint !== digest) {
      fail(409, 'requestId가 다른 요청 내용으로 재사용되었습니다.', 'REQUEST_ID_REUSED', { requestId });
    }
    respond(res, existing.status, existing.body, { 'Idempotent-Replay': 'true' });
    return { requestId, fingerprint: digest, handled: true };
  };
  const receiptFor = (idInfo, status, body) => idInfo.requestId ? {
    requestId: idInfo.requestId, fingerprint: idInfo.fingerprint, status, body,
  } : null;

  const validateDocumentId = (data, doc) => {
    if (!canWrite()) fail(409, '보관된 문서를 먼저 복원하세요.', 'DOCUMENT_ARCHIVED');
    if ((requireDocumentId || data.documentId !== undefined) && data.documentId !== doc.id)
      fail(409, '문서 ID가 일치하지 않습니다.', 'DOCUMENT_ID_MISMATCH');
  };
  const validateRevision = (data, doc) => {
    validateDocumentId(data, doc);
    // Shape and positive-safe-integer checks are done by validateWriteRequest.
    if (data.revision !== doc.revision) fail(409, '문서가 다른 곳에서 변경되었습니다. 새 버전을 읽고 다시 시도하세요.', 'REVISION_CONFLICT', { currentRevision: doc.revision });
  };

  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api/postits' || url.pathname.startsWith('/api/postits/')) {
        const doc = readDoc();
        const defaultDocumentTitle = typeof getDocumentTitle === 'function' ? getDocumentTitle() : '내 작업실 문서';
        return await handlePostitHttp(req, res, { store: postits, defaultDocumentId: doc.id, defaultDocumentTitle });
      }
      if (req.method === 'GET' && url.pathname === '/api/document') {
        return respond(res, 200, readDoc());
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        return respond(res, 200, { events: storage.readHistory().slice(-30).reverse() });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/requests/')) {
        let id;
        try { id = decodeURIComponent(url.pathname.slice('/api/requests/'.length)); }
        catch { fail(400, '요청 ID URL 인코딩이 유효하지 않습니다.', 'INVALID_REQUEST_ID'); }
        parseRequestId(id, true);
        const receipt = storage.findRequest(id);
        if (!receipt) fail(404, '해당 requestId의 확정된 결과가 없습니다.', 'REQUEST_NOT_FOUND');
        return respond(res, 200, {
          requestId: id, outcome: 'COMMITTED', transactionId: receipt.transactionId,
          revision: receipt.revision, httpStatus: receipt.status, result: receipt.body,
        });
      }

      if (req.method === 'PUT' && url.pathname === '/api/document') {
        const data = await readJsonBody(req);
        const actor = validateWriteRequest(data, 'user');
        return await withWriteGate(() => {
          const doc = readDoc(); validateRevision(data, doc);
          validateBlocks(data.blocks);
          return respond(res, 200, commit(doc, { ...doc, blocks: data.blocks }, actor, 'document.save'));
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/blocks') {
        const data = await readJsonBody(req);
        const actor = validateWriteRequest(data, 'agent');
        const proposal = validateProposalMetadata(data);
        if(proposal?.edits)fail(422,'INVALID_BATCH','단일 문단 경로에서는 일괄 수정할 수 없습니다.');
        parseRequestId(data.requestId, Boolean(proposal));
        return await withWriteGate(() => {
          const idInfo = lookupReplay(req, res, data, url.pathname);
          if (idInfo.handled) return;
          const doc = readDoc(); validateRevision(data, doc);
          validatePlainText(data.content);
          validateAfterId(data.afterId);
          if(proposal?.edit||proposal?.edits) fail(422,'수정 이력은 PATCH에만 사용할 수 있습니다.','INVALID_EDIT_METADATA');
          const type = data.type ?? 'paragraph';
          validateBlockType(type);
          const opinionModel = sanitizeSingleLine(data.opinionModel, 128);
          const content = opinionModel ? 'AI 의견 · ' + opinionModel + '\n\n' + data.content : data.content;
          const block = textBlock(randomUUID(), type, content, type === 'heading' ? { level: 2 } : {});
          const blocks = [...doc.blocks];
          if (data.afterId === null || data.afterId === undefined) blocks.push(block);
          else {
            const i = blocks.findIndex(item => item.id === data.afterId);
            if (i === -1) {
              if (hasNestedBlockId(doc.blocks, data.afterId)) {
                fail(422, '중첩 블록 뒤에 삽입할 수 없습니다.', 'UNSUPPORTED_NESTED_POSITION');
              }
              fail(404, 'afterId 블록이 없습니다.', 'POSITION_NOT_FOUND');
            }
            blocks.splice(i + 1, 0, block);
          }
          validateBlocks(blocks);
          const result = { revision: doc.revision + 1, block };
          commit(doc, { ...doc, blocks }, actor, 'block.insert', block.id, receiptFor(idInfo, 201, result), proposal);
          return respond(res, 201, result);
        });
      }
      if(req.method==='PATCH' && url.pathname==='/api/blocks'){
        const data=await readJsonBody(req),actor=validateWriteRequest(data,'agent'),proposal=validateProposalMetadata(data);
        if(!proposal?.edits)fail(422,'INVALID_BATCH','검토한 수정안이 필요합니다.');parseRequestId(data.requestId,true);
        return await withWriteGate(()=>{
          const replay=lookupReplay(req,res,data,url.pathname);if(replay.handled)return;
          const doc=readDoc();validateRevision(data,doc);const replacements=new Map();
          for(const edit of proposal.edits){
            const target=doc.blocks.find(b=>b.id===edit.blockId);
            if(edit.documentId!==doc.id||data.documentId!==doc.id||edit.baseRevision!==doc.revision||!target||!isEditableParagraph(target)||
              edit.beforeHash!==blockHash(target)||edit.beforeText!==paragraphText(target))fail(409,'EDIT_TARGET_CHANGED','선택한 문단 중 변경된 내용이 있습니다. 전체 저장을 중지했습니다.');
            validatePlainText(edit.afterText);replacements.set(edit.blockId,{...target,content:[{type:'text',text:edit.afterText,styles:{}}]});
          }
          const blocks=doc.blocks.map(b=>replacements.get(b.id)??b);validateBlocks(blocks);
          const result={revision:doc.revision+1,blockIds:[...replacements.keys()]};commit(doc,{...doc,blocks},actor,'blocks.update',null,receiptFor(replay,200,result),proposal);return respond(res,200,result);
        });
      }
      if (req.method === 'PATCH' && url.pathname.startsWith('/api/blocks/')) {
        const data = await readJsonBody(req);
        const actor = validateWriteRequest(data, 'agent');
        let blockId;
        try { blockId = decodeURIComponent(url.pathname.slice('/api/blocks/'.length)); }
        catch { fail(400, '블록 ID URL 인코딩이 유효하지 않습니다.', 'INVALID_BLOCK_ID'); }
        if (!blockId || blockId.length > 128 || blockId.includes('/')) fail(400, '블록 ID가 유효하지 않습니다.', 'INVALID_BLOCK_ID');
        const proposal = validateProposalMetadata(data);
        if(proposal?.edits)fail(422,'INVALID_BATCH','단일 문단 경로에서는 일괄 수정할 수 없습니다.');
        parseRequestId(data.requestId, Boolean(proposal));
        return await withWriteGate(() => {
          const idInfo = lookupReplay(req, res, data, url.pathname);
          if (idInfo.handled) return;
          const doc = readDoc(); validateRevision(data, doc);
          validatePlainText(data.content);
          const index = doc.blocks.findIndex(block => block.id === blockId);
          if (index < 0) {
            if (hasNestedBlockId(doc.blocks, blockId)) {
              fail(422, '중첩 블록은 이 API로 수정할 수 없습니다.', 'UNSUPPORTED_NESTED_OPERATION');
            }
            fail(404, '해당 블록이 없습니다.', 'BLOCK_NOT_FOUND');
          }
          const target = doc.blocks[index];
          if (target.children.length !== 0) {
            fail(422, '자식 블록이 있는 항목은 이 API로 수정할 수 없습니다.', 'UNSUPPORTED_NESTED_OPERATION');
          }
          if (proposal?.edit) {
            const edit=proposal.edit;
            if (edit.documentId!==doc.id || data.documentId!==doc.id || edit.blockId!==blockId ||
                edit.baseRevision!==doc.revision || edit.afterText!==data.content ||
                edit.beforeHash!==blockHash(target) || edit.beforeText!==paragraphText(target))
              fail(409,'검토한 문서 또는 대상 문단이 변경되었습니다.','EDIT_TARGET_CHANGED');
            if (!isEditableParagraph(target)) fail(422,'서식 없는 일반 문단만 수정할 수 있습니다.','UNSUPPORTED_EDIT_TARGET');
          }
          if (!proposal?.edit && !isSafePlainTextLeaf(target)) {
            fail(422, '서식·링크·복합 인라인을 평문으로 덮어쓸 수 없습니다.', 'RICH_CONTENT_REQUIRES_SAFE_EDIT');
          }
          const blocks = [...doc.blocks];
          blocks[index] = { ...target, content: [{ type: 'text', text: data.content, styles: {} }] };
          validateBlocks(blocks);
          const result = { revision: doc.revision + 1, block: blocks[index] };
          commit(doc, { ...doc, blocks }, actor, 'block.update', blockId, receiptFor(idInfo, 200, result), proposal);
          return respond(res, 200, result);
        });
      }
      return respond(res, 404, { error: '경로를 찾을 수 없습니다.' });
    } catch (error) {
      return respond(res, error.status ?? 500, {
        error: error.status ? error.message : '서버 오류가 발생했습니다.',
        code: error.code ?? 'STORAGE_ERROR',
        ...(error.extra ?? {}),
      });
    }
  };
}

export function createApp(options) { return createServer(createDocumentHandler(options)); }

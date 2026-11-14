/**
 * B-05 / B-06: Independent server-side Post-it storage and HTTP handler.
 * Stores Post-its in an atomic JSON store (`postits.json`) completely separate
 * from `document.json` and `history.jsonl`, ensuring that creating, archiving,
 * editing, or re-asking Post-its NEVER increments main document revision.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, openSync, closeSync, fsyncSync, lstatSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, readJsonBody } from './validation.mjs';
import {
  POSTIT_LIMITS, isValidPostitId, sanitizeSingleLine, derivePostitTitle,
} from '../shared/postit-contract.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const CONTROL_CHECK = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function fail(status, code, message, extra = {}) {
  throw new RequestError(status, code, message, extra);
}

function atomicWriteJson(filePath, data) {
  const encoded = JSON.stringify(data, null, 2);
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > POSTIT_LIMITS.maxFileBytes) {
    fail(413, 'POSTIT_STORE_TOO_LARGE', '포스트잇 저장소 용량 한도(2MB)를 초과했습니다.');
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, encoded, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, filePath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function validateTextContent(text, maxLength, code, label) {
  if (typeof text !== 'string' || !text.trim() || text.length > maxLength || CONTROL_CHECK.test(text)) {
    fail(422, code, `${label}은(는) 제어문자 없는 1~${maxLength}자 텍스트여야 합니다.`);
  }
  return text;
}

function createWriteGate() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createPostitStore({ filePath, ownerScope = 'local-owner', now = () => new Date().toISOString(), documentExists=()=>true }) {
  filePath = resolve(filePath);
  const withGate = createWriteGate();

  function readState() {
    if (!existsSync(filePath)) {
      return { formatVersion: 1, postits: [], restoredDigests: [] };
    }
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size>POSTIT_LIMITS.maxFileBytes) {
      fail(503, 'UNSAFE_POSTIT_STORE', '포스트잇 저장소 파일 형식이 안전하지 않습니다.');
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      fail(503, 'POSTIT_STORE_CORRUPT', '포스트잇 저장소 JSON이 손상되었습니다. 자동 초기화하지 않습니다.');
    }
    if (!parsed || parsed.formatVersion !== 1 || !Array.isArray(parsed.postits) || parsed.postits.length>POSTIT_LIMITS.maxItems ||
        (parsed.restoredDigests!==undefined && (!Array.isArray(parsed.restoredDigests)||parsed.restoredDigests.some(d=>typeof d!=='string'||!/^[0-9a-f]{64}$/.test(d))))) {
      fail(503, 'POSTIT_STORE_CORRUPT', '포스트잇 저장소 구조가 유효하지 않습니다.');
    }
    const ids=new Set(), requests=new Set();
    for(const item of parsed.postits){
      const requestKey=item?.documentId+'\0'+item?.requestId;
      if(!item||typeof item!=='object'||Array.isArray(item)||!isValidPostitId(item.id)||!isValidPostitId(item.documentId)||!isValidPostitId(item.requestId)||
         item.ownerScope!==ownerScope||ids.has(item.id)||requests.has(requestKey)||typeof item.archived!=='boolean'||
         !Number.isSafeInteger(item.baseRevision)||item.baseRevision<1||!Number.isSafeInteger(item.itemRevision)||item.itemRevision<1||
         !Array.isArray(item.targetIds)||item.targetIds.length>POSTIT_LIMITS.maxTargetIds||new Set(item.targetIds).size!==item.targetIds.length||item.targetIds.some(id=>!isValidPostitId(id))||
         typeof item.scopeText!=='string'||item.scopeText.length>POSTIT_LIMITS.maxScopeTextLength||CONTROL_CHECK.test(item.scopeText)||
         (item.proposalId!==null&&!isValidPostitId(item.proposalId))||(item.reaskedFromId!==null&&!isValidPostitId(item.reaskedFromId))||
         [[item.title,POSTIT_LIMITS.maxTitleLength],[item.documentTitle,120],[item.model,128],[item.prompt,POSTIT_LIMITS.maxPromptLength]].some(([value,max])=>typeof value!=='string'||!value.trim()||value.length>max||/[\r\n]/.test(value)||CONTROL_CHECK.test(value))||
         typeof item.rawContent!=='string'||!item.rawContent.trim()||item.rawContent.length>POSTIT_LIMITS.maxContentLength||CONTROL_CHECK.test(item.rawContent)||
         typeof item.content!=='string'||!item.content.trim()||item.content.length>POSTIT_LIMITS.maxContentLength||CONTROL_CHECK.test(item.content)||
         !Number.isFinite(Date.parse(item.createdAt))||(item.archived?!Number.isFinite(Date.parse(item.archivedAt)):item.archivedAt!==null)||
         (item.updatedAt!==null&&(!item.archived||!Number.isFinite(Date.parse(item.updatedAt))))||
         (item.archivedAt&&Date.parse(item.archivedAt)<Date.parse(item.createdAt))||(item.updatedAt&&Date.parse(item.updatedAt)<Date.parse(item.archivedAt))||
         (!item.archived&&item.content!==item.rawContent))
        fail(503,'POSTIT_STORE_CORRUPT','포스트잇 저장소가 손상되었습니다. 자동 초기화하지 않습니다.');
      ids.add(item.id);requests.add(requestKey);
    }
    return {
      formatVersion: 1,
      postits: parsed.postits,
      restoredDigests: Array.isArray(parsed.restoredDigests) ? parsed.restoredDigests : [],
    };
  }

  function assertScope(scope) {
    if (scope !== undefined && scope !== ownerScope) {
      fail(403, 'POSTIT_FORBIDDEN', '다른 사용자의 포스트잇 데이터에 접근할 수 없습니다.');
    }
  }

  function sortPostits(items) {
    return [...items].sort((a, b) => {
      const timeA = Date.parse(a.updatedAt || a.archivedAt || a.createdAt || 0) || 0;
      const timeB = Date.parse(b.updatedAt || b.archivedAt || b.createdAt || 0) || 0;
      return timeB - timeA;
    });
  }

  return {
    filePath,
    list({ documentId, status, scope } = {}) {
      assertScope(scope);
      const state = readState();
      let items = state.postits.filter(p => p.ownerScope === ownerScope);
      if (documentId) {
        if (!isValidPostitId(documentId)) fail(400, 'INVALID_DOCUMENT_ID', '유효한 문서 ID가 필요합니다.');
        items = items.filter(p => p.documentId === documentId);
      }
      if (status === 'archived') items = items.filter(p => p.archived === true);
      else if (status === 'draft') items = items.filter(p => p.archived === false);
      return sortPostits(items);
    },

    get(id, { scope } = {}) {
      assertScope(scope);
      if (!isValidPostitId(id)) fail(400, 'INVALID_POSTIT_ID', '유효하지 않은 포스트잇 ID입니다.');
      const state = readState();
      const item = state.postits.find(p => p.id === id);
      if (!item) fail(404, 'POSTIT_NOT_FOUND', '해당 포스트잇을 찾을 수 없습니다.');
      if (item.ownerScope !== ownerScope) fail(403, 'POSTIT_FORBIDDEN', '접근 권한이 없는 포스트잇입니다.');
      return item;
    },

    async createDraft(payload = {}) {
      return withGate(() => {
        assertScope(payload.ownerScope);
        const state = readState();
        const documentId = payload.documentId ?? 'board-lab';
        if (!isValidPostitId(documentId)) fail(400, 'INVALID_DOCUMENT_ID', '문서 ID가 유효하지 않습니다.');
        if(!documentExists(documentId))fail(409,'POSTIT_DOCUMENT_MISSING','연결된 문서가 없어 저장할 수 없습니다.');
        const requestId = payload.requestId ? String(payload.requestId) : `postit-req:${randomUUID()}`;
        if (!isValidPostitId(requestId)) fail(400, 'INVALID_REQUEST_ID', 'requestId 형식이 유효하지 않습니다.');

        const rawContent = validateTextContent(
          payload.rawContent ?? payload.content,
          POSTIT_LIMITS.maxContentLength,
          'INVALID_POSTIT_CONTENT',
          'AI 답변 원문',
        );
        if((typeof payload.prompt==='string'&&payload.prompt.length>POSTIT_LIMITS.maxPromptLength)||(typeof payload.model==='string'&&payload.model.length>128)||(typeof payload.title==='string'&&payload.title.length>POSTIT_LIMITS.maxTitleLength))fail(422,'INVALID_POSTIT_METADATA','포스트잇 정보가 너무 깁니다.');
        if(payload.proposalId!=null&&!isValidPostitId(payload.proposalId))fail(422,'INVALID_POSTIT_METADATA','제안 ID를 확인하세요.');
        if(payload.baseRevision!==undefined&&(!Number.isSafeInteger(payload.baseRevision)||payload.baseRevision<1))fail(422,'INVALID_POSTIT_METADATA','문서 버전을 확인하세요.');
        const prompt = sanitizeSingleLine(payload.prompt ?? payload.goal ?? 'AI 의견 요청', POSTIT_LIMITS.maxPromptLength, 'AI 의견 요청');
        if (CONTROL_CHECK.test(prompt)) fail(422, 'INVALID_POSTIT_PROMPT', '질문 내용에 제어문자를 포함할 수 없습니다.');
        const model = sanitizeSingleLine(payload.model ?? '모델 미상', 128, '모델 미상');
        const title = sanitizeSingleLine(
          payload.title || derivePostitTitle(prompt, model),
          POSTIT_LIMITS.maxTitleLength,
          'AI 검토 의견',
        );
        const documentTitle = sanitizeSingleLine(payload.documentTitle ?? '내 작업실 문서', 120, '내 작업실 문서');
        const baseRevision = Number.isSafeInteger(payload.baseRevision) && payload.baseRevision >= 1 ? payload.baseRevision : 1;

        const targetIds = payload.targetIds ?? [];
        if(!Array.isArray(targetIds)||targetIds.length>POSTIT_LIMITS.maxTargetIds||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>!isValidPostitId(id)))
          fail(422,'INVALID_POSTIT_TARGETS','선택 문단을 확인하세요.');
        const scopeText = payload.scopeText ?? '';
        if(typeof scopeText!=='string'||scopeText.length>POSTIT_LIMITS.maxScopeTextLength||CONTROL_CHECK.test(scopeText))
          fail(422,'INVALID_POSTIT_SCOPE','참고 내용이 유효하지 않거나 너무 깁니다.');
        if(payload.reaskedFromId!=null&&!isValidPostitId(payload.reaskedFromId))fail(422,'INVALID_POSTIT_REASK','참고 답변을 확인하세요.');
        const reaskedFromId=payload.reaskedFromId??null;

        // Idempotent deduplication by (documentId, requestId)
        const existing = state.postits.find(p => p.ownerScope === ownerScope && p.documentId === documentId && p.requestId === requestId);
        if (existing) {
          if (existing.rawContent !== rawContent || existing.proposalId !== (payload.proposalId??null) ||
              existing.baseRevision!==baseRevision || existing.model!==model || existing.prompt!==prompt ||
              existing.scopeText!==scopeText || existing.reaskedFromId!==reaskedFromId || JSON.stringify(existing.targetIds)!==JSON.stringify(targetIds)) {
            fail(409, 'POSTIT_REQUEST_ID_REUSED', '동일한 requestId로 다른 답변 원문을 임시 저장할 수 없습니다.');
          }
          return { postit: existing, replayed: true };
        }

        if (state.postits.length >= POSTIT_LIMITS.maxItems) {
          fail(409, 'POSTIT_LIMIT_EXCEEDED', '포스트잇 저장 한도(200개)를 초과했습니다.');
        }

        const createdAt = now();
        if(payload.id!==undefined&&!isValidPostitId(payload.id))fail(422,'INVALID_POSTIT_ID','포스트잇 ID를 확인하세요.');
        const id = payload.id ?? `postit:${randomUUID()}`;
        if (state.postits.some(p => p.id === id)) {
          fail(409, 'POSTIT_ID_COLLISION', '이미 존재하는 포스트잇 ID입니다.');
        }

        const postit = {
          id,
          ownerScope,
          documentId,
          documentTitle,
          baseRevision,
          targetIds,
          scopeText,
          reaskedFromId,
          requestId,
          proposalId: payload.proposalId && isValidPostitId(payload.proposalId) ? payload.proposalId : null,
          model,
          prompt,
          title,
          rawContent,
          content: rawContent,
          archived: false,
          createdAt,
          archivedAt: null,
          updatedAt: null,
          itemRevision: 1,
        };

        state.postits.unshift(postit);
        atomicWriteJson(filePath, state);
        return { postit, replayed: false };
      });
    },

    async archive(id, payload = {}) {
      return withGate(() => {
        assertScope(payload.ownerScope);
        if (!isValidPostitId(id)) fail(400, 'INVALID_POSTIT_ID', '유효하지 않은 포스트잇 ID입니다.');
        const state = readState();
        const index = state.postits.findIndex(p => p.id === id);
        if (index < 0) fail(404, 'POSTIT_NOT_FOUND', '보관할 포스트잇을 찾을 수 없습니다.');
        const current = state.postits[index];
        if (current.ownerScope !== ownerScope) fail(403, 'POSTIT_FORBIDDEN', '접근 권한이 없는 포스트잇입니다.');

        if (current.archived) {
          return current;
        }

        // B-05 core invariant: archiving sets archivedAt, does NOT change updatedAt or rawContent!
        const updated = {
          ...current,
          archived: true,
          archivedAt: current.archivedAt || now(),
          updatedAt: current.updatedAt, // remains null unless previously explicitly saved
          itemRevision: current.itemRevision + 1,
        };
        state.postits[index] = updated;
        atomicWriteJson(filePath, state);
        return updated;
      });
    },

    async saveEdit(id, payload = {}) {
      return withGate(() => {
        assertScope(payload.ownerScope);
        if (!isValidPostitId(id)) fail(400, 'INVALID_POSTIT_ID', '유효하지 않은 포스트잇 ID입니다.');
        const state = readState();
        const index = state.postits.findIndex(p => p.id === id);
        if (index < 0) fail(404, 'POSTIT_NOT_FOUND', '수정할 포스트잇을 찾을 수 없습니다.');
        const current = state.postits[index];
        if (current.ownerScope !== ownerScope) fail(403, 'POSTIT_FORBIDDEN', '접근 권한이 없는 포스트잇입니다.');

        // B-05 core invariant: unarchived temporary post-its cannot be edited!
        if (!current.archived) {
          fail(409, 'POSTIT_NOT_ARCHIVED', '임시 저장된 답변 원문은 수정할 수 없습니다. 먼저 보관하세요.');
        }

        if (!Number.isSafeInteger(payload.itemRevision) || payload.itemRevision !== current.itemRevision) {
          fail(409, 'POSTIT_CONFLICT', '포스트잇이 다른 곳에서 먼저 변경되었습니다. 최신 내용을 확인하세요.', {
            currentItemRevision: current.itemRevision,
          });
        }

        if(typeof payload.title!=='string'||payload.title.length>POSTIT_LIMITS.maxTitleLength)fail(422,'INVALID_POSTIT_TITLE','제목 길이를 확인하세요.');
        const nextTitle = sanitizeSingleLine(payload.title, POSTIT_LIMITS.maxTitleLength, '');
        if (!nextTitle || CONTROL_CHECK.test(String(payload.title ?? ''))) {
          fail(422, 'INVALID_POSTIT_TITLE', '제목은 제어문자 없는 1~90자로 입력하세요.');
        }
        const nextContent = validateTextContent(
          payload.content,
          POSTIT_LIMITS.maxContentLength,
          'INVALID_POSTIT_CONTENT',
          '포스트잇 내용',
        );

        const updated = {
          ...current,
          title: nextTitle,
          content: nextContent,
          // rawContent is NEVER overwritten
          rawContent: current.rawContent,
          updatedAt: now(),
          itemRevision: current.itemRevision + 1,
        };
        state.postits[index] = updated;
        atomicWriteJson(filePath, state);
        return updated;
      });
    },

    prepareReask(id, payload = {}) {
      assertScope(payload.ownerScope);
      if (payload.hasUnsavedEdit === true) {
        fail(409, 'POSTIT_UNSAVED_EDIT', '저장하지 않은 수정 내용이 있습니다. 변경 저장 후 다시 질문하세요.');
      }
      const item = this.get(id, { scope: payload.ownerScope });
      return {
        reaskedFromId: item.id,
        documentId: item.documentId,
        title: item.title,
        confirmedContent: item.content,
        rawContent: item.rawContent,
        archived: item.archived,
        itemRevision: item.itemRevision,
        scopeText: `[포스트잇 재검토: ${item.title}] ${item.content}`,
      };
    },

    exportBundle({ documentId, scope } = {}) {
      const items = this.list({ documentId, scope });
      const serialized = JSON.stringify(items, null, 2);
      const digest = sha256(serialized);
      return {
        manifest: {
          format: 'blocknote-postits',
          formatVersion: 1,
          exportedAt: now(),
          count: items.length,
          digest,
        },
        postits: items,
      };
    },

    async restoreBundle(bundle = {}, { scope } = {}) {
      return withGate(() => {
        assertScope(scope);
        const manifest = bundle?.manifest;
        const incoming = bundle?.postits;
        if (!manifest || manifest.format !== 'blocknote-postits' || manifest.formatVersion !== 1 || !Array.isArray(incoming)) {
          fail(400, 'INVALID_POSTIT_BACKUP', '유효한 포스트잇 백업 파일이 아닙니다.');
        }
        const serialized = JSON.stringify(incoming, null, 2);
        const computedDigest = sha256(serialized);
        if (manifest.digest !== computedDigest) {
          fail(400, 'POSTIT_BACKUP_CHECKSUM_MISMATCH', '포스트잇 백업 무결성 해시가 일치하지 않습니다.');
        }
        const state = readState();
        if (state.restoredDigests.includes(computedDigest)) {
          fail(409, 'DUPLICATE_POSTIT_BACKUP', '이미 복원한 포스트잇 백업입니다.');
        }
        if(manifest.count!==incoming.length || !Number.isFinite(Date.parse(manifest.exportedAt)) || incoming.length>POSTIT_LIMITS.maxItems)
          fail(400,'INVALID_POSTIT_BACKUP','백업 메타데이터가 유효하지 않습니다.');
        const existingIds = new Set(state.postits.map(p => p.id));
        const existingRequests = new Set(state.postits.map(p => p.documentId+'\0'+p.requestId));
        const validTime = v => typeof v==='string' && Number.isFinite(Date.parse(v));
        const expectedKeys=['id','ownerScope','documentId','documentTitle','baseRevision','targetIds','scopeText','reaskedFromId','requestId','proposalId','model','prompt','title','rawContent','content','archived','createdAt','archivedAt','updatedAt','itemRevision'].sort().join(',');
        const restored = [];
        for (const item of incoming) {
          if (!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).sort().join(',')!==expectedKeys ||
              !isValidPostitId(item.id) || !isValidPostitId(item.documentId) || !isValidPostitId(item.requestId) ||
              item.ownerScope!==ownerScope || !Number.isSafeInteger(item.baseRevision) || item.baseRevision<1 ||
              !Number.isSafeInteger(item.itemRevision) || item.itemRevision<1 || typeof item.archived!=='boolean' ||
              !validTime(item.createdAt) || (item.archived ? !validTime(item.archivedAt) : item.archivedAt!==null) ||
              (item.updatedAt!==null && (!item.archived || !validTime(item.updatedAt))) ||
              (item.archivedAt && Date.parse(item.archivedAt)<Date.parse(item.createdAt)) ||
              (item.updatedAt && Date.parse(item.updatedAt)<Date.parse(item.archivedAt)) ||
              !Array.isArray(item.targetIds) || item.targetIds.length>POSTIT_LIMITS.maxTargetIds || new Set(item.targetIds).size!==item.targetIds.length || item.targetIds.some(id=>!isValidPostitId(id)) ||
              typeof item.scopeText!=='string' || item.scopeText.length>POSTIT_LIMITS.maxScopeTextLength || CONTROL_CHECK.test(item.scopeText) ||
              (item.reaskedFromId!==null&&!isValidPostitId(item.reaskedFromId)) || (item.proposalId!==null&&!isValidPostitId(item.proposalId)))
            fail(400,'INVALID_POSTIT_BACKUP','백업 내 포스트잇 메타데이터가 유효하지 않습니다.');
          for(const [value,max] of [[item.title,POSTIT_LIMITS.maxTitleLength],[item.documentTitle,120],[item.model,128],[item.prompt,POSTIT_LIMITS.maxPromptLength]])
            if(typeof value!=='string'||!value.trim()||value.length>max||CONTROL_CHECK.test(value)||/[\r\n]/.test(value))fail(400,'INVALID_POSTIT_BACKUP','백업 텍스트가 유효하지 않습니다.');
          validateTextContent(item.rawContent, POSTIT_LIMITS.maxContentLength, 'INVALID_POSTIT_BACKUP', '백업 원문');
          validateTextContent(item.content, POSTIT_LIMITS.maxContentLength, 'INVALID_POSTIT_BACKUP', '백업 본문');
          if(!item.archived&&(item.content!==item.rawContent||item.updatedAt!==null))fail(400,'INVALID_POSTIT_BACKUP','임시 답변 원문이 손상되었습니다.');
          if(!documentExists(item.documentId))fail(409,'POSTIT_DOCUMENT_MISSING','연결된 문서가 없어 복원을 중단했습니다.');
          const requestKey=item.documentId+'\0'+item.requestId;
          if(existingIds.has(item.id)||existingRequests.has(requestKey))fail(409,'POSTIT_RESTORE_CONFLICT','이미 존재하는 포스트잇과 충돌합니다.');
          existingIds.add(item.id);existingRequests.add(requestKey);restored.push({...item});
        }
        if (state.postits.length + restored.length > POSTIT_LIMITS.maxItems) {
          fail(409, 'POSTIT_LIMIT_EXCEEDED', '포스트잇 최대 보관 개수를 초과하여 복원을 중단했습니다.');
        }
        state.postits.push(...restored);
        state.restoredDigests.push(computedDigest);
        atomicWriteJson(filePath, state);
        return { restoredCount: restored.length, postits: sortPostits(state.postits) };
      });
    },
  };
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

/**
 * Shared HTTP handler for `/api/postits(...)` and `/api/documents/:docId/postits(...)`.
 */
export async function handlePostitHttp(req, res, { store, defaultDocumentId, defaultDocumentTitle, hosted = false } = {}) {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;
  const scopedDocId = defaultDocumentId || url.searchParams.get('documentId') || undefined;
  // Local single-user store only. A caller-supplied header is never identity.
  if(req.headers['x-blocknote-owner']!==undefined)fail(403,'POSTIT_FORBIDDEN','사용자 식별 헤더는 허용하지 않습니다.');
  const ownerScope = 'local-owner';
  // Browser-originated access is limited to the one local editor. No external
  // owner header, cross-site form or untrusted Host acts as authorization.
  if (!hosted) {
    let host;try{host=new URL('http://'+req.headers.host);}catch{fail(403,'POSTIT_BAD_HOST','로컬 주소를 확인하세요.');}
    if(!['127.0.0.1','localhost'].includes(host.hostname)||host.username||host.password||host.pathname!=='/'||host.search||host.hash)
      fail(403,'POSTIT_BAD_HOST','로컬 주소를 확인하세요.');
    const editorPort=process.env.LAB_B10_03_ISOLATED==='1'?'45173':process.env.LAB_B09_FOLLOWUP==='1'?'35173':process.env.LAB_B09_ISOLATED==='1'?'25173':process.env.LAB_B06_ISOLATED==='1'?'15173':'5173';
    const origins=new Set([`http://127.0.0.1:${editorPort}`,`http://localhost:${editorPort}`]);
    if(req.headers.origin&&!origins.has(req.headers.origin))fail(403,'POSTIT_BAD_ORIGIN','로컬 편집기에서만 사용할 수 있습니다.');
  }
  if(['POST','PATCH','PUT'].includes(req.method)&&!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))
    fail(415,'JSON_REQUIRED','JSON 요청만 허용합니다.');

  if (req.method === 'GET' && pathname === '/api/postits') {
    const status = url.searchParams.get('status') || undefined;
    const postits = store.list({ documentId: scopedDocId, status, scope: ownerScope });
    return sendJson(res, 200, { postits });
  }
  if (req.method === 'GET' && pathname === '/api/postits/export') {
    return sendJson(res, 200, store.exportBundle({ documentId: scopedDocId, scope: ownerScope }));
  }
  if (req.method === 'POST' && pathname === '/api/postits/restore') {
    const body = await readJsonBody(req);
    const result = await store.restoreBundle(body.bundle ?? body, { scope: ownerScope });
    return sendJson(res, 201, result);
  }
  if (req.method === 'POST' && pathname === '/api/postits') {
    const body = await readJsonBody(req);
    if(scopedDocId && body.documentId!==undefined && body.documentId!==scopedDocId)fail(409,'DOCUMENT_ID_MISMATCH','문서 범위를 확인하세요.');
    const { postit, replayed } = await store.createDraft({
      ...body,
      documentId: body.documentId ?? scopedDocId,
      documentTitle: body.documentTitle ?? defaultDocumentTitle,
      ownerScope: ownerScope,
    });
    return sendJson(res, replayed ? 200 : 201, { postit }, replayed ? { 'Idempotent-Replay': 'true' } : {});
  }

  const match = pathname.match(/^\/api\/postits\/([^/]+)(?:\/(archive|reask))?$/);
  if (match) {
    let postitId;
    try { postitId = decodeURIComponent(match[1]); }
    catch { fail(400, 'INVALID_POSTIT_ID', '포스트잇 ID 인코딩이 유효하지 않습니다.'); }
    const action = match[2] || '';
    const scopedItem=store.get(postitId,{scope:ownerScope});
    if(scopedDocId&&scopedItem.documentId!==scopedDocId)fail(404,'POSTIT_NOT_FOUND','해당 문서의 포스트잇을 찾을 수 없습니다.');
    if (req.method === 'GET' && !action) {
      return sendJson(res, 200, { postit: scopedItem });
    }
    if (req.method === 'POST' && action === 'archive') {
      const body = req.headers['content-length'] === '0' ? {} : await readJsonBody(req).catch(() => ({}));
      const postit = await store.archive(postitId, { ...body, ownerScope: ownerScope });
      return sendJson(res, 200, { postit });
    }
    if (req.method === 'POST' && action === 'reask') {
      const body = req.headers['content-length'] === '0' ? {} : await readJsonBody(req).catch(() => ({}));
      const reask = store.prepareReask(postitId, { ...body, ownerScope: ownerScope });
      return sendJson(res, 200, { reask });
    }
    if ((req.method === 'PATCH' || req.method === 'PUT') && !action) {
      const body = await readJsonBody(req);
      const postit = await store.saveEdit(postitId, { ...body, ownerScope: ownerScope });
      return sendJson(res, 200, { postit });
    }
  }
  return sendJson(res, 404, { error: '포스트잇 경로를 찾을 수 없습니다.', code: 'POSTIT_ROUTE_NOT_FOUND' });
}

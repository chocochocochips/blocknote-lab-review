/**
 * BlockNote Lab B-01: request/document validation (no npm dependencies).
 * Contract: docs/DOCUMENT_CONTRACT_v0.2.md + docs/API_CONTRACT_v0.2.md.
 * This module deliberately does not validate the complete BlockNote rich-inline
 * schema: unknown inline variants are retained, not silently flattened.
 */
export const LIMITS = Object.freeze({
  requestBytes: 1_000_000,
  documentBytes: 1_000_000, // includes JSON.stringify(value, null, 2) whitespace
  blocks: 1_000,
  maxDepth: 8, // root depth is 0
  blockIdLength: 128,
  contentLength: 20_000, // JavaScript string length (UTF-16 code units)
});

export const ALLOWED_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulletListItem', 'numberedListItem',
  'checkListItem', 'quote', 'codeBlock', 'toggleListItem', 'divider', 'table',
]);

export class RequestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const invalid = (code, message) => { throw new RequestError(422, code, message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.requestBytes) {
      throw new RequestError(413, 'PAYLOAD_TOO_LARGE', 'JSON 요청 크기가 1,000,000바이트를 초과했습니다.');
    }
    chunks.push(chunk);
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(source);
  } catch {
    throw new RequestError(400, 'BAD_JSON', '요청 본문이 올바른 UTF-8 JSON이 아닙니다.');
  }
}

export function validateWriteRequest(body, fallbackActor) {
  if (!isRecord(body)) throw new RequestError(400, 'BAD_JSON', 'JSON 객체가 필요합니다.');
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) {
    throw new RequestError(400, 'INVALID_REVISION', 'revision은 1 이상의 안전한 정수여야 합니다.');
  }
  if (body.actor === undefined) return fallbackActor;
  if (typeof body.actor !== 'string' || !/^[a-zA-Z0-9가-힣_. -]{1,60}$/.test(body.actor)) {
    invalid('INVALID_ACTOR', 'actor는 허용 문자로 구성된 1~60자 표시 이름이어야 합니다.');
  }
  return body.actor;
}

/** C-03: optional, all-or-nothing proposal provenance for POST/PATCH.
 * The approval value is a CLAIM by the caller, NOT authenticated human consent.
 * Missing fields preserve the v0.9 legacy API contract.
 */
export function validateProposalMetadata(body) {
  const keys = ['proposalId', 'goal', 'reason', 'approval'];
  if (!keys.some(key => Object.hasOwn(body, key)) && body.edit === undefined && body.edits === undefined) return null;
  if (!keys.every(key => Object.hasOwn(body, key))) {
    invalid('INVALID_PROPOSAL_METADATA', '제안 출처를 기록하려면 proposalId/goal/reason/approval 네 필드가 모두 필요합니다.');
  }
  const { proposalId, goal, reason, approval } = body;
  if (typeof proposalId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proposalId)) {
    invalid('INVALID_PROPOSAL_ID', 'proposalId는 영숫자로 시작하는 1~128자 식별자여야 합니다.');
  }
  const validNote = (value, max) => typeof value === 'string' &&
    value.length >= 1 && value.length <= max && value.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value);
  if (!validNote(goal, 240)) invalid('INVALID_PROPOSAL_GOAL', 'goal은 제어문자 없는 1~240자 텍스트여야 합니다.');
  if (!validNote(reason, 500)) invalid('INVALID_PROPOSAL_REASON', 'reason은 제어문자 없는 1~500자 텍스트여야 합니다.');
  if (approval !== 'approved') {
    invalid('PROPOSAL_NOT_APPROVED', '승인되지 않은 제안은 서버에 반영할 수 없습니다.');
  }
  const edit = body.edit;
  if (edit !== undefined) {
    const fields = ['model','documentId','blockId','baseRevision','beforeText','afterText','beforeHash'];
    if (!isRecord(edit) || Object.keys(edit).sort().join() !== fields.sort().join() ||
        !validNote(edit.model,128) || !validNote(edit.documentId,128) || !validNote(edit.blockId,128) ||
        !Number.isSafeInteger(edit.baseRevision) || edit.baseRevision < 1 ||
        typeof edit.beforeText !== 'string' || edit.beforeText.length > LIMITS.contentLength ||
        typeof edit.afterText !== 'string' || edit.afterText.length > LIMITS.contentLength ||
        !/^[0-9a-f]{64}$/.test(edit.beforeHash)) invalid('INVALID_EDIT_METADATA','문단 수정 이력 메타데이터가 유효하지 않습니다.');
  }
  const edits=body.edits;
  if(edits!==undefined){
    if(edit!==undefined||!Array.isArray(edits)||edits.length<1||edits.length>5)invalid('INVALID_BATCH','승인할 수정안은 1~5개 문단이어야 합니다.');
    const seen=new Set();for(const item of edits){validateProposalMetadata({proposalId,goal,reason,approval,edit:item});if(seen.has(item.blockId))invalid('INVALID_BATCH','대상 문단이 중복되었습니다.');seen.add(item.blockId);}
  }
  return { proposalId, goal, reason, approval, ...(edit ? {edit} : {}),...(edits?{edits}:{}) };
}

export function validateBlockId(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > LIMITS.blockIdLength) {
    invalid('INVALID_BLOCK_ID', '블록 ID는 1~128자 문자열이어야 합니다.');
  }
}

export function validateBlockType(type) {
  if (typeof type !== 'string' || !ALLOWED_BLOCK_TYPES.has(type)) {
    invalid('INVALID_BLOCK_TYPE', '지원하지 않는 블록 타입입니다.');
  }
}

export function validatePlainText(content) {
  if (typeof content !== 'string' || content.length > LIMITS.contentLength) {
    invalid('INVALID_CONTENT', 'content는 20,000자 이하 문자열이어야 합니다.');
  }
}

export function validateAfterId(afterId) {
  if (afterId === undefined || afterId === null) return;
  validateBlockId(afterId);
}

function validateInline(content) {
  if (!Array.isArray(content)) invalid('INVALID_CONTENT', '블록 content는 배열이어야 합니다.');
  for (const inline of content) {
    if (!isRecord(inline) || typeof inline.type !== 'string') {
      invalid('INVALID_CONTENT', '인라인 항목에는 문자열 type이 필요합니다.');
    }
    if (inline.type === 'text' && (typeof inline.text !== 'string' || !isRecord(inline.styles))) {
      invalid('INVALID_CONTENT', 'text 인라인 항목에는 text 문자열과 styles 객체가 필요합니다.');
    }
  }
}

function validateTable(table) {
  const bad = () => invalid('INVALID_TABLE', '표의 행, 열 또는 셀 형식을 확인해 주세요.');
  if (!isRecord(table) || table.type !== 'tableContent' ||
      !Array.isArray(table.rows) || !table.rows.length || table.rows.length > LIMITS.blocks ||
      !Array.isArray(table.columnWidths) || !table.columnWidths.length || table.columnWidths.length > LIMITS.blocks ||
      table.columnWidths.some(width => width != null && (!Number.isFinite(width) || width < 0))) bad();
  const rows = table.rows.length, cols = table.columnWidths.length;
  for (const [value, max] of [[table.headerRows, rows], [table.headerCols, cols]]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > max)) bad();
  }
  for (const [rowIndex, row] of table.rows.entries()) {
    if (!isRecord(row) || !Array.isArray(row.cells) || row.cells.length > cols) bad();
    let columnsInRow = 0;
    for (const cell of row.cells) {
      if (Array.isArray(cell)) {
        columnsInRow++;
        validateInline(cell);
        continue;
      }
      if (!isRecord(cell) || cell.type !== 'tableCell' || !isRecord(cell.props)) bad();
      const { colspan = 1, rowspan = 1 } = cell.props;
      if (!Number.isSafeInteger(colspan) || colspan < 1 || !Number.isSafeInteger(rowspan) ||
          rowspan < 1 || rowspan > rows - rowIndex) bad();
      columnsInRow += colspan;
      validateInline(cell.content);
    }
    if (columnsInRow > cols) bad();
  }
}

export function validateBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > LIMITS.blocks) {
    invalid('INVALID_BLOCKS', '문서 루트 블록은 1~1,000개여야 합니다.');
  }
  const seen = new Set();
  let count = 0;
  const stack = blocks.map(block => ({ block, depth: 0 }));
  while (stack.length) {
    const { block, depth } = stack.pop();
    if (depth > LIMITS.maxDepth) invalid('INVALID_BLOCKS', '블록 중첩 깊이가 8을 초과했습니다.');
    if (!isRecord(block)) invalid('INVALID_BLOCKS', '블록은 JSON 객체여야 합니다.');
    validateBlockId(block.id);
    if (seen.has(block.id)) invalid('DUPLICATE_BLOCK_ID', `중복된 블록 ID: ${block.id}`);
    seen.add(block.id);
    if (++count > LIMITS.blocks) invalid('INVALID_BLOCKS', '전체 블록 개수가 1,000개를 초과했습니다.');
    validateBlockType(block.type);
    if (!isRecord(block.props)) invalid('INVALID_BLOCKS', '블록 props는 JSON 객체여야 합니다.');
    if (block.type === 'heading' &&
        (!Number.isInteger(block.props.level) || block.props.level < 1 || block.props.level > 3)) {
      invalid('INVALID_BLOCKS', 'heading.props.level은 1~3 정수여야 합니다.');
    }
    if (block.type === 'table') validateTable(block.content);
    else if (block.type === 'divider') {
      if (block.content !== undefined && (!Array.isArray(block.content) || block.content.length)) {
        invalid('INVALID_CONTENT', '구분선에는 본문을 넣을 수 없습니다.');
      }
    } else validateInline(block.content);
    if (!Array.isArray(block.children)) invalid('INVALID_BLOCKS', '블록 children은 배열이어야 합니다.');
    for (const child of block.children) stack.push({ block: child, depth: depth + 1 });
  }
  return { count, ids: seen };
}

export function validateStoredDocumentSize(document) {
  const bytes = Buffer.byteLength(JSON.stringify(document, null, 2), 'utf8');
  if (bytes > LIMITS.documentBytes) {
    invalid('DOCUMENT_TOO_LARGE', '저장할 문서 JSON이 1,000,000바이트를 초과했습니다.');
  }
  return bytes;
}

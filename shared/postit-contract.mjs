/**
 * B-05 / B-06 shared Post-it contract, timestamp formatting, and state helpers.
 * Pure ES module with zero external dependencies (runs in both Node and browser).
 */

export const POSTIT_LIMITS = Object.freeze({
  maxItems: 200,
  maxFileBytes: 2_000_000,
  maxTitleLength: 90,
  maxPromptLength: 400,
  maxScopeTextLength: 12_000,
  maxContentLength: 20_000,
  maxTargetIds: 20,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function isValidPostitId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

export function sanitizeSingleLine(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLength);
}

/**
 * Format an ISO-8601 string or epoch ms into "YYYY.MM.DD HH:mm" in local time
 * (or UTC offset if specified). Returns "기록 없음" when null/invalid.
 */
export function formatPostitTime(value) {
  if (value === null || value === undefined || value === '') return '기록 없음';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '기록 없음';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Build display timestamp badges for a Post-it item.
 * Crucial invariant (B-05):
 * - Archiving NEVER sets or modifies updatedAt.
 * - "마지막 수정" is shown ONLY when updatedAt is explicitly set by a user save
 *   after archiving (updatedAt !== null).
 */
export function formatPostitTimeDetails(note) {
  if (!note || typeof note !== 'object') return [];
  const details = [`생성 ${formatPostitTime(note.createdAt)}`];
  if (note.archivedAt) {
    details.push(`보관 ${formatPostitTime(note.archivedAt)}`);
  }
  if (note.updatedAt) {
    details.push(`마지막 수정 ${formatPostitTime(note.updatedAt)}`);
  }
  return details;
}

/**
 * Determine whether an archived Post-it currently being edited has unsaved changes.
 * Temporary (unarchived) Post-its are read-only and never have unsaved edits.
 */
export function hasUnsavedPostitEdit(note, draftTitle, draftContent) {
  if (!note || !note.archived) return false;
  const normalizedDraftTitle = typeof draftTitle === 'string' ? draftTitle : note.title;
  const normalizedDraftContent = typeof draftContent === 'string' ? draftContent : note.content;
  return normalizedDraftTitle !== note.title || normalizedDraftContent !== note.content;
}

/**
 * Build the re-ask (AI 재검토) reference payload from a Post-it.
 * Strictly uses the latest confirmed saved content (note.content), NEVER unsaved draft inputs.
 */
export function buildPostitReaskContext(note, { draftTitle, draftContent } = {}) {
  if (!note || !isValidPostitId(note.id)) {
    throw new Error('재검토할 포스트잇을 찾을 수 없습니다.');
  }
  if (hasUnsavedPostitEdit(note, draftTitle, draftContent)) {
    const err = new Error('수정 내용을 먼저 변경 저장하거나 취소한 뒤 다시 질문하세요.');
    err.code = 'POSTIT_UNSAVED_EDIT';
    throw err;
  }
  const confirmedContent = typeof note.content === 'string' ? note.content : note.rawContent;
  return {
    reaskedFromId: note.id,
    documentId: note.documentId,
    itemRevision: note.itemRevision,
    title: note.title,
    model: note.model,
    confirmedContent,
    scopeText: confirmedContent,
    defaultPrompt: '이 포스트잇의 저장된 내용을 다시 검토해줘. 보완할 점이나 발전시킬 관점을 제안해줘.',
  };
}

/**
 * Derive a clean default title for a new temporary Post-it from its prompt/goal.
 */
export function derivePostitTitle(prompt, model = '') {
  const base = sanitizeSingleLine(prompt, 42, 'AI 검토 의견');
  if (!base || base === '현재 문서를 읽고 의견을 제시해줘.' || base === '현재 문서를 읽고 부족한 관점과 개선할 점을 짧게 검토해줘.') {
    return model ? `AI 검토 의견 (${model})` : '선택 문단에 대한 AI 검토 의견';
  }
  return base.length < (prompt || '').trim().length ? `${base}…` : base;
}

/** A display abbreviation only; historical `model` may be the requested model,
 * not a provider-confirmed response model. Never infer missing provenance. */
export function shortModelName(model) {
  if (typeof model !== 'string' || !model.trim() || model === '모델 미상') return '모델 미상';
  const id = model.trim();
  if (/^gpt-6(?:[.][0-9]+)?-luna(?:$|[-.])/i.test(id)) return '6luna';
  if (/^gpt-6(?:[.][0-9]+)?-sol(?:$|[-.])/i.test(id)) return '6sol';
  if (/^claude[-.][a-z0-9.-]*opus/i.test(id)) return 'Opus';
  if (/^claude[-.][a-z0-9.-]*sonnet/i.test(id)) return 'Sonnet';
  if (/^gemini[-.][a-z0-9.-]*pro/i.test(id)) return 'Gemini Pro';
  if (/^gemini[-.][a-z0-9.-]*flash/i.test(id)) return 'Gemini Flash';
  return id.length > 28 ? id.slice(0, 25) + '…' : id;
}

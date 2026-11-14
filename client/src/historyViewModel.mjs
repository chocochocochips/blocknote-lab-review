/** D-03: pure, strict view-model for /api/history; no React/DOM dependency. */
const LABELS = Object.freeze({
  'document.save': '문서 저장',
  'block.insert': '블록 추가',
  'blocks.update':'문단 일괄 수정',
  'block.update': '블록 수정',
  'block.delete': '블록 삭제',
  'recovery.restore': '백업 복원',
});

export function normalizeHistoryResponse(payload, locale = 'ko-KR') {
  if (!payload || !Array.isArray(payload.events)) {
    throw new Error('서버의 변경 이력 응답 형식이 올바르지 않습니다');
  }
  const formatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return payload.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.actor !== 'string' || !event.actor.trim() ||
        typeof event.operation !== 'string' || !event.operation.trim() ||
        !Number.isSafeInteger(event.revision) || event.revision < 1 ||
        typeof event.at !== 'string') {
      throw new Error(`변경 이력 ${index + 1}번 항목의 필드가 올바르지 않습니다`);
    }
    const date = new Date(event.at);
    if (!Number.isFinite(date.getTime())) {
      throw new Error(`변경 이력 ${index + 1}번 항목의 시각이 올바르지 않습니다`);
    }
    const edits=event.proposal?.edits;
    if(edits&&(!Array.isArray(edits)||edits.length<1||edits.length>5||new Set(edits.map(e=>e?.blockId)).size!==edits.length||event.proposal.approval!=='approved'||edits.some(e=>!e||typeof e.documentId!=='string'||typeof e.blockId!=='string'||typeof e.model!=='string'||!Number.isSafeInteger(e.baseRevision)||event.revision!==e.baseRevision+1||typeof e.beforeText!=='string'||typeof e.afterText!=='string')))throw new Error('일괄 수정 이력 형식이 유효하지 않습니다');
    const edit=event.proposal?.edit;
    if(edit && (typeof edit.model!=='string' || typeof edit.documentId!=='string' ||
      typeof edit.blockId!=='string' || !Number.isSafeInteger(edit.baseRevision) || edit.baseRevision<1 ||
      typeof edit.beforeText!=='string' || typeof edit.afterText!=='string' ||
      event.proposal.approval!=='approved' || event.blockId!==edit.blockId || event.revision!==edit.baseRevision+1))
      throw new Error('문단 수정 이력의 대상 또는 승인 메타데이터가 유효하지 않습니다');
    return {
      ...(event.proposal?.edits?{edits:event.proposal.edits}:{}),
      ...(edit?{edit:{...edit,approval:event.proposal.approval}}:{}),
      actor: event.actor.trim(), revision: event.revision,
      operationLabel: LABELS[event.operation] || event.operation,
      operation: event.operation, at: event.at,
      localTime: formatter.format(date),
      transactionId: typeof event.transactionId === 'string' ? event.transactionId : null,
    };
  }).sort((a, b) => b.revision - a.revision || Date.parse(b.at) - Date.parse(a.at));
}

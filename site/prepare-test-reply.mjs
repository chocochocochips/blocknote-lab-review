import { extractBlockText } from '../shared/paragraph-selection.mjs';
import { isValidPostitId, POSTIT_LIMITS } from '../shared/postit-contract.mjs';
import { RequestError } from '../server/validation.mjs';

const fail = (status, code, message) => { throw new RequestError(status, code, message); };

export async function prepareTestReply({ body, doc, item, internal, assertActive }) {
  if (item.mode === 'patch') {
    return {
      ...item,
      content: (item.originalContent + ' [시험 수정안] ' + item.goal).slice(0, 20_000),
      reason: '문단 수정과 승인 흐름을 확인하는 시험 응답입니다.',
    };
  }

  const targetIds = body.targetIds ?? [];
  if (!Array.isArray(targetIds) || targetIds.length > POSTIT_LIMITS.maxTargetIds ||
      new Set(targetIds).size !== targetIds.length || !targetIds.every(isValidPostitId)) {
    fail(422, 'INVALID_REFERENCE', '선택 문단을 확인하세요.');
  }

  let scopeText = '';
  let scope = '전체 문서';
  if (body.reaskedFromId) {
    if (targetIds.length || !isValidPostitId(body.reaskedFromId)) {
      fail(422, 'INVALID_REFERENCE', '포스트잇 참고 범위를 확인하세요.');
    }
    const { postit } = await internal('/api/documents/' + encodeURIComponent(doc.id) +
      '/postits/' + encodeURIComponent(body.reaskedFromId));
    if (!postit.archived || postit.itemRevision !== body.reaskedItemRevision) {
      fail(409, 'REFERENCE_CHANGED', '보관한 포스트잇을 다시 열어 주세요.');
    }
    scope = '보관한 포스트잇';
    scopeText = postit.content;
  } else if (targetIds.length) {
    const selected = new Set(targetIds);
    const blocks = doc.blocks.filter(block => selected.has(block.id));
    if (blocks.length !== selected.size) fail(409, 'REFERENCE_CHANGED', '선택한 문단이 변경되었습니다.');
    scope = '선택 문단 ' + blocks.length + '개';
    scopeText = blocks.map(extractBlockText).join('\n\n');
  }
  if (scopeText.length > POSTIT_LIMITS.maxScopeTextLength) {
    fail(413, 'REFERENCE_TOO_LARGE', '선택한 참고 내용이 너무 깁니다.');
  }

  const excerpt = (scopeText || (!targetIds.length && !body.reaskedFromId
    ? doc.blocks.map(extractBlockText).filter(Boolean).join('\n') : '')).trim().slice(0, 150);
  const rawContent = [
    '시험 응답',
    '질문: ' + item.goal,
    '참고 범위: ' + scope,
    ...(excerpt ? ['참고 일부: ' + excerpt] : []),
    '판단 근거, 아직 열린 질문, 다음에 할 일을 문서에 나눠 기록해 보세요.',
  ].join('\n');
  const postitDraft = {
    requestId: item.requestId, proposalId: item.proposalId, documentId: doc.id,
    baseRevision: doc.revision, targetIds, scopeText, reaskedFromId: body.reaskedFromId ?? null,
    model: item.model, prompt: item.goal, rawContent,
  };
  assertActive();
  const answer = { ...item, content: rawContent, reason: '보관과 삽입을 확인하는 시험 응답입니다.', postitDraft };
  try {
    const { postit } = await internal('/api/documents/' + encodeURIComponent(doc.id) + '/postits', 'POST', postitDraft);
    return { ...answer, postitId: postit.id, postitSave: 'saved' };
  } catch {
    return { ...answer, postitSave: 'failed' };
  }
}

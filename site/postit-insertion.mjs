import { RequestError } from '../server/validation.mjs';

export async function readReceipt(api, documentId, requestId) {
  const path = '/api/documents/' + encodeURIComponent(documentId) + '/requests/' + encodeURIComponent(requestId);
  try {
    return await api(path);
  } catch (error) {
    if (error.code !== 'REQUEST_NOT_FOUND') throw error;
    return null;
  }
}

export async function insertArchivedPostit(api, { documentId, postitId, itemRevision, revision, afterId }, actor) {
  if (![itemRevision, revision].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RequestError(400, 'INVALID_REVISION', '문서와 포스트잇의 변경 번호를 확인하세요.');
  }
  const path = '/api/documents/' + encodeURIComponent(documentId);
  const { postit } = await api(path + '/postits/' + encodeURIComponent(postitId));
  if (!postit.archived) throw new RequestError(409, 'POSTIT_NOT_ARCHIVED', '포스트잇을 먼저 보관하세요.');

  // Share the original request ID with the AI panel and MCP insert operation.
  const requestId = postit.requestId;
  const receipt = await readReceipt(api, documentId, requestId);
  if (receipt?.httpStatus === 201) return { ...receipt.result, alreadyInserted: true };
  if (receipt) throw new RequestError(409, 'REQUEST_ID_REUSED', '이 포스트잇 요청 ID가 다른 변경에 사용되었습니다.');
  if (postit.itemRevision !== itemRevision) {
    throw new RequestError(409, 'POSTIT_CONFLICT', '보관함에서 최신 포스트잇을 다시 열어 주세요.');
  }
  return api(path + '/blocks', 'POST', {
    documentId, revision, requestId, actor, content: postit.content, opinionModel: postit.model,
    ...(afterId ? { afterId } : {}),
  });
}

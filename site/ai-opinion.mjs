import { randomUUID } from 'node:crypto';
import { RequestError } from '../server/validation.mjs';
import { extractBlockText } from '../shared/paragraph-selection.mjs';
import { isValidPostitId, POSTIT_LIMITS } from '../shared/postit-contract.mjs';
import { generateOpinion, generationTimeout, providerName, validateProviderRequest } from './ai-providers.mjs';
import { hydrogenFallbackModel, hydrogenModel } from '../shared/site-google-models.mjs';
import { withWorkspace } from './workspace.mjs';

const fail = (status, code, message) => { throw new RequestError(status, code, message); };
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const documentText = blocks => blocks.flatMap(block => [extractBlockText(block), documentText(block.children || [])]).filter(Boolean).join('\n\n');

export async function requestOpinion(env, userId, id, body, options) {
  const { provider, model, requestId, baseRevision, targetIds, reaskedFromId, reaskedItemRevision } = body || {};
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!/^site-ai:[a-f\d-]{36}$/i.test(requestId || '') || !Number.isSafeInteger(baseRevision) || baseRevision < 1
      || !prompt || prompt.length > POSTIT_LIMITS.maxPromptLength || prompt.replace(controls, '') !== prompt
      || !Array.isArray(targetIds) || targetIds.length > POSTIT_LIMITS.maxTargetIds
      || new Set(targetIds).size !== targetIds.length || !targetIds.every(isValidPostitId)
      || (reaskedFromId != null && (!isValidPostitId(reaskedFromId) || targetIds.length > 0))) {
    fail(422, 'AI_INPUT_INVALID', '질문과 참고 범위를 확인해 주세요.');
  }
  validateProviderRequest(env, provider, model);
  const canFallback = provider === 'google' && model === hydrogenModel;
  const callBudget = generationTimeout(provider, model) + (canFallback ? generationTimeout(provider, hydrogenFallbackModel) : 0);
  const claimed = await withWorkspace(env.BUCKET, userId, ({ workspace, state }) => {
    const document = workspace.get(id).storage.readDocument();
    const metadata = workspace.metadata(id);
    const notes = workspace.postits.list({ documentId: id });
    const previous = notes.find(note => note.requestId === requestId);
    if (previous) return { postit: previous };
    const now = Date.now();
    state.aiClaims = state.aiClaims.filter(claim => claim.until > now);
    if (state.aiClaims.some(claim => claim.id === requestId || (claim.documentId === id && claim.busyUntil > now))) {
      fail(409, 'AI_ALREADY_REQUESTED', '이미 요청을 보냈어요. 잠시 후 포스트잇 보관함을 확인해 주세요.');
    }
    if (metadata.archived || document.revision !== baseRevision) fail(409, 'AI_DOCUMENT_CHANGED', '저장된 문서 버전이 바뀌었어요. 문서를 다시 확인해 주세요.');
    if (workspace.postits.list().length >= POSTIT_LIMITS.maxItems) fail(409, 'POSTIT_LIMIT_EXCEEDED', '포스트잇 저장 한도에 도달했어요.');
    let context;
    if (reaskedFromId) {
      const postit = workspace.postits.get(reaskedFromId);
      if (postit.documentId !== id || !postit.archived || postit.itemRevision !== reaskedItemRevision) {
        fail(409, 'AI_REFERENCE_CHANGED', '보관한 포스트잇을 다시 열어 주세요.');
      }
      context = postit.content;
    } else {
      const blocks = targetIds.length ? document.blocks.filter(block => targetIds.includes(block.id)) : document.blocks;
      if (targetIds.length && blocks.length !== targetIds.length) fail(409, 'AI_REFERENCE_CHANGED', '선택 문단이 바뀌었어요.');
      context = documentText(blocks);
    }
    context = context.replace(controls, '');
    if (context.length > POSTIT_LIMITS.maxScopeTextLength) {
      fail(413, 'AI_SCOPE_TOO_LARGE', '참고 내용이 너무 길어요. 문단을 더 적게 선택해 주세요.');
    }
    state.aiClaims.push({ id: requestId, documentId: id, busyUntil: now + callBudget + 10_000, until: now + 600_000 });
    return { context, title: metadata.title };
  });
  if (claimed.postit) return claimed;

  // Keep upstream calls outside the workspace's conditional-write retry loop.
  let rawContent, fallback;
  try {
    try {
      options?.signal?.throwIfAborted();
      rawContent = await generateOpinion(env, provider, model, prompt, claimed.context, options);
      options?.signal?.throwIfAborted();
    } catch (error) {
      if (!canFallback || error.code !== 'AI_HYDROGEN_FALLBACK') throw error;
      fallback = { model: hydrogenFallbackModel, httpStatus: error.upstreamStatus };
      rawContent = await generateOpinion(env, provider, fallback.model, prompt, claimed.context);
    }
  } catch (error) {
    if (fallback && error instanceof RequestError) error.fallback = fallback;
    // A new question can proceed as soon as the failed call returns. Keep the
    // original request ID reserved so replaying it never repeats a paid call.
    await withWorkspace(env.BUCKET, userId, ({ state }) => {
      state.aiClaims = state.aiClaims.map(claim => claim.id === requestId ? { ...claim, busyUntil: 0 } : claim);
      return {};
    }).catch(() => {});
    throw error;
  }
  const draft = {
    requestId, proposalId: 'site-ai:' + randomUUID(), documentId: id, documentTitle: claimed.title,
    baseRevision, targetIds, reaskedFromId: reaskedFromId ?? null,
    scopeText: targetIds.length || reaskedFromId ? claimed.context : '',
    model: providerName(provider) + ' · ' + (fallback?.model ?? model),
    prompt, rawContent,
  };
  // The existing Post-it store caps the model label at 128 characters.
  draft.model = draft.model.slice(0, 128);
  try {
    return await withWorkspace(env.BUCKET, userId, async ({ workspace, state }) => {
      options?.signal?.throwIfAborted();
      const { postit } = await workspace.postits.createDraft(draft);
      state.aiClaims = state.aiClaims.filter(claim => claim.id !== requestId);
      return { postit, ...(fallback && { fallback }) };
    });
  } catch {
    return { draft, ...(fallback && { fallback }) };
  }
}

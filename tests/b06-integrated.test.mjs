import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace, openWorkspace, createWorkspaceApp, verifyExport } from '../server/workspace.mjs';
import { createAiPanelServer } from '../scripts/ai-panel-server.mjs';
import { formatConnectionChip, connectionLabel, chooseAccountModel } from '../client/src/aiConnectionState.mjs';
import {
  formatPostitTime,
  formatPostitTimeDetails,
  hasUnsavedPostitEdit,
  buildPostitReaskContext,
} from '../shared/postit-contract.mjs';
import {
  pruneSelectedBlocks,
  toggleSelectedBlock,
  formatSelectionClipboard,
  resolveQuestionScope,
} from '../shared/paragraph-selection.mjs';

const ORIGIN = 'http://127.0.0.1:5173';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)));
const closeServer = s => new Promise(r => { s.close(r); s.closeAllConnections?.(); });
const until = async fn => {
  for (let i = 0; i < 120; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Condition did not settle in time');
};

async function withLabFixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bn-b06-'));
  const root = join(dir, 'workspace');
  const [first] = initializeWorkspace({ destination: root, title: 'AI와 문서의 관계' });
  let docServer = createWorkspaceApp({ root });
  let docBase = await listen(docServer);

  const callDoc = async (path, method = 'GET', body, headers = {}) => {
    const res = await fetch(docBase + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };

  // Seed 3 editable paragraphs so multi-paragraph selection and partial approval can be tested
  const initialDoc = (await callDoc(`/api/documents/${first.id}/document`)).data;
  const seededBlocks = [
    { id: 'p-1', type: 'paragraph', props: {}, content: [{ type: 'text', text: '첫 번째 문단 원문입니다.', styles: {} }], children: [] },
    { id: 'p-2', type: 'paragraph', props: {}, content: [{ type: 'text', text: '두 번째 문단 원문입니다.', styles: {} }], children: [] },
    { id: 'p-3', type: 'paragraph', props: {}, content: [{ type: 'text', text: '세 번째 문단 원문입니다.', styles: {} }], children: [] },
  ];
  await callDoc(`/api/documents/${first.id}/document`, 'PUT', {
    documentId: first.id,
    revision: initialDoc.revision,
    actor: 'human-editor',
    blocks: seededBlocks,
  });

  const initialDocBase = docBase;
  let proposalCounter = 0;
  const panel = createAiPanelServer({
    documentBase: docBase,
    fetchImpl: (url, opts) => fetch(String(url).replace(initialDocBase, docBase), opts),
    connect: async () => ({ bearer: () => 'synthetic-token', close: async () => {} }),
    listModels: async () => [
      { slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
      { slug: 'gpt-6-luna', name: 'GPT-6 Luna' },
    ],
    propose: async ({ mode, targetId, goal }) => {
      proposalCounter += 1;
      if (mode === 'patch') {
        return {
          proposal: {
            content: `[수정안 #${proposalCounter}:${targetId}] ${goal}`,
            reason: '선택 문단 다듬기 제안',
          },
        };
      }
      return {
        proposal: {
          content: `[AI 의견 원문 #${proposalCounter}] ${goal}`,
          reason: '문서 검토 의견 생성',
        },
      };
    },
    ...overrides,
  });
  const panelBase = await listen(panel);

  const callPanel = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(panelBase + path, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
  };

  t.after(async () => {
    await panel.shutdown();
    await closeServer(docServer);
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    root,
    docId: first.id,
    docBase: () => docBase,
    callDoc,
    callPanel,
    restartDocServer: async () => {
      await closeServer(docServer);
      docServer = createWorkspaceApp({ root });
      docBase = await listen(docServer);
    },
  };
}

test('B-01/B-02 (시나리오 1): 연결 전·진행 중·완료·오류/취소 상태와 실제 모델 조회 기반 상태 칩 표시', () => {
  const disconnected = formatConnectionChip({ connected: false, connection: { phase: 'idle' }, models: [], model: '' });
  assert.equal(disconnected.state, 'disconnected');
  assert.equal(disconnected.longLabel, 'ChatGPT 연결');

  const waiting = formatConnectionChip({ connected: false, connection: { phase: 'waiting_browser' }, models: [], model: '' });
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.longLabel, 'ChatGPT · 로그인 중');

  const catalog = [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }, { slug: 'gpt-6-luna', name: 'GPT-6 Luna' }];
  const chosen = chooseAccountModel(catalog, '');
  assert.equal(chosen, 'gpt-6-luna');

  const connectedLuna = formatConnectionChip({
    connected: true,
    connection: { phase: 'connected' },
    models: catalog,
    model: chosen,
  });
  assert.equal(connectedLuna.state, 'connected');
  assert.equal(connectedLuna.longLabel, 'GPT-6 Luna · 연결됨');
  assert.equal(connectedLuna.shortLabel, 'LUNA');

  // When Luna is absent, never hardcodes "GPT-6 Luna · 연결됨"
  const noLunaModels = [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }];
  const emptyChoice = chooseAccountModel(noLunaModels, '');
  assert.equal(emptyChoice, '');
  const connectedUnselected = formatConnectionChip({
    connected: true,
    connection: { phase: 'connected' },
    models: noLunaModels,
    model: emptyChoice,
  });
  assert.equal(connectedUnselected.longLabel, '모델 미선택 · 연결됨');
  assert.match(connectionLabel({ phase: 'failed' }), /연결 실패/);
  assert.match(connectionLabel({ phase: 'cancelled' }), /연결 취소/);
});

test('B-03/B-04 (시나리오 2): 빠른 유형 3버튼 제거, 단일 자유 질문창, 문단 이동 오른쪽에 문단 선택 배치 및 포스트잇 보관함 UI 계약', () => {
  const appSource = readFileSync(new URL('../client/src/App.jsx', import.meta.url), 'utf8');
  const aiSource = readFileSync(new URL('../client/src/AiPanel.jsx', import.meta.url), 'utf8');

  // Three quick-action buttons ('의견 검토', '리서치', '사실 확인') are removed from AiPanel.jsx
  assert.doesNotMatch(aiSource, /className="phase2-quick-actions"/);
  // Two top-level modes ('의견 나누기', '편집 맡기기') and single #ai-panel-goal textarea remain
  assert.match(aiSource, /의견 나누기/);
  assert.match(aiSource, /편집 맡기기/);
  assert.match(aiSource, /id="ai-panel-goal"/);

  // Opinion post-it card has '복사', '보관', '문서에 삽입' buttons
  assert.match(aiSource, /id="copyAnswer"/);
  assert.match(aiSource, /id="b05StoreAnswer"/);
  assert.match(aiSource, /id="insertAnswer"/);

  // Toolbar order: font-size-control -> b05-format-details (서식) -> reorderToggle (문단 이동) -> inlineAiAction (문단 선택)
  const idxFont = appSource.indexOf('className="font-size-control"');
  const idxFormat = appSource.indexOf('id="b05FormatToggle"');
  const idxMove = appSource.indexOf('id="reorderToggle"');
  const idxSelect = appSource.indexOf('id="inlineAiAction"');
  assert.ok(idxFont > 0 && idxFormat > idxFont && idxMove > idxFormat && idxSelect > idxMove);

  // Left icon rail has independent Post-it drawer button (#b05PostitRail)
  assert.match(appSource, /id="b05PostitRail"/);
  assert.match(appSource, /<PostitDrawer/);
});

test('B-04 (시나리오 3, 4, 5): 미선택 시 임의 첫 문단 선택 가장 금지, 복수 문단 선택·복사·질문 참조 유지 및 블록 변경 시 일관성', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', props: {}, content: [{ type: 'text', text: '첫 문단 내용', styles: {} }], children: [] },
    { id: 'b2', type: 'paragraph', props: {}, content: [{ type: 'text', text: '둘째 문단 내용', styles: {} }], children: [] },
    { id: 'b3', type: 'paragraph', props: {}, content: [{ type: 'text', text: '셋째 문단 내용', styles: {} }], children: [] },
  ];

  // Scenario 3: When nothing is selected, never pretends b1 is selected
  const emptyScope = resolveQuestionScope({ blocks, selectedIds: [], revision: 3 });
  assert.equal(emptyScope.scopeType, 'document');
  assert.equal(emptyScope.label, '참고 범위 · 문서 전체');
  assert.deepEqual(emptyScope.targetIds, []);
  assert.equal(emptyScope.scopeText, '');

  // Scenario 4: Multi-paragraph selection, copy formatting, and question scope
  let selected = toggleSelectedBlock(blocks, [], 'b3');
  selected = toggleSelectedBlock(blocks, selected, 'b1');
  // Ordered in document order (b1, then b3)
  assert.deepEqual(selected, ['b1', 'b3']);
  assert.equal(formatSelectionClipboard(blocks, selected), '첫 문단 내용\n\n셋째 문단 내용');

  const selectionScope = resolveQuestionScope({ blocks, selectedIds: selected, revision: 3 });
  assert.equal(selectionScope.scopeType, 'selection');
  assert.equal(selectionScope.label, '참고 범위 · 선택 문단 2개');
  assert.deepEqual(selectionScope.targetIds, ['b1', 'b3']);
  assert.match(selectionScope.scopeText, /첫 문단 내용/);
  assert.match(selectionScope.scopeText, /셋째 문단 내용/);

  // Scenario 5: Block reorder or deletion prunes deleted IDs and preserves valid selection
  const reorderedBlocks = [blocks[2], blocks[0]]; // b2 removed, b3 moved before b1
  const pruned = pruneSelectedBlocks(reorderedBlocks, ['b1', 'b2', 'b3']);
  assert.deepEqual(pruned, ['b1', 'b3']);
  const afterMoveScope = resolveQuestionScope({ blocks: reorderedBlocks, selectedIds: pruned, revision: 4 });
  assert.equal(afterMoveScope.scopeText, '셋째 문단 내용\n\n첫 문단 내용');
});

test('B-05 (시나리오 6, 7, 8, 9, 10, 11, 12): 포스트잇 자동 임시보존·새로고침 복구·원문 불변·보관 시각 분리·명시적 변경 저장·미저장 이탈 보호·AI 재검토·본문 리비전 불변', async t => {
  const lab = await withLabFixture(t);
  await lab.callPanel('/panel/connect', {});

  const docBefore = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  assert.equal(docBefore.revision, 2);

  // Scenario 6: AI opinion request automatically saves raw response as a temporary Post-it
  const reqId = 'ai:test-opinion-1';
  const startRes = await lab.callPanel('/panel/requests', {
    requestId: reqId,
    documentId: lab.docId,
    baseRevision: docBefore.revision,
    targetId: 'p-1',
    targetIds: ['p-1', 'p-2'],
    scopeText: '첫 번째 문단 원문입니다.\n\n두 번째 문단 원문입니다.',
    model: 'gpt-6-luna',
    mode: 'insert',
    goal: '선택한 두 문단의 논리를 검토해줘',
  });
  assert.equal(startRes.status, 202);

  const completedJob = await until(async () => {
    const r = await lab.callPanel(`/panel/requests/${reqId}?documentId=${lab.docId}`);
    return r.data.state === 'review' ? r.data : null;
  });
  assert.ok(completedJob.proposal.postitId);

  // Restart document server to simulate browser/server reload and verify persistence
  await lab.restartDocServer();
  const postitsAfterReload = (await lab.callDoc(`/api/postits?documentId=${lab.docId}`)).data.postits;
  assert.equal(postitsAfterReload.length, 1);
  const draftNote = postitsAfterReload[0];
  assert.equal(draftNote.id, completedJob.proposal.postitId);
  assert.equal(draftNote.archived, false);
  assert.equal(draftNote.archivedAt, null);
  assert.equal(draftNote.updatedAt, null);
  assert.equal(draftNote.rawContent, completedJob.proposal.content);
  assert.equal(draftNote.content, completedJob.proposal.content);
  assert.deepEqual(draftNote.targetIds, ['p-1', 'p-2']);

  // Temporary Post-it cannot be edited before archiving (409 POSTIT_NOT_ARCHIVED)
  const forbiddenEdit = await lab.callDoc(`/api/postits/${draftNote.id}`, 'PATCH', {
    title: '임시 상태에서 수정 시도',
    content: '원문 훼손 시도',
    itemRevision: draftNote.itemRevision,
  });
  assert.equal(forbiddenEdit.status, 409);
  assert.equal(forbiddenEdit.data.code, 'POSTIT_NOT_ARCHIVED');

  // Scenario 7: Archiving updates archivedAt, but NEVER changes updatedAt!
  const archiveRes = await lab.callDoc(`/api/postits/${draftNote.id}/archive`, 'POST', {});
  assert.equal(archiveRes.status, 200);
  const archivedNote = archiveRes.data.postit;
  assert.equal(archivedNote.archived, true);
  assert.ok(archivedNote.archivedAt);
  assert.equal(archivedNote.updatedAt, null);
  const timeBadgesBeforeEdit = formatPostitTimeDetails(archivedNote);
  assert.equal(timeBadgesBeforeEdit.some(b => b.startsWith('생성 ')), true);
  assert.equal(timeBadgesBeforeEdit.some(b => b.startsWith('보관 ')), true);
  assert.equal(timeBadgesBeforeEdit.some(b => b.startsWith('마지막 수정 ')), false);

  // Scenario 8, 9, 10: Typing in UI is detected as unsaved edit; failed save keeps server intact; explicit '변경 저장' updates updatedAt while keeping rawContent immutable
  assert.equal(hasUnsavedPostitEdit(archivedNote, archivedNote.title, archivedNote.content), false);
  assert.equal(hasUnsavedPostitEdit(archivedNote, '수정한 제목', '사용자가 다듬은 포스트잇 내용'), true);

  // Simulate a failed save (stale itemRevision or invalid empty title)
  const failedSave = await lab.callDoc(`/api/postits/${ draftNote.id }`, 'PATCH', {
    title: '   ',
    content: '미저장 로컬 입력',
    itemRevision: archivedNote.itemRevision,
  });
  assert.equal(failedSave.status, 422);
  const serverStillIntact = (await lab.callDoc(`/api/postits/${draftNote.id}`)).data.postit;
  assert.equal(serverStillIntact.content, draftNote.rawContent);
  assert.equal(serverStillIntact.updatedAt, null);

  // Explicit '변경 저장' (PATCH /api/postits/:id)
  const savedEditRes = await lab.callDoc(`/api/postits/${draftNote.id}`, 'PATCH', {
    title: '수정한 포스트잇 제목',
    content: '사용자가 직접 정리하여 변경 저장한 확정 내용입니다.',
    itemRevision: archivedNote.itemRevision,
  });
  assert.equal(savedEditRes.status, 200);
  const editedNote = savedEditRes.data.postit;
  assert.equal(editedNote.title, '수정한 포스트잇 제목');
  assert.equal(editedNote.content, '사용자가 직접 정리하여 변경 저장한 확정 내용입니다.');
  assert.equal(editedNote.rawContent, draftNote.rawContent); // Original rawContent is still immutable!
  assert.ok(editedNote.updatedAt);
  const timeBadgesAfterEdit = formatPostitTimeDetails(editedNote);
  assert.equal(timeBadgesAfterEdit.some(b => b.startsWith('마지막 수정 ')), true);

  // Scenario 11: Re-review ('AI에게 다시 질문') blocks if unsaved edits exist, uses confirmed content, creates a NEW temporary Post-it, and keeps existing archived Post-it unchanged
  assert.throws(
    () => buildPostitReaskContext(editedNote, { draftTitle: editedNote.title, draftContent: '아직 저장 안 한 수정본' }),
    err => err.code === 'POSTIT_UNSAVED_EDIT',
  );
  const reaskCtx = buildPostitReaskContext(editedNote, { draftTitle: editedNote.title, draftContent: editedNote.content });
  assert.equal(reaskCtx.reaskedFromId, editedNote.id);
  assert.equal(reaskCtx.confirmedContent, '사용자가 직접 정리하여 변경 저장한 확정 내용입니다.');

  const reaskReqId = 'ai:test-reask-2';
  const reaskCreateRes = await lab.callDoc('/api/postits', 'POST', {
    requestId: reaskReqId,
    documentId: lab.docId,
    baseRevision: docBefore.revision,
    reaskedFromId: reaskCtx.reaskedFromId,
    scopeText: reaskCtx.scopeText,
    model: 'gpt-6-luna',
    prompt: '이 포스트잇 내용을 다시 검토해줘',
    rawContent: '재검토로 새로 생성된 AI 임시 답변입니다.',
  });
  assert.equal(reaskCreateRes.status, 201);
  const newDraftPostit = reaskCreateRes.data.postit;
  assert.notEqual(newDraftPostit.id, editedNote.id);
  assert.equal(newDraftPostit.archived, false);
  assert.equal(newDraftPostit.reaskedFromId, editedNote.id);

  // Original archived Post-it is completely untouched
  const originalAfterReask = (await lab.callDoc(`/api/postits/${editedNote.id}`)).data.postit;
  assert.deepEqual(originalAfterReask, editedNote);

  // Scenario 12: Main document revision and history did NOT change at all during any Post-it operation!
  const docAfterPostits = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  const histAfterPostits = (await lab.callDoc(`/api/documents/${lab.docId}/history`)).data;
  assert.equal(docAfterPostits.revision, docBefore.revision);
  assert.equal(histAfterPostits.events.length, 1); // Only the initial seed PUT from fixture setup

  // Only when '문서에 삽입' (approve) is explicitly called does main document revision increment!
  const approveRes = await lab.callPanel(`/panel/requests/${reqId}/approve`, {
    documentId: lab.docId,
    baseRevision: docBefore.revision,
    targetId: 'p-1',
    proposalId: completedJob.proposal.proposalId,
  });
  assert.equal(approveRes.status, 200);
  const docAfterInsert = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  assert.equal(docAfterInsert.revision, docBefore.revision + 1);
});

test('B-05 편집 맡기기 (시나리오 13, 14): 다중 문단 일괄 제안·문단별 부분 승인 및 원문 변경 후 오래된(stale) 제안 차단', async t => {
  const lab = await withLabFixture(t);
  await lab.callPanel('/panel/connect', {});

  const beforeDoc = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  assert.equal(beforeDoc.revision, 2);

  // Request multi-paragraph proposals for p-1 and p-2
  const groupId = 'group:b06-partial-1';
  const groupStart = await lab.callPanel('/panel/groups', {
    groupId,
    documentId: lab.docId,
    baseRevision: beforeDoc.revision,
    targetIds: ['p-1', 'p-2'],
    model: 'gpt-6-luna',
    goal: '문장을 간결하게 다듬어줘',
  });
  assert.equal(groupStart.status, 202);

  const reviewGroup = await until(async () => {
    const g = await lab.callPanel(`/panel/groups/${groupId}?documentId=${lab.docId}`);
    return g.data.state === 'review' ? g.data : null;
  });
  assert.equal(reviewGroup.requests.length, 2);

  // Proposal generation & preview did NOT increment document revision
  assert.equal((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data.revision, 2);

  // Partial approval: approve ONLY p-2, leaving p-1 untouched!
  const partialApprove = await lab.callPanel(`/panel/groups/${groupId}/approve`, {
    documentId: lab.docId,
    baseRevision: beforeDoc.revision,
    targetIds: ['p-2'],
  });
  assert.equal(partialApprove.status, 200);
  assert.equal(partialApprove.data.state, 'committed');
  assert.equal(partialApprove.data.result.skippedCount, 1);

  const afterPartialDoc = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  assert.equal(afterPartialDoc.revision, 3);
  assert.equal(afterPartialDoc.blocks.find(b => b.id === 'p-1').content[0].text, '첫 번째 문단 원문입니다.');
  assert.match(afterPartialDoc.blocks.find(b => b.id === 'p-2').content[0].text, /수정안/);
  assert.equal(afterPartialDoc.blocks.find(b => b.id === 'p-3').content[0].text, '세 번째 문단 원문입니다.');

  // Scenario 14: Stale proposal blocking when document changes after proposal generation
  const staleGroupId = 'group:b06-stale-2';
  await lab.callPanel('/panel/groups', {
    groupId: staleGroupId,
    documentId: lab.docId,
    baseRevision: afterPartialDoc.revision,
    targetIds: ['p-1', 'p-3'],
    model: 'gpt-6-luna',
    goal: '다듬기',
  });
  await until(async () => {
    const g = await lab.callPanel(`/panel/groups/${staleGroupId}?documentId=${lab.docId}`);
    return g.data.state === 'review' ? g.data : null;
  });

  // Modify p-1 in the document before approving staleGroupId
  const modifiedBlocks = structuredClone(afterPartialDoc.blocks);
  modifiedBlocks[0].content[0].text = '사용자가 직접 바꾼 첫 번째 문단';
  await lab.callDoc(`/api/documents/${lab.docId}/document`, 'PUT', {
    documentId: lab.docId,
    revision: afterPartialDoc.revision,
    actor: 'human-editor',
    blocks: modifiedBlocks,
  });

  // Attempting to approve the stale group proposal must be rejected (409)
  const staleApprove = await lab.callPanel(`/panel/groups/${staleGroupId}/approve`, {
    documentId: lab.docId,
    baseRevision: afterPartialDoc.revision,
    targetIds: ['p-1'],
  });
  assert.equal(staleApprove.status, 409);
  const docAfterStaleReject = (await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  assert.equal(docAfterStaleReject.blocks[0].content[0].text, '사용자가 직접 바꾼 첫 번째 문단');
});

test('B-05/B-06 (시나리오 15, 16, 17): 포스트잇 동시성·권한·백업/복원·중복 차단 및 메인 문서 백업과의 완전한 독립성', async t => {
  const lab = await withLabFixture(t);

  // Create and archive a Post-it
  const created = (await lab.callDoc('/api/postits', 'POST', {
    requestId: 'req:sec-1',
    documentId: lab.docId,
    prompt: '보안 및 백업 검증',
    rawContent: '원본 AI 답변 텍스트',
  })).data.postit;

  // Idempotent replay of same requestId returns 200 without duplicating
  const replay = await lab.callDoc('/api/postits', 'POST', {
    requestId: 'req:sec-1',
    documentId: lab.docId,
    prompt: '보안 및 백업 검증',
    rawContent: '원본 AI 답변 텍스트',
  });
  assert.equal(replay.status, 200);
  assert.equal((await lab.callDoc('/api/postits')).data.postits.length, 1);

  // Cross-owner access is forbidden (403)
  const crossOwner = await lab.callDoc(`/api/postits/${created.id}`, 'GET', undefined, {
    'x-blocknote-owner': 'other-user',
  });
  assert.equal(crossOwner.status, 403);

  // Archive and test CAS conflict on concurrent edit
  const archived = (await lab.callDoc(`/api/postits/${created.id}/archive`, 'POST', {})).data.postit;
  const staleEdit = await lab.callDoc(`/api/postits/${created.id}`, 'PATCH', {
    title: '구버전 수정',
    content: '내용',
    itemRevision: archived.itemRevision - 1,
  });
  assert.equal(staleEdit.status, 409);
  assert.equal(staleEdit.data.code, 'POSTIT_CONFLICT');

  // Control character injection is rejected (422)
  const badControl = await lab.callDoc(`/api/postits/${created.id}`, 'PATCH', {
    title: '정상 제목',
    content: '제어문자\x00포함',
    itemRevision: archived.itemRevision,
  });
  assert.equal(badControl.status, 422);

  // Export Post-its bundle and verify independent restore + duplicate backup rejection
  const postitExport = (await lab.callDoc('/api/postits/export')).data;
  assert.equal(postitExport.manifest.format, 'blocknote-postits');
  assert.equal(postitExport.postits.length, 1);

  const restore1 = await lab.callDoc('/api/postits/restore', 'POST', { bundle: postitExport });
  // Existing IDs and request IDs are rejected without creating duplicate notes.
  assert.equal(restore1.status, 409);
  assert.equal(restore1.data.code, 'POSTIT_RESTORE_CONFLICT');
  assert.equal((await lab.callDoc('/api/postits')).data.postits.length, 1);

  // Tampered Post-it backup is rejected (400)
  const tampered = structuredClone(postitExport);
  tampered.postits[0].content = '변조됨';
  const restoreTampered = await lab.callDoc('/api/postits/restore', 'POST', { bundle: tampered });
  assert.equal(restoreTampered.status, 400);

  // Scenario 17: Main document export/verify/restore (F07) remains 100% independent of Post-it files
  const docExport = (await lab.callDoc(`/api/documents/${lab.docId}/export`)).data;
  const verifiedDoc = verifyExport(docExport);
  assert.equal(verifiedDoc.doc.id, lab.docId);
  assert.deepEqual(Object.keys(docExport.files).sort(), ['document.json', 'history.jsonl']);
});

test('P0: 선택 문단과 질문이 분리되어 모델 요청에 모두 전달되고 누락 ID는 거부된다', async t => {
  const {makeSubscriptionRequest}=await import('../scripts/siwc-provider.mjs');let sent;
  const lab=await withLabFixture(t,{propose:async args=>{sent=JSON.parse(makeSubscriptionRequest(args).input[0].content);return {proposal:{content:'합성 응답',reason:'합성 이유'}};}});
  await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  const req={requestId:'ai:reference-test',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',targetIds:['p-3','p-1'],model:'gpt-6-luna',mode:'insert',goal:'질'.repeat(220),scopeText:'잘못된 클라이언트 문맥'};
  assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
  const job=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='review'?s:null;});
  assert.equal(sent.goal,req.goal);assert.deepEqual(sent.reference.blocks.map(b=>b.id),['p-1','p-3']);
  assert.match(sent.reference.blocks[0].text,/첫 번째/);assert.match(sent.reference.blocks[1].text,/세 번째/);assert.doesNotMatch(JSON.stringify(sent.reference),/잘못된 클라이언트/);
  assert.equal(job.proposal.postitSave,'saved');assert.equal((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data.revision,doc.revision);
  const bad={...req,requestId:'ai:missing-reference',targetIds:['p-1','missing']};assert.equal((await lab.callPanel('/panel/requests',bad)).status,202);
  const rejected=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${bad.requestId}?documentId=${lab.docId}`)).data;return s.state==='conflict'?s:null;});assert.equal(rejected.code,'REFERENCE_CHANGED');
});

test('P0: 저장 실패 후 AI 원문을 유지하고 같은 requestId로 한 번만 안전하게 복구',async t=>{
  let failWrite=true;
  const lab=await withLabFixture(t,{fetchImpl:async(url,opts)=>{
    if(failWrite&&opts?.method==='POST'&&new URL(url).pathname.endsWith('/postits')){failWrite=false;return new Response('{}',{status:503});}
    return fetch(url,opts);
  }});
  await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
  const req={requestId:'ai:save-retry',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert',goal:'합성 질문'};
  assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
  const job=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='review'?s:null;});
  assert.equal(job.proposal.postitSave,'failed');assert.match(job.proposal.content,/AI 의견 원문/);assert.equal((await lab.callDoc('/api/postits')).data.postits.length,0);
  const payload={requestId:req.requestId,proposalId:job.proposal.proposalId,documentId:lab.docId,baseRevision:doc.revision,model:req.model,prompt:req.goal,rawContent:job.proposal.content};
  const first=await lab.callDoc('/api/postits','POST',payload),replay=await lab.callDoc('/api/postits','POST',payload);assert.equal(first.status,201);assert.equal(replay.status,200);assert.equal((await lab.callDoc('/api/postits')).data.postits.length,1);
  assert.equal((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data.revision,doc.revision);
});

test('P1: 독립 포스트잇 백업을 빈 저장소에 복구하고 손상·중복·다른 범위는 원자적으로 거부',async t=>{
  const {createPostitStore}=await import('../server/postits.mjs');const {createHash}=await import('node:crypto');
  const dir=mkdtempSync(join(tmpdir(),'bn-b06-restore-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const a=createPostitStore({filePath:join(dir,'a.json')}),b=createPostitStore({filePath:join(dir,'b.json')});
  const made=await a.createDraft({documentId:'synthetic-doc',requestId:'req:1',rawContent:'합성 원문'});await a.archive(made.postit.id);const bundle=a.exportBundle();
  const restored=await b.restoreBundle(bundle);assert.equal(restored.restoredCount,1);assert.equal(b.get(made.postit.id).rawContent,'합성 원문');
  await assert.rejects(b.restoreBundle(bundle),e=>e.code==='DUPLICATE_POSTIT_BACKUP');
  const absent=createPostitStore({filePath:join(dir,'absent.json'),documentExists:()=>false});await assert.rejects(absent.restoreBundle(bundle),e=>e.code==='POSTIT_DOCUMENT_MISSING');assert.equal(absent.list().length,0);
  const c=createPostitStore({filePath:join(dir,'c.json')});const bad=structuredClone(bundle);bad.postits[0].itemRevision=-1;
  bad.manifest.digest=createHash('sha256').update(JSON.stringify(bad.postits,null,2)).digest('hex');await assert.rejects(c.restoreBundle(bad),e=>e.code==='INVALID_POSTIT_BACKUP');assert.equal(c.list().length,0);
  bad.postits[0].itemRevision=2;bad.postits[0].ownerScope='other';bad.manifest.digest=createHash('sha256').update(JSON.stringify(bad.postits,null,2)).digest('hex');await assert.rejects(c.restoreBundle(bad),e=>e.code==='INVALID_POSTIT_BACKUP');assert.equal(c.list().length,0);
});

test('P0: 쓰기는 성공했으나 응답이 유실되면 같은 ID 재시도로 중복을 만들지 않는다',async t=>{
 let lose=true;const lab=await withLabFixture(t,{fetchImpl:async(url,opts)=>{
  if(lose&&opts?.method==='POST'&&new URL(url).pathname.endsWith('/postits')){lose=false;await fetch(url,opts);throw Error('synthetic lost response');}return fetch(url,opts);
 }});
 await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
 const req={requestId:'ai:lost-reply',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert',goal:'합성 질문'};
 await lab.callPanel('/panel/requests',req);const job=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='review'?s:null;});
 assert.equal(job.proposal.postitSave,'failed');assert.equal((await lab.callDoc('/api/postits')).data.postits.length,1);
 const replay=await lab.callDoc('/api/postits','POST',{requestId:req.requestId,proposalId:job.proposal.proposalId,documentId:lab.docId,baseRevision:doc.revision,model:req.model,prompt:req.goal,rawContent:job.proposal.content});
 assert.equal(replay.status,200);assert.equal((await lab.callDoc('/api/postits')).data.postits.length,1);
});

test('P0: 참고 문맥 크기를 넘으면 모델 호출 전 명시적으로 거부하고 조용히 누락하지 않는다',async t=>{
 let calls=0;const lab=await withLabFixture(t,{propose:async()=>{calls++;throw Error('must not call');}});await lab.callPanel('/panel/connect',{});
 const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;doc.blocks[0].content[0].text='가'.repeat(6500);doc.blocks[1].content[0].text='나'.repeat(6500);
 const saved=await lab.callDoc(`/api/documents/${lab.docId}/document`,'PUT',{documentId:lab.docId,revision:doc.revision,blocks:doc.blocks});assert.equal(saved.status,200);
 const req={requestId:'ai:oversize-reference',documentId:lab.docId,baseRevision:saved.data.revision,targetId:'p-1',targetIds:['p-1','p-2'],model:'gpt-6-luna',mode:'insert',goal:'합성 질문'};
 await lab.callPanel('/panel/requests',req);const job=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='failed'?s:null;});
 assert.equal(job.code,'REFERENCE_TOO_LARGE');assert.equal(calls,0);
});

test('P1: 문서 범위 API는 다른 문서의 포스트잇을 읽거나 변경할 수 없다',async t=>{
 const lab=await withLabFixture(t);const created=(await lab.callDoc('/api/postits','POST',{documentId:lab.docId,requestId:'req:scope',rawContent:'합성 의견'})).data.postit;
 const second=(await lab.callDoc('/api/documents','POST',{title:'다른 합성 문서'})).data;
 assert.equal((await lab.callDoc(`/api/documents/${second.id}/postits/${created.id}`)).status,404);
 assert.equal((await lab.callDoc(`/api/documents/${second.id}/postits/${created.id}/archive`,'POST',{})).status,404);
 assert.equal((await lab.callDoc(`/api/documents/${second.id}/postits`,'POST',{documentId:lab.docId,requestId:'req:wrong',rawContent:'다른 문서'})).status,409);
 assert.equal((await lab.callDoc(`/api/postits/${created.id}`)).data.postit.archived,false);
});
test('P1: 포스트잇 로컬 API는 외부 Origin, 위조 Host와 form POST를 거부한다',async t=>{
 const lab=await withLabFixture(t);
 assert.equal((await lab.callDoc('/api/postits','GET',undefined,{Origin:'https://attacker.example'})).status,403);
 const {request}=await import('node:http');const hostStatus=await new Promise((resolve,reject)=>{const q=request(lab.docBase()+'/api/postits',{headers:{host:'attacker.example'}},r=>{r.resume();resolve(r.statusCode)});q.on('error',reject);q.end();});assert.equal(hostStatus,403);
 const forged=await lab.callDoc('/api/postits','POST',{requestId:'r:1',rawContent:'합성'},{Origin:'https://attacker.example'});assert.equal(forged.status,403);
 const plain=await lab.callDoc('/api/postits','POST',{requestId:'r:2',rawContent:'합성'},{'Content-Type':'text/plain'});assert.equal(plain.status,415);
 assert.equal((await lab.callDoc('/api/postits')).data.postits.length,0);
});
test('P1: 유효한 JSON이라도 손상된 포스트잇 저장소를 초기화하거나 덮어쓰지 않는다',async t=>{
 const {createPostitStore}=await import('../server/postits.mjs');const {writeFileSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'bn-b06-corrupt-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'postits.json'),s=createPostitStore({filePath:path});
 await s.createDraft({documentId:'doc:1',requestId:'req:1',rawContent:'합성 원문'});const bad=JSON.parse(readFileSync(path,'utf8'));bad.postits[0].itemRevision=-1;writeFileSync(path,JSON.stringify(bad));const before=readFileSync(path,'utf8');
 assert.throws(()=>s.list(),e=>e.code==='POSTIT_STORE_CORRUPT');await assert.rejects(s.createDraft({documentId:'doc:1',requestId:'req:2',rawContent:'새 원문'}),e=>e.code==='POSTIT_STORE_CORRUPT');assert.equal(readFileSync(path,'utf8'),before);
});
test('P0: 보관본 재검토 도중 버전이 바뀌면 최신 내용을 몰래 바꿔 보내지 않고 차단한다',async t=>{
 let calls=0;const lab=await withLabFixture(t,{propose:async()=>{calls++;return {proposal:{content:'합성',reason:'합성'}};}});await lab.callPanel('/panel/connect',{});
 const original=(await lab.callDoc('/api/postits','POST',{documentId:lab.docId,requestId:'req:reask-race',rawContent:'원문'})).data.postit;
 const archived=(await lab.callDoc(`/api/postits/${original.id}/archive`,'POST',{})).data.postit;
 assert.equal((await lab.callDoc(`/api/postits/${original.id}`,'PATCH',{title:'수정',content:'변경된 확정본',itemRevision:archived.itemRevision})).status,200);
 const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data,req={requestId:'ai:stale-note',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert',goal:'질문',reaskedFromId:original.id,reaskedItemRevision:archived.itemRevision};
 await lab.callPanel('/panel/requests',req);const result=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='conflict'?s:null;});assert.equal(result.code,'REFERENCE_CHANGED');assert.equal(calls,0);
});
test('P0: 같은 요청 ID와 원문이라도 다른 참조 메타데이터로 재사용할 수 없다',async t=>{
 const {createPostitStore}=await import('../server/postits.mjs');const dir=mkdtempSync(join(tmpdir(),'bn-b06-idempotency-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const s=createPostitStore({filePath:join(dir,'p.json')});
 const p={documentId:'doc:1',requestId:'req:1',proposalId:'proposal:1',rawContent:'합성',targetIds:['p1'],scopeText:'참고 A',model:'모델 A',prompt:'질문'};
 await s.createDraft(p);assert.equal((await s.createDraft(p)).replayed,true);
 await assert.rejects(s.createDraft({...p,scopeText:'참고 B'}),e=>e.code==='POSTIT_REQUEST_ID_REUSED');assert.equal(s.list().length,1);
});

test('B09: multiline Unicode and CRLF reach the provider; invalid controls never create a ledger entry',async t=>{
 const seen=[];const lab=await withLabFixture(t,{propose:async args=>{seen.push(args.goal);return {proposal:{content:'합성 응답',reason:'합성'}};}});
 await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
 const base={documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert'};
 for(const [i,goal] of ['첫 줄\n둘째 줄','첫째\r\n둘째\r\n\r\n셋째','한 줄'].entries()){
  const req={...base,requestId:`ai:multiline-${i}`,goal};
  assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
  await until(async()=>{const x=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return x.state==='review';});
 }
 assert.deepEqual(seen,['첫 줄\n둘째 줄','첫째\r\n둘째\r\n\r\n셋째','한 줄']);
 const bad={...base,requestId:'ai:invalid-control',goal:'잘못\u0001입력'};
 assert.equal((await lab.callPanel('/panel/requests',bad)).status,400);
 assert.equal((await lab.callPanel(`/panel/requests/${bad.requestId}?documentId=${lab.docId}`)).status,404);
 assert.equal((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data.revision,doc.revision);
});

test('B09: re-review sends the complete confirmed postit content and leaves original unchanged',async t=>{
 let seen;const lab=await withLabFixture(t,{propose:async args=>{seen=args.reference;return {proposal:{content:'별도 합성 답변',reason:'합성'}};}});
 await lab.callPanel('/panel/connect',{});
 const original=(await lab.callDoc('/api/postits','POST',{documentId:lab.docId,requestId:'b09:original',rawContent:'원본 텍스트',model:'gpt-6-luna'})).data.postit;
 const archived=(await lab.callDoc(`/api/postits/${original.id}/archive`,'POST',{})).data.postit;
 const edited=(await lab.callDoc(`/api/postits/${original.id}`,'PATCH',{title:'합성',content:'저장된 첫줄\n마지막 식별 문구 END-B09',itemRevision:archived.itemRevision})).data.postit;
 const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
 const req={requestId:'b09:reask',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6.1-sol',mode:'insert',goal:'재검토',reaskedFromId:edited.id,reaskedItemRevision:edited.itemRevision};
 assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
 const result=await until(async()=>{const s=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return s.state==='review'?s:null;});
 assert.equal(seen.content,edited.content);assert.match(seen.content,/END-B09$/);assert.equal(result.proposal.postitSave,'saved');
 assert.deepEqual((await lab.callDoc(`/api/postits/${original.id}`)).data.postit,edited);
 const all=(await lab.callDoc('/api/postits')).data.postits;assert.equal(all.length,2);assert.equal(all.find(p=>p.requestId==='b09:reask').model,'gpt-6.1-sol');
});

test('B09: model display keeps unknowns honest and distinguishes product variants',async()=>{
 const {shortModelName}=await import('../shared/postit-contract.mjs');
 assert.equal(shortModelName('gpt-6-luna'),'6luna');assert.equal(shortModelName('gpt-6.1-sol'),'6sol');
 assert.equal(shortModelName('claude-sonnet-4'),'Sonnet');assert.equal(shortModelName('claude-opus-4'),'Opus');
 assert.equal(shortModelName(null),'모델 미상');assert.equal(shortModelName('unknown-provider'),'unknown-provider');
});

test('B09 followup: LF and CRLF reach subscription request, streamed parser, and postit without document writes',async t=>{
 const {requestSubscriptionProposal}=await import('../scripts/siwc-provider.mjs');const sent=[];
 const lab=await withLabFixture(t,{propose:async args=>requestSubscriptionProposal({...args,fetchImpl:async(_url,opts)=>{
   sent.push(JSON.parse(JSON.parse(opts.body).input[0].content).goal);
   const events=[{type:'response.output_text.delta',delta:JSON.stringify({content:'합성 스트림 답변',reason:'합성 이유'})},{type:'response.completed',response:{status:'completed',id:'synthetic'}}];
   return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{status:200,headers:{'Content-Type':'text/event-stream'}});
 }})});
 await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
 const goal74='질'.repeat(36)+'\n'+'문'.repeat(37);assert.equal(goal74.length,74);
 const goals=['한 줄 질문','첫째 줄\n둘째 줄\n\n셋째 줄','첫째\r\n둘째\r\n셋째',goal74];
 for(const [i,goal] of goals.entries()){
  const req={requestId:`followup:stream-${i}`,documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert',goal};
  assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
  const job=await until(async()=>{const result=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return result.state==='review'?result:null;});
  assert.equal(job.proposal.content,'합성 스트림 답변');assert.equal(job.proposal.postitSave,'saved');
 }
 assert.deepEqual(sent,goals);assert.deepEqual((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data,doc);
 assert.equal((await lab.callDoc('/api/postits')).data.postits.length,4);
});

test('B09 followup: goal validation is consistent and other response fields remain strict',async()=>{
 const {makeSubscriptionRequest}=await import('../scripts/siwc-provider.mjs');
 const {parseOpenAIProposal}=await import('../scripts/openai-provider.mjs');
 const opts={document:{id:'d',revision:1,blocks:[{id:'p',type:'paragraph',props:{},content:[],children:[]}]},model:'gpt-6-luna',mode:'insert',targetId:'p'};
 for(const goal of ['\u0000bad','a'.repeat(241),'   '])assert.throws(()=>makeSubscriptionRequest({...opts,goal}),e=>e.code==='INVALID_GOAL');
 assert.throws(()=>parseOpenAIProposal({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({content:'합성',reason:'허용\n안됨'})}]}]}));
});

test('B09 followup: provider failure is classified without leaking content and the question remains available',async t=>{
 const {requestSubscriptionProposal}=await import('../scripts/siwc-provider.mjs');
 const lab=await withLabFixture(t,{propose:args=>requestSubscriptionProposal({...args,fetchImpl:async()=>new Response('synthetic provider detail',{status:503})})});
 await lab.callPanel('/panel/connect',{});const doc=(await lab.callDoc(`/api/documents/${lab.docId}/document`)).data;
 const req={requestId:'followup:provider-fail',documentId:lab.docId,baseRevision:doc.revision,targetId:'p-1',model:'gpt-6-luna',mode:'insert',goal:'한 줄\n다음 줄'};
 assert.equal((await lab.callPanel('/panel/requests',req)).status,202);
 const state=await until(async()=>{const x=(await lab.callPanel(`/panel/requests/${req.requestId}?documentId=${lab.docId}`)).data;return x.state==='failed'?x:null;});
 assert.equal(state.code,'AI_PROVIDER_UNAVAILABLE');assert.equal(state.goal,req.goal);assert.doesNotMatch(JSON.stringify(state),/synthetic provider detail/);
 assert.deepEqual((await lab.callDoc(`/api/documents/${lab.docId}/document`)).data,doc);
});

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { remoteDecision } from './syncPolicy.mjs';
import AiPanel from './AiPanel.jsx';
import ParagraphComparison from './ParagraphComparison.jsx';
import RestorePanel from './RestorePanel.jsx';
import PublicationPanel from './PublicationPanel.jsx';
import PostitDrawer from './PostitDrawer.jsx';
import ArchivedPostitView from './ArchivedPostitView.jsx';
import BlockSelectionTools from './BlockSelectionTools.jsx';
import {isEditableParagraph,paragraphText} from '../../shared/block-edit.mjs';
import {
  pruneSelectedBlocks,
  toggleSelectedBlock,
  formatSelectionClipboard,
  resolveQuestionScope,
} from '../../shared/paragraph-selection.mjs';
import { normalizeHistoryResponse } from './historyViewModel.mjs';
import {editorSchema,applyFontSize} from './editorSchema.mjs';
import {readPreference,writePreference,orderedDocuments,moveId,fontSize} from './appearance.mjs';
import BlockMoveTools from './BlockMoveTools.jsx';
import Overlay from './Overlay.jsx';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

async function request(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}
const SITE = import.meta.env.VITE_LAB_SITE === '1';
const asJson = (data) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

function Editor({
  initial, documentTitle, onStatus: notifyStatus, onRevision: notifyRevision,
  guard, switching, legacy, workspaceHeader, historyOpen, closeHistory,
  mobileAI, showAI, hideAI, aiHidden, documentExpanded,
  postits, onEnsureDraftPostit, onArchivePostit,
  reaskContext, onClearReask, archivedPostit, onCloseArchivedPostit, onAskArchivedPostit,
}) {
  const active = useRef(true);
  const onStatus = value => { if(active.current) notifyStatus(value); };
  const onRevision = value => { if(active.current) notifyRevision(value); };
  const aiGuard = useRef(() => true), selectionGuard = useRef(() => true);
  const [selectedTarget,setSelectedTarget] = useState(null);
  const [reviewContext,setReviewContext] = useState(null);
  const [selectingParagraphs,setSelectingParagraphs] = useState(false);
  const [selectedBlockIds,setSelectedBlockIds] = useState([]);
  const [deleteUndo,setDeleteUndo] = useState(null);
  const selectionSerial = useRef(0);
  const scopedRequest = async (path, options) => {
    const result = await request(legacy ? path : '/api/documents/' + encodeURIComponent(initial.id) + path.slice(4), options);
    if (!active.current) throw Error('이전 문서 응답 무시');
    return result;
  };
  const editor = useMemo(() => BlockNoteEditor.create({ schema:editorSchema, initialContent: initial.blocks }), [initial]);
  const version = useRef(initial.revision);
  // Compare normalized editor blocks, including styles/props/children/IDs. Only
  // advance this snapshot after a confirmed PUT or an applied server document.
  const confirmedBlocks = useRef(null);
  if (confirmedBlocks.current === null) confirmedBlocks.current = JSON.stringify(editor.document);
  const dirty = useRef(false);
  const editingSequence = useRef(0);
  const saving = useRef(false);
  const suppress = useRef(false);
  const composing = useRef(false);
  const discardInFlight = useRef(false);
  const saveBlocked = useRef(false); // Never automatically replay an uncertain PUT.
  const refreshSerial = useRef(0);
  const timer = useRef(null);
  const viewport=useRef(null),split=useRef(null);
  const [reordering,setReordering]=useState(false),[size,setSize]=useState(17),[sizeScope,setSizeScope]=useState('all');
  const [ratio,setRatio]=useState(()=>Math.max(38,Math.min(68,readPreference('blocknote.p2.split',55))));
  useEffect(()=>{
    const syncSize=()=>{setSizeScope(editor.getSelectedText()?'selection':'all');const current=editor.getActiveStyles().fontSize;setSize(fontSize(current));};
    syncSize();
    return editor.onSelectionChange(syncSize);
  },[editor]);
  const canChange=()=>!switching&&!composing.current&&!discardInFlight.current&&!saveBlocked.current&&selectionGuard.current();
  function changeSize(value){if(!canChange()){onStatus('입력 조합·저장 오류·AI 작업을 마친 뒤 서식을 변경하세요.');return;}applyFontSize(editor,value,sizeScope==='all');setSize(fontSize(value));}
  function changeFormat(type){if(!canChange())return;const targets=editor.getSelection()?.blocks??[editor.getTextCursorPosition().block];editor.transact(()=>targets.forEach(b=>editor.updateBlock(b,{type,props:type==='heading'?{level:2}:{}})));}
  const resizeTo=value=>{const v=Math.max(38,Math.min(68,value));setRatio(v);writePreference('blocknote.p2.split',v);};
  const [history, setHistory] = useState([]);
  const [historyState, setHistoryState] = useState('loading'); // loading | ready | error
  const [historyError, setHistoryError] = useState('');
  const historyRequestSerial = useRef(0);
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveIssue, setSaveIssue] = useState(null); // null | conflict | uncertain | retryable
  const [validationError, setValidationError] = useState('');
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [publicationOpen, setPublicationOpen] = useState(false);

  // A saved Post-it becomes the sole reference; do not leave stale paragraph selection highlighted.
  useEffect(()=>{if(reaskContext){setSelectedBlockIds([]);setSelectedTarget(null);}},[reaskContext]);

  // Sync single selectedTarget when 1 editable paragraph is selected via B-04 general selection
  useEffect(()=>{
    const valid = pruneSelectedBlocks(editor.document, selectedBlockIds);
    if (valid.length !== selectedBlockIds.length) {
      setSelectedBlockIds(valid);
      return;
    }
    if (valid.length === 1) {
      const b = editor.document.find(item => item.id === valid[0]);
      if (b && isEditableParagraph(b)) {
        setSelectedTarget(previous=>previous?.id===b.id&&previous.explicitEdit?{...previous,text:paragraphText(b)}:{id:b.id,text:paragraphText(b),serial:++selectionSerial.current,explicitEdit:false});
      }
    } else {
      setSelectedTarget(null);
    }
  }, [selectedBlockIds, editor]);

  // B-04: Ctrl+C / Cmd+C copy handler when paragraphs are selected
  useEffect(()=>{
    const onCopy = event => {
      if (!selectedBlockIds.length) return;
      const targetEl = event.target;
      if (targetEl?.closest?.('textarea, input')) return;
      if (window.getSelection && !window.getSelection().isCollapsed) return;
      const text = formatSelectionClipboard(editor.document, selectedBlockIds);
      if (!text) return;
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
        onStatus('선택 문단을 복사했어요.');
      }
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [editor, selectedBlockIds]);

  const handleToggleBlockSelection = blockId => {
    setSelectedBlockIds(prev => {
      const next = toggleSelectedBlock(editor.document, prev, blockId);
      onStatus(next.length ? `선택 문단 ${next.length}개 · 복사하거나 AI 질문에 참조할 수 있어요.` : '문단 선택을 해제했어요.');
      return next;
    });
  };

  const handleCopySelectedBlocks = async () => {
    const text = formatSelectionClipboard(editor.document, selectedBlockIds);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onStatus('선택 문단을 클립보드에 복사했어요.');
    } catch {
      onStatus('클립보드 복사 권한을 확인해 주세요.');
    }
  };

  const handleClearSelectedBlocks = () => {
    setSelectedBlockIds([]);
    setSelectedTarget(null);
    onStatus('문단 선택을 해제했어요.');
  };

  // Recovery is intentionally limited to the most recent deletion while the
  // document remains unchanged; never overwrite edits made after deletion.
  const handleDeleteSelectedBlocks = () => {
    if (!selectedBlockIds.length || !canChange()) return;
    const before = structuredClone(editor.document);
    const ids = editor.document.filter(b => selectedBlockIds.includes(b.id)).map(b => b.id);
    if (!ids.length) return;
    editor.removeBlocks(ids);
    setDeleteUndo({before, after: JSON.stringify(editor.document), count: ids.length});
    setSelectedBlockIds([]); setSelectedTarget(null); onClearReask?.();
    onStatus('선택 문단을 삭제했어요. 저장 상태를 확인하세요.');
  };
  const undoSelectedDeletion = () => {
    if (!deleteUndo || !canChange()) return;
    if (JSON.stringify(editor.document) !== deleteUndo.after) {
      setDeleteUndo(null);
      onStatus('삭제 후 문서가 바뀌어 자동 복구할 수 없어요. 기존 백업을 확인하세요.');
      return;
    }
    editor.replaceBlocks(editor.document, deleteUndo.before);
    setDeleteUndo(null);
    onStatus('삭제를 되돌렸어요. 저장 상태를 확인하세요.');
  };

  const toggleSelectParagraphsMode = () => {
    if (switching || composing.current || !selectionGuard.current()) {
      onStatus('진행 중인 AI 요청 또는 한글 입력을 마친 뒤 선택 모드를 변경해 주세요.');
      return;
    }
    const next = !selectingParagraphs;
    setSelectingParagraphs(next);
    if (next && reordering) setReordering(false);
    onStatus(next ? '문단 선택 모드 · 하나 또는 여러 문단을 눌러 선택하세요. 선택만으로 AI 요청이 전송되지 않습니다.' : '문단 선택 모드를 종료했어요.');
  };

  const loadHistory = async () => {
    const serial = ++historyRequestSerial.current;
    setHistoryState('loading');
    try {
      const rows = normalizeHistoryResponse(await scopedRequest('/api/history'));
      if (serial !== historyRequestSerial.current) return; // Ignore superseded requests.
      setHistory(rows);
      setHistoryError('');
      setHistoryState('ready');
    } catch (err) {
      if (serial !== historyRequestSerial.current) return;
      // Keep the previous successful snapshot; never mislabel a failed GET as empty.
      setHistoryError(err.message);
      setHistoryState('error');
    }
  };

  function exportLocal() {
    try {
      const payload = JSON.stringify({
        documentId: initial.id, revision: version.current, blocks: editor.document,
        localEdits: dirty.current, exportedAt: new Date().toISOString(),
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'blocknote-local-backup.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onStatus('JSON 백업 다운로드를 요청했어요. 저장 완료 여부를 확인하세요.');
      return true; // Download was requested; browser persistence is NOT verified.
    } catch (err) {
      onStatus(`JSON 백업 생성 실패: ${err.message}`);
      return false;
    }
  }

  function markConflict(message) {
    clearTimeout(timer.current);
    saveBlocked.current = true;
    setSaveIssue('conflict');
    setConflict(true);
    setRemoteAvailable(true);
    onStatus(message);
  }

  const refreshFromServer = async ({ discard = false, manual = false } = {}) => {
    if (composing.current || saving.current) {
      onStatus('입력 조합 또는 저장이 끝난 뒤 서버 상태를 확인하세요.');
      return;
    }
    // A destructive action is possible only after a local JSON backup request and
    // an explicit confirmation. Never clear dirty before a successful remote GET.
    if (discard && dirty.current) {
      if (!exportLocal()) return;
      if (!window.confirm('JSON 다운로드가 완료되었는지 확인하세요. 현재 로컬 편집을 버리고 서버 문서로 교체할까요?')) return;
      clearTimeout(timer.current);
      discardInFlight.current = true;
    }
    const seq = editingSequence.current;
    const token = ++refreshSerial.current;
    try {
      const current = await scopedRequest('/api/document');
      if (token !== refreshSerial.current) return; // An older GET must not win.
      const decision = remoteDecision({
        remoteRevision: current.revision, localRevision: version.current,
        composing: composing.current, saving: saving.current,
        editChanged: editingSequence.current !== seq,
        dirty: dirty.current, focused: editor.isFocused({ includeEditorUI: true }),
        discardConfirmed: discard,
      });
      if (decision === 'abort') {
        onStatus('서버 조회 중 새 편집이 발생해 로컬 내용을 유지했어요.');
        return;
      }
      if (decision === 'conflict') {
        markConflict('서버 문서가 변경됐어요. 로컬 편집은 보존했고 자동 저장을 중지했어요.');
        return;
      }
      if (decision === 'keep-local') {
        if (manual) onStatus('미저장 로컬 편집을 유지 중이에요. 서버 문서로 교체하지 않았어요.');
        return;
      }
      if (decision === 'defer-focus') {
        setRemoteAvailable(true);
        onStatus('서버에 새 변경사항이 있어요. 편집 중이라 자동 반영하지 않았어요.');
        return;
      }
      if (decision !== 'apply') return;
      suppress.current = true;
      try {
        editor.replaceBlocks(editor.document, current.blocks);
        confirmedBlocks.current = JSON.stringify(editor.document);
        version.current = current.revision;
        setSelectedBlockIds(prev => pruneSelectedBlocks(current.blocks, prev));
        dirty.current = false;
        setHasLocalEdits(false);
        saveBlocked.current = false;
        setSaveIssue(null);
        setRemoteAvailable(false);
        setConflict(false);
        onRevision(current.revision);
        onStatus(discard ? '백업을 요청한 뒤 서버 문서로 교체했어요.' : '최신 문서를 불러왔어요.');
      } finally { suppress.current = false; }
      void loadHistory();
    } catch (err) {
      onStatus(`서버 문서 확인 실패: ${err.message}. 로컬 내용은 유지했어요.`);
    } finally {
      if (discard) {
        // Do not automatically save after an aborted/failed discard request.
        // The local copy remains dirty and the user can explicitly save it.
        discardInFlight.current = false;
      }
    }
  };

  const save = async () => {
    if (composing.current || discardInFlight.current || !dirty.current || saveBlocked.current) return;
    if (saving.current) return;
    const sequenceAtSave = editingSequence.current;
    const blocksAtSave = editor.document;
    const blocksKeyAtSave = JSON.stringify(blocksAtSave);
    // Editing and then undoing before the debounce expires needs no new audit
    // event. This guard must stay AFTER the conflict/uncertain/in-flight guards.
    if (blocksKeyAtSave === confirmedBlocks.current) {
      dirty.current = false;
      setHasLocalEdits(false);
      onStatus('변경 없음 · 저장된 내용과 같아요.');
      return;
    }
    saving.current = true;
    setValidationError('');
    const revisionAtSave = version.current;
    onStatus('저장 중…');
    try {
      const next = await scopedRequest('/api/document', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: initial.id, revision: revisionAtSave, blocks: blocksAtSave, actor: 'human-editor' }),
      });
      version.current = next.revision;
      confirmedBlocks.current = blocksKeyAtSave;
      onRevision(next.revision);
      if (editingSequence.current === sequenceAtSave) {
        dirty.current = false;
        setHasLocalEdits(false);
        onStatus('저장됨');
      } else {
        onStatus('저장 중 추가 편집 발생 · 다시 저장 대기');
      }
      void loadHistory();
    } catch (err) {
      if (err.status === 409) {
        markConflict('저장 충돌(409): 로컬 편집을 보존했어요. 서버 문서를 확인하세요.');
      } else if (err.status === 422) {
        setValidationError(err.message);
        onStatus('저장 거절됨 · 로컬 편집 유지');
      } else {
        // A timeout, failed JSON parse, 503 or lost response can mean the PUT
        // succeeded remotely. No blind automatic retry (PUT has no receipt).
        clearTimeout(timer.current);
        saveBlocked.current = true;
        setSaveIssue('uncertain');
        onStatus(`저장 결과 불확실 (${err.status || '네트워크'}): ${err.message}. 자동 재시도 중지.`);
      }
    } finally {
      saving.current = false;
      if (dirty.current && !saveBlocked.current && !composing.current && !discardInFlight.current
          && editingSequence.current !== sequenceAtSave) {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), 900);
      }
    }
  };

  async function checkAfterFailure() {
    if (composing.current || saving.current) return;
    const seq = editingSequence.current;
    try {
      const current = await scopedRequest('/api/document');
      if (composing.current || saving.current || seq !== editingSequence.current) {
        onStatus('서버 조회 중 새 편집이 발생했습니다. 다시 확인하세요.');
        return;
      }
      if (current.revision !== version.current) {
        markConflict('서버 변경 번호가 달라졌어요. 로컬 편집은 보존 중이며 병합은 수동으로 해야 해요.');
        return;
      }
      saveBlocked.current = true;
      setSaveIssue('retryable');
      onStatus('서버 변경 번호가 동일해요. 로컬 JSON 백업 후 수동 재시도를 선택할 수 있어요.');
    } catch (err) {
      onStatus(`서버 상태 확인 실패: ${err.message}. 자동 재시도는 중지 상태예요.`);
    }
  }

  async function retrySave() {
    if (composing.current || saving.current || discardInFlight.current || !dirty.current) return;
    if (!window.confirm('서버 상태를 다시 확인하고 로컬 편집을 수동 저장할까요? 이전 PUT 결과가 불확실할 수 있습니다.')) return;
    try {
      const current = await scopedRequest('/api/document');
      if (composing.current || saving.current) return;
      if (current.revision !== version.current) {
        markConflict('재시도 직전 서버 변경 번호가 달라졌어요. 로컬 편집을 유지합니다.');
        return;
      }
      saveBlocked.current = false;
      setSaveIssue(null);
      await save(); // CAS revision protects against a late first PUT; 409 stays local.
    } catch (err) {
      onStatus(`재시도 전 확인 실패: ${err.message}. 로컬 편집을 유지합니다.`);
    }
  }

  guard.current = () => !composing.current && !dirty.current && !saving.current &&
    !saveBlocked.current && !discardInFlight.current && aiGuard.current();
  useEffect(() => {
    active.current = true;
    void loadHistory();
    const unsubscribe = editor.onChange(() => {
      if (suppress.current) return;
      editingSequence.current += 1;
      setValidationError('');
      dirty.current = true;
      setHasLocalEdits(true);
      setSelectedBlockIds(prev => pruneSelectedBlocks(editor.document, prev));
      onStatus(composing.current ? '한글 입력 중… 자동 저장 대기' : '편집 중…');
      clearTimeout(timer.current);
      if (!composing.current && !saveBlocked.current && !discardInFlight.current) {
        timer.current = setTimeout(() => void save(), 900);
      }
    });
    const poll = setInterval(() => { void refreshFromServer(); }, 3000);
    const beforeUnload = (event) => {
      if (dirty.current || saving.current || saveBlocked.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      active.current = false; refreshSerial.current += 1;
      historyRequestSerial.current += 1; // Invalidate pending history GET on unmount.
      unsubscribe(); clearInterval(poll); clearTimeout(timer.current);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [editor]);

  async function simulateAgent() {
    try {
      if (composing.current || dirty.current || saving.current || saveBlocked.current) {
        onStatus('먼저 로컬 편집의 저장 상태를 해결하세요.'); return;
      }
      const doc = await scopedRequest('/api/document');
      await scopedRequest('/api/blocks', asJson({
        documentId: initial.id, revision: doc.revision, afterId: editor.document.at(-1)?.id, actor: 'demo-agent',
        content: 'AI 데모: 화면 조작 없이 블록 수정 API로 추가한 검토 의견입니다.',
      }));
      onStatus('AI 데모 API 요청 성공 · 서버 문서 확인');
      void refreshFromServer();
    } catch (err) { onStatus(`AI 데모 실패: ${err.message}`); }
  }

  function requestReview() {
    // Do not override an in-flight or reviewable proposal with another mode.
    if (switching || composing.current || !selectionGuard.current()) {
      onStatus('진행 중인 AI 요청 또는 한글 입력을 마친 뒤 다시 검토해 주세요.');
      return;
    }
    // B-04: Never silently pretend the first paragraph is selected when nothing is selected!
    const selectedText = editor.getSelectedText()?.trim();
    setSelectedTarget(null);
    setReviewContext({
      serial: ++selectionSerial.current,
      text: selectedText || '',
    });
    showAI();
    onStatus('의견 나누기가 열렸어요. 기존 본문은 변경되지 않습니다.');
  }

  function selectParagraph() {
    if(switching || composing.current || dirty.current || saving.current || saveBlocked.current ||
      discardInFlight.current || !selectionGuard.current()) {
      onStatus('입력·저장을 마치고 진행 중인 제안을 승인하거나 거절한 뒤 문단을 선택하세요.'); return;
    }
    const block=editor.getTextCursorPosition()?.block;
    if(!editor.document.some(b=>b.id===block?.id) || !isEditableParagraph(block)) {
      onStatus('커서를 서식 없는 일반 문단에 놓으세요. 하위 블록·서식·링크가 있는 문단은 수정할 수 없습니다.');return;
    }
    setSelectedBlockIds([block.id]);
    setSelectedTarget({id:block.id,text:paragraphText(block),serial:++selectionSerial.current,explicitEdit:true});
    showAI();
    onStatus('수정할 문단을 선택했어요. AI 협업에서 수정 요청과 비교를 진행하세요.');
  }

  const handleCompositionStart = () => {
    composing.current = true;
    clearTimeout(timer.current);
    onStatus('한글 입력 중… 자동 저장 대기');
  };
  const handleCompositionEnd = () => {
    composing.current = false;
    clearTimeout(timer.current);
    if (dirty.current && !saveBlocked.current && !discardInFlight.current) {
      timer.current = setTimeout(() => void save(), 1000);
    }
    onStatus('입력 완료 · 저장 대기');
  };

  const questionScope = resolveQuestionScope({
    blocks: editor.document,
    selectedIds: selectedBlockIds,
    reaskContext,
    revision: version.current,
  });

  const canUseDocument = () => !switching && !composing.current && !dirty.current && !saving.current &&
    !saveBlocked.current && !discardInFlight.current && !remoteAvailable && !conflict;
  const archivedPostitMatches = archivedPostit?.documentId === initial.id;
  async function insertViewedPostit() {
    if (!canUseDocument()) throw Error('문서 편집 또는 저장을 먼저 마쳐 주세요.');
    const path = '/api/postits/' + encodeURIComponent(archivedPostit.reaskedFromId) + '/insert';
    await scopedRequest(path, asJson({ revision: version.current, itemRevision: archivedPostit.itemRevision }));
    await refreshFromServer({ manual: true });
  }
  async function checkViewedPostitReceipt() {
    const receipt = await scopedRequest('/api/requests/' + encodeURIComponent(archivedPostit.requestId));
    return receipt.outcome === 'COMMITTED' && receipt.httpStatus === 201;
  }

  return <div className={'workspace-grid'+(mobileAI?' mobile-ai-open':'')+(aiHidden?' is-ai-hidden':'')+(documentExpanded?' is-document-expanded':'')} ref={split} style={{'--document-ratio':ratio+'%'}}>
    <div className="editor-area">
      {workspaceHeader}
      <nav className="toolbar phase2-editor-toolbar b05-toolbar" aria-label="문서 작업 도구">
        <div className="phase2-format-scroll" aria-label="서식 도구, 좌우로 스크롤 가능">
          <div className="font-size-control" role="group" aria-label="글씨 크기 조절">
           <button type="button" id="fontDecrease" aria-label="글씨 작게" onPointerDown={e=>e.preventDefault()} onClick={()=>changeSize(size-1)}>A−</button>
           <input aria-label="글씨 크기(px)" type="number" min="12" max="36" value={size} onChange={e=>changeSize(e.target.value)}/>
           <select aria-label="글씨 크기 적용 범위" value={sizeScope} onChange={e=>setSizeScope(e.target.value)}><option value="selection" disabled={!editor.getSelectedText()}>선택 영역</option><option value="all">문서 전체</option></select>
           <button type="button" id="fontIncrease" aria-label="글씨 크게" onPointerDown={e=>e.preventDefault()} onClick={()=>changeSize(size+1)}>A＋</button>
          </div>
          <details className="b05-format-details">
            <summary id="b05FormatToggle" aria-label="세부 서식">서식 ⌄</summary>
            <div className="b05-format-popover" id="b05FormatMenu">
              <label className="phase2-format-label"><span className="sr-only">문단 서식</span><select aria-label="문단 서식" defaultValue="paragraph" onPointerDown={e=>e.stopPropagation()} onChange={e=>changeFormat(e.target.value)}>
               <option value="paragraph">본문</option><option value="heading">제목</option><option value="bulletListItem">목록</option><option value="numberedListItem">번호 목록</option><option value="quote">인용</option></select></label>
              <button type="button" className="subtle" aria-label="굵게" title="굵게"
                onPointerDown={e=>e.preventDefault()} onClick={()=>{if(canChange())editor.toggleStyles({bold:true});}}><strong>B</strong></button>
              <button type="button" className="subtle" aria-label="기울임" title="기울임"
                onPointerDown={e=>e.preventDefault()} onClick={()=>{if(canChange())editor.toggleStyles({italic:true});}}><em>I</em></button>
              <button type="button" className="subtle" aria-label="밑줄" title="밑줄"
                onPointerDown={e=>e.preventDefault()} onClick={()=>{if(canChange())editor.toggleStyles({underline:true});}}><u>U</u></button>
              <button type="button" aria-label="목록" onPointerDown={e=>e.preventDefault()} onClick={()=>changeFormat('bulletListItem')}>☷</button>
              <button type="button" aria-label="인용" onPointerDown={e=>e.preventDefault()} onClick={()=>changeFormat('quote')}>❝</button>
            </div>
          </details>
          <button type="button" id="reorderToggle" aria-pressed={reordering} onClick={()=>{if(selectingParagraphs)setSelectingParagraphs(false);setReordering(!reordering);}}>↕ 문단 이동</button>
        </div>
        <button type="button" id="inlineAiAction" className="phase2-ai-fixed" onPointerDown={e=>e.preventDefault()}
          aria-pressed={selectingParagraphs} onClick={toggleSelectParagraphsMode} disabled={switching} aria-label="문단 선택">☷ 문단 선택</button>
        <details className="phase2-more-tools">
          <summary aria-label="기타 문서 도구">⋯ 기타</summary>
          <div className="phase2-more-popover">
            <button type="button" onPointerDown={e=>e.preventDefault()} onClick={requestReview} disabled={switching}>✦ AI에게 검토</button>
            <button type="button" onPointerDown={e=>e.preventDefault()} onClick={selectParagraph}
              disabled={switching || hasLocalEdits}>이 문단 AI 수정</button>
            <button type="button" onClick={()=>void simulateAgent()}>AI 데모 블록</button>
            <button type="button" onClick={()=>void refreshFromServer({manual:true})}>서버 상태 확인</button>
            <button type="button" onClick={()=>void save()} disabled={!hasLocalEdits || Boolean(saveIssue)}>로컬 저장</button>
            <button type="button" onClick={exportLocal}>JSON 백업</button>
            {SITE && !legacy && <button type="button" disabled={switching} onClick={event=>{
              const menu = event.currentTarget.closest('details');
              menu.open = false;
              menu.querySelector('summary').focus();
              setPublicationOpen(true);
            }}>공개 발행</button>}
          </div>
        </details>
      </nav>
      {publicationOpen && <PublicationPanel canPublish={canUseDocument} getRevision={()=>version.current}
        preview={()=>scopedRequest('/api/publication/preview', asJson({}))}
        publish={snapshot=>scopedRequest('/api/publication', asJson({
          confirmed:true, digest:snapshot.digest, testMode:snapshot.testMode,
        }))}
        onClose={()=>setPublicationOpen(false)} />}
      {(selectedBlockIds.length > 0 || (selectingParagraphs && !deleteUndo)) && (
        <div className="b05-selection-strip" id="b05SelectionStrip" role="status">
          <span id="b05SelectionCount">선택 문단 {selectedBlockIds.length}개</span>
          <button type="button" id="b09DeleteSelected" disabled={!selectedBlockIds.length} onClick={handleDeleteSelectedBlocks}>삭제</button>
          <button type="button" id="b05ClearSelected" disabled={!selectedBlockIds.length} onClick={handleClearSelectedBlocks}>선택 해제</button>
          <button type="button" id="b05CopySelected" disabled={!selectedBlockIds.length} onClick={() => void handleCopySelectedBlocks()}>복사</button>
        </div>
      )}
      {deleteUndo && <div className="b09-delete-notice" role="status"><span>문단 {deleteUndo.count}개 삭제됨</span><button type="button" id="b09UndoDelete" onClick={undoSelectedDeletion}>되돌리기</button><small>다른 편집·새로고침 전 가능</small></div>}
      {hasLocalEdits && <div className="local-edits" role="status">미저장 로컬 편집이 있어요. 서버 문서로 자동 교체하지 않아요.</div>}
      {validationError && <div className="notice" role="alert">
        <span>저장할 수 없어요. {validationError} 편집 내용은 이 탭에 남아 있어요.</span>
        <div className="notice-actions"><button type="button" onClick={exportLocal}>JSON 백업</button></div>
      </div>}
      {(remoteAvailable || saveIssue) && <div className="notice" role="alert">
        <span>{conflict ? '서버와 로컬 편집이 달라요. JSON 백업 후 수동 병합하거나 서버 문서로 교체하세요.' :
          saveIssue === 'uncertain' ? '저장 응답이 불확실해 자동 재시도를 중지했어요. 먼저 서버 상태를 확인하세요.' :
          saveIssue === 'retryable' ? '서버 변경 번호가 동일합니다. 백업 후 수동 재시도할 수 있어요.' :
          '서버에 새 변경사항이 있어요. 편집 중이라 자동 반영하지 않았어요.'}</span>
        <div className="notice-actions">
          {saveIssue === 'uncertain' && <button onClick={() => void checkAfterFailure()}>서버 상태 확인</button>}
          {saveIssue === 'retryable' && <button onClick={() => void retrySave()}>수동 저장 재시도</button>}
          {remoteAvailable && <button onClick={() => void refreshFromServer({ discard: true })}>
            {hasLocalEdits ? '백업 후 로컬 편집 버리기' : '서버 변경 반영'}
          </button>}
        </div>
      </div>}
      <section className={'editor-card'+(reordering?' reordering':'')+(selectingParagraphs?' b05-selecting':'')} aria-label="공유 문서 편집 영역">
        <div className="editor-viewport" ref={viewport}
          onCompositionStartCapture={handleCompositionStart}
          onCompositionEndCapture={handleCompositionEnd}>
          <BlockNoteView editor={editor} theme="light" editable={!switching && !selectingParagraphs} formattingToolbar={false} />
          <BlockMoveTools editor={editor} container={viewport} enabled={reordering} canMove={canChange} onStatus={onStatus}/>
          <BlockSelectionTools editor={editor} container={viewport} enabled={selectingParagraphs} selectedIds={selectedBlockIds} onToggleBlock={handleToggleBlockSelection}/>
        </div>
      </section>
    </div>
    <div className="phase2-resizer" role="separator" aria-label="문서와 AI 도우미 크기 조절" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={38} aria-valuemax={68} aria-valuenow={Math.round(ratio)}
      onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resizeTo(ratio+(e.key==='ArrowLeft'?-2:2));}}}
      onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();}}
      onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId)){const r=split.current.getBoundingClientRect();resizeTo((e.clientX-r.left)/r.width*100);}}}/>
    <div className="sidebar-stack">
      <AiPanel onClose={hideAI}
        archivedPostitView={archivedPostit && <ArchivedPostitView key={archivedPostit.reaskedFromId + ':' + archivedPostit.itemRevision}
          note={archivedPostit} onClose={onCloseArchivedPostit}
          onAsk={archivedPostitMatches ? onAskArchivedPostit : undefined}
          onInsert={archivedPostitMatches ? insertViewedPostit : undefined}
          canInsert={archivedPostitMatches && canUseDocument()}
          checkInserted={archivedPostitMatches ? checkViewedPostitReceipt : undefined} />}
        reviewContext={reviewContext} selectedTarget={selectedTarget} selectedBlockIds={selectedBlockIds}
        questionScope={questionScope} reaskContext={reaskContext} onClearReask={onClearReask}
        postits={postits} onEnsureDraftPostit={onEnsureDraftPostit} onArchivePostit={onArchivePostit}
        selectionGuard={selectionGuard} legacy={legacy} documentId={initial.id} documentTitle={documentTitle} getRevision={() => version.current} guard={aiGuard}
        getEditableParagraphs={() => editor.document.filter(isEditableParagraph).map(b=>({id:b.id,text:paragraphText(b)}))}
        getTarget={mode => mode==='patch'?(selectedTarget?.id||selectedBlockIds[0]):(selectedBlockIds.at(-1)||editor.document.at(-1)?.id)}
        canAct={canUseDocument}
        onCommitted={() => { setSelectedTarget(null); setSelectedBlockIds([]); setSelectingParagraphs(false); return refreshFromServer({manual:true}); }}
      />
    </div>
    {historyOpen&&<Overlay title="변경 이력" onClose={closeHistory}><aside className="history" aria-label="최근 변경 이력">
      <div className="history-heading">
        <h2>최근 변경</h2>
        <button type="button" className="history-refresh" onClick={() => void loadHistory()}
          disabled={historyState === 'loading'}>이력 새로고침</button>
      </div>
      <p className="history-disclaimer">기록된 주체는 요청자가 제출한 이름이며 인증된 사용자 신원이 아닙니다.</p>
      {historyState === 'loading' && <p role="status">변경 이력을 불러오는 중…</p>}
      {historyState === 'error' && <p className="history-error" role="alert">
        이력 조회 실패: {historyError}. {history.length ? '마지막으로 확인한 기록을 표시합니다.' : '기록 유무를 확인할 수 없습니다.'}
      </p>}
      {historyState === 'ready' && history.length === 0 && <p role="status">아직 변경 기록이 없습니다.</p>}
      {history.length > 0 && <ol className="history-list" aria-label="최신순 변경 기록">
        {history.slice(0, 7).map((event, i) => <li key={`${event.revision}-${event.transactionId || i}`} className="history-item">
          <span className="history-actor">{event.actor}</span>
          <span className="history-operation">{event.operationLabel}</span>
          {event.edits && <details className="history-edit"><summary>AI 선택 문단 수정 · 승인됨</summary>{event.edits.map(e=><div key={e.blockId}><p>모델: {e.model} · 문단: {e.blockId} · 기준 변경: {e.baseRevision}</p><ParagraphComparison before={e.beforeText} after={e.afterText}/></div>)}</details>}
          {event.edit && <details className="history-edit">
            <summary>AI 문단 수정 · 승인됨</summary>
            <p>모델: {event.edit.model}<br/>문서: {event.edit.documentId}<br/>블록: {event.edit.blockId}<br/>기준 변경: {event.edit.baseRevision}</p>
            <ParagraphComparison before={event.edit.beforeText} after={event.edit.afterText}/>
          </details>}
          <small>변경 {event.revision} · <time dateTime={event.at}>{event.localTime}</time></small>
        </li>)}
      </ol>}
    </aside></Overlay>}
  </div>;
}

export default function App() {
  const [initial, setInitial] = useState(null), [status, setStatus] = useState('불러오는 중…');
  const [revision, setRevision] = useState(0), [documents, setDocuments] = useState([]);
  const [showList, setShowList] = useState(false), [showArchived, setShowArchived] = useState(false);
  const [switching, setSwitching] = useState(false), [legacy, setLegacy] = useState(false);
  const [restoreOpen,setRestoreOpen]=useState(false),[noticeOpen,setNoticeOpen]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[mobileAI,setMobileAI]=useState(false);
  const [aiHidden,setAiHidden]=useState(false),[documentExpanded,setDocumentExpanded]=useState(false);
  const showAiPanel=()=>{setAiHidden(false);setDocumentExpanded(false);setMobileAI(true);};
  const hideAiPanel=()=>{setAiHidden(true);setMobileAI(false);setArchivedPostit(null);};
  const [postitOpen,setPostitOpen]=useState(false),[postits,setPostits]=useState([]),[reaskContext,setReaskContext]=useState(null);
  const [archivedPostit, setArchivedPostit] = useState(null);
  const [docOrder,setDocOrder]=useState([]),[orderMode,setOrderMode]=useState(false);
  const orderKey=useRef(''),docDrag=useRef(null);
  const postitDirtyGuard=useRef(()=>true),postitClose=useRef(()=>true);
  function reorderDocument(id,target){const ids=orderedDocuments(documents,docOrder).map(d=>d.id),next=moveId(ids,id,target);setDocOrder(next);if(!writePreference(orderKey.current,next))setStatus('문서 순서는 이 화면에서만 유지돼요. 브라우저 설정 저장이 차단됐습니다.');}

  const guard = useRef(() => true), navigation = useRef(false), selected = useRef(null);
  const list = async () => {
    const result = await request('/api/documents'); setDocuments(result.documents); return result;
  };
  const loadPostits = async () => {
    try {
      const result = await request('/api/postits');
      if (Array.isArray(result.postits)) setPostits(result.postits);
    } catch { /* non-fatal */ }
  };
  const ensureDraftPostit = async (payload) => {
    const {existingPostitId,...draft}=payload;
    const res = existingPostitId?await request('/api/postits/'+encodeURIComponent(existingPostitId)):await request('/api/postits', asJson(draft));
    if(res.postit?.id)setPostits(previous=>[res.postit,...previous.filter(note=>note.id!==res.postit.id)]);
    void loadPostits();
    return res.postit;
  };
  const archivePostit = async (postitId) => {
    const res = await request('/api/postits/' + encodeURIComponent(postitId) + '/archive', asJson({}));
    await loadPostits();
    return res.postit;
  };
  const savePostitEdit = async (postitId, payload) => {
    const res = await request('/api/postits/' + encodeURIComponent(postitId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await loadPostits();
    return res.postit;
  };
  const exportPostits = async () => {
    const bundle=await request('/api/postits/export');
    const url=URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='blocknote-postits.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const restorePostits = async bundle => {
    const result=await request('/api/postits/restore',asJson({bundle}));await loadPostits();return result;
  };
  const handleReaskPostit = (ctx) => {
    if (SITE) {
      const note = postits.find(note => note.id === ctx.reaskedFromId && note.archived);
      if (!note) return;
      setArchivedPostit({ ...ctx, requestId: note.requestId });
      setPostitOpen(false);
      showAiPanel();
      return;
    }
    setReaskContext(ctx);
    setPostitOpen(false);
    setMobileAI(true);
    setStatus('보관된 포스트잇 내용을 AI 재검토 참고 문맥으로 지정했어요.');
  };

  useEffect(() => {
    let live = true;
    request('/api/documents').catch(async e => {
      if(e.status!==404)throw e;
      const d=await request('/api/document');
      if(live)setLegacy(true);
      return {documents:[{id:d.id,title:'기존 단일 문서',archived:false}],defaultDocumentId:d.id,legacyDocument:d};
    }).then(async result => {
      const id = result.documents.find(d => !d.archived)?.id || result.defaultDocumentId;
      const doc = result.legacyDocument || await request('/api/documents/'+encodeURIComponent(id)+'/document');
      if (!live) return;
      orderKey.current='blocknote.p2.document-order:'+result.defaultDocumentId;
      setDocOrder(readPreference(orderKey.current,[]));
      setDocuments(result.documents); selected.current = id;
      setInitial(doc); setRevision(doc.revision); setStatus('저장됨');
      void loadPostits();
    }).catch(err => { if(live) setStatus(`서버 연결 실패: ${err.message}`); });
    return () => { live = false; };
  }, []);
  async function navigate(action) {
    if(navigation.current) return;
    if(!guard.current() || !postitDirtyGuard.current()) {
      setStatus('문서 전환 대기: 입력 조합·미저장 변경(문서 또는 포스트잇)·저장 오류 또는 AI 작업을 먼저 해결하세요.');
      return;
    }
    navigation.current = true; setSwitching(true);
    try { await action(); }
    catch(e) { setStatus(`작업 실패: ${e.message}. 현재 문서를 유지했어요.`); }
    finally { navigation.current = false; setSwitching(false); }
  }
  async function select(id) {
    if(id === selected.current) return;
    const doc = await request('/api/documents/'+encodeURIComponent(id)+'/document');
    if(!guard.current()) throw Error('조회 중 편집이 발생해 전환을 중지했습니다.');
    selected.current = id; setInitial(doc); setRevision(doc.revision); setReaskContext(null); setArchivedPostit(null); setStatus('저장됨'); setShowList(false);
  }
  const current = documents.find(d => d.id === initial?.id);
  const archivedPostitCount = postits.filter(p => p.archived).length;
  async function create() {
    const title = window.prompt('새 문서 제목', '제목 없는 문서'); if(title === null) return;
    await navigate(async () => {
      const created = await request('/api/documents', asJson({title})); await list(); await select(created.id);
    });
  }
  async function change(entry, patch) {
    await navigate(async () => {
      await request('/api/documents/'+encodeURIComponent(entry.id), { ...asJson({...patch,metadataVersion:entry.metadataVersion}), method:'PATCH' });
      await list(); setStatus('문서 정보 저장됨');
    });
  }
  async function exportDocument() {
    await navigate(async () => {
      const bundle = await request('/api/documents/'+encodeURIComponent(initial.id)+'/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle,null,2)],{type:'application/json'}));
      const a = document.createElement('a'); a.href=url; a.download='blocknote-'+initial.id+'.json'; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000); setStatus('문서 백업 다운로드 요청됨 · 다운로드 완료를 확인하세요.');
    });
  }
  async function restoreDocument(payload){
    if(navigation.current||!guard.current())throw Error('입력과 저장 또는 AI 작업을 먼저 마쳐 주세요.');
    navigation.current=true;setSwitching(true);
    try{
      const restored=await request('/api/documents/restore',asJson(payload));
      await list();await select(restored.id);setRestoreOpen(false);setStatus('백업을 새 문서로 복원했어요.');
    }finally{navigation.current=false;setSwitching(false);}
  }
  const workspaceHeader=<header className="topbar phase2-topbar">
    <div><h1>{current?.title || '내 작업실'}</h1><p>{current?.title || '내 작업실'} · <span>{status}</span></p></div>
    <span className="version">변경 {revision || '—'}</span>
    <button type="button" className="history-open" onClick={()=>setHistoryOpen(true)} aria-label="변경 이력" title="변경 이력">◷</button>
    <button type="button" className="document-expand" aria-label={documentExpanded?'크게 보기 종료':'문서 크게 보기'} title={documentExpanded?'크게 보기 종료':'문서 크게 보기'} aria-pressed={documentExpanded} onClick={()=>{setDocumentExpanded(x=>!x);setMobileAI(false);}}>⛶</button>
    {(aiHidden||documentExpanded)&&<button type="button" className="ai-reopen" onClick={showAiPanel}>AI 열기</button>}
  </header>;
  return <main className="layout phase2-layout">
    <aside className="phase2-announcement" aria-label="업데이트 안내">
      <strong>BlockNote Lab</strong><button type="button" onClick={()=>setNoticeOpen(true)} aria-label="공지 자세히 보기">Phase 2 · 문단 선택 · AI 의견 포스트잇 보관함 · 다중 문단 부분 승인</button>
    </aside>
    <div className="phase2-frame">
    <nav className="workspace-toolbar" aria-label="내 작업실 도구">
      <button disabled={legacy} onClick={()=>{if(postitOpen&&!postitClose.current())return;setShowList(!showList);void list().catch(e=>setStatus(e.message));}} aria-expanded={showList} aria-label="내 작업실" title="문서 불러오기">▤</button>
      <button onClick={()=>void create()} disabled={switching || legacy} aria-label="새 문서" title="새 문서">＋</button>
      <button type="button" id="b05PostitRail" className={postitOpen?'active':''} aria-expanded={postitOpen} aria-controls="b05PostitDrawer" aria-label="포스트잇 보관함" title="포스트잇 보관함" onClick={()=>{if(postitOpen){postitClose.current();return;}setShowList(false);setPostitOpen(true);void loadPostits();}}>
        🗒{archivedPostitCount > 0 && <span id="b05PostitCount" className="b05-note-badge">{archivedPostitCount}</span>}
      </button>
      {initial && !legacy && <button onClick={()=>void exportDocument()} disabled={switching} aria-label="문서 백업" title="문서 백업">⇩</button>}
      {initial&&!legacy&&<button disabled={switching||restoreOpen} aria-label="복원하기" title="복원하기" onClick={()=>{
        if(!guard.current()){setStatus('입력과 저장 또는 AI 작업을 먼저 마쳐 주세요.');return;}setRestoreOpen(true);
      }}>↶</button>}
      <button type="button" className="rail-history" onClick={()=>setHistoryOpen(true)} aria-label="변경 이력" title="변경 이력">◴</button>
    </nav>
    <div className="phase2-main">
    {legacy && <p>기존 단일 문서 모드 · 다중 문서는 별도 시험 작업실을 만든 뒤 시작하세요.</p>}
    {showList && <section className="document-list" aria-label="내 작업실">
      <div className="document-list-heading"><h2>내 작업실</h2><button type="button" onClick={()=>setShowList(false)} aria-label="문서 목록 닫기">×</button></div>
      <button type="button" onClick={()=>setOrderMode(!orderMode)} aria-pressed={orderMode}>↕ 문서 순서</button><p className="doc-order-note">순서는 이 브라우저에 저장됩니다.</p>
      <label><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> 보관 문서 보기</label>
      {orderedDocuments(documents,docOrder).filter(d=>showArchived || !d.archived).map((d,i,visible)=><div className="document-row" key={d.id} data-document-id={d.id}>
        {orderMode&&<div className="doc-order-controls"><button type="button" aria-label={`${d.title} 드래그 이동`} className="doc-grip"
          onPointerDown={e=>{docDrag.current=d.id;e.currentTarget.setPointerCapture(e.pointerId);e.preventDefault();}}
          onPointerMove={e=>{if(!docDrag.current)return;const row=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-document-id]');if(row&&row.dataset.documentId!==docDrag.current)reorderDocument(docDrag.current,row.dataset.documentId);}}
          onPointerUp={()=>{docDrag.current=null;}} onPointerCancel={()=>{docDrag.current=null;}}>⠿</button>
          <button type="button" aria-label={`${d.title} 위로`} disabled={i===0} onClick={()=>reorderDocument(d.id,visible[i-1].id)}>↑</button>
          <button type="button" aria-label={`${d.title} 아래로`} disabled={i===visible.length-1} onClick={()=>reorderDocument(d.id,visible[i+1].id)}>↓</button></div>}
        <button className="document-select" aria-current={d.id===initial?.id?'page':undefined} disabled={switching}
          onClick={()=>void navigate(()=>select(d.id))}>{d.title} <small>변경 {d.id===initial?.id?revision:d.revision} {d.archived?'· 보관됨':''}</small></button>
        <button disabled={switching} onClick={()=>{const title=window.prompt('문서 제목 변경',d.title);if(title!==null)void change(d,{title});}}>제목 변경</button>
        <button disabled={switching} onClick={()=>void change(d,{archived:!d.archived})}>{d.archived?'복원':'보관'}</button>
      </div>)}
    </section>}
    <PostitDrawer
      open={postitOpen}
      postits={postits}
      onClose={() => setPostitOpen(false)}
      onArchive={archivePostit}
      onSaveEdit={savePostitEdit}
      onReask={handleReaskPostit} onExport={exportPostits} onRestore={restorePostits}
      dirtyGuardRef={postitDirtyGuard} closeDrawerRef={postitClose}
      onStatus={setStatus}
    />
    <div className="status sr-only" role="status" aria-live="polite"><span className="dot" /> <span>{status}</span></div>
    {initial && current?.archived && <p role="status">보관된 문서입니다. 편집하려면 작업실에서 복원하세요.</p>}
    {initial ? <div className={'editor-mount'+(switching?' document-switching':'')}>
      <Editor key={initial.id} initial={initial} documentTitle={current?.title || '내 작업실 문서'}
        guard={guard} legacy={legacy} workspaceHeader={workspaceHeader} historyOpen={historyOpen} closeHistory={()=>setHistoryOpen(false)}
        mobileAI={mobileAI} showAI={showAiPanel} hideAI={hideAiPanel} aiHidden={aiHidden} documentExpanded={documentExpanded}
        postits={postits} onEnsureDraftPostit={ensureDraftPostit} onArchivePostit={archivePostit}
        reaskContext={reaskContext} onClearReask={() => setReaskContext(null)}
        archivedPostit={archivedPostit} onCloseArchivedPostit={() => setArchivedPostit(null)}
        onAskArchivedPostit={() => { setReaskContext(archivedPostit); setArchivedPostit(null); }}
        switching={switching || restoreOpen || Boolean(current?.archived)}
        onStatus={value=>{if(selected.current===initial.id)setStatus(value);}}
        onRevision={value=>{if(selected.current===initial.id)setRevision(value);}} />
    </div> : <section className="editor-card">작업실 서버 연결을 확인해 주세요.</section>}
    </div></div>
    <button type="button" className={'mobile-panel-toggle'+(mobileAI?' active':'')} onClick={()=>mobileAI?hideAiPanel():showAiPanel()}>{mobileAI?'문서로 돌아가기':'AI 도우미'}</button>
    {noticeOpen&&<Overlay title="Phase 2 · B-06 안내" onClose={()=>setNoticeOpen(false)}><p>문서를 직접 작성하고 AI와 의견을 나누는 작업실입니다. AI 답변은 포스트잇으로 자동 임시보존되며, 사용자가 문서에 삽입하거나 수정안을 승인할 때만 본문 리비전에 반영됩니다.</p><p>보관한 포스트잇은 제목·내용을 자유롭게 수정한 뒤 ‘변경 저장’으로 확정하고 다시 AI에게 질문할 수 있습니다.</p></Overlay>}
    {restoreOpen&&<RestorePanel onClose={()=>setRestoreOpen(false)} onRestore={restoreDocument}/>}
  </main>;
}

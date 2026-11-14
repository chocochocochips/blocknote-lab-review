import React, { useEffect, useState } from 'react';
import {
  formatPostitTimeDetails,
  hasUnsavedPostitEdit,
  buildPostitReaskContext,
} from '../../shared/postit-contract.mjs';

export default function PostitDrawer({
  open,
  postits = [],
  onClose,
  onArchive,
  onSaveEdit,
  onReask,
  onExport,
  onRestore,
  dirtyGuardRef,
  closeDrawerRef,
  onStatus,
}) {
  const [tab, setTab] = useState('archive'); // 'archive' | 'draft'
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [backupStatus, setBackupStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const editingNote = postits.find(n => n.id === editingId) || null;
  const isDirty = hasUnsavedPostitEdit(editingNote, draftTitle, draftContent);

  const confirmLeaveIfDirty = () => {
    if (!isDirty) return true;
    return window.confirm('저장하지 않은 포스트잇 수정 내용이 있습니다. 저장하지 않고 나갈까요?');
  };

  if (dirtyGuardRef) {
    dirtyGuardRef.current = () => !isDirty;
  }

  useEffect(() => {
    const onBeforeUnload = event => {
      if (isDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (confirmLeaveIfDirty()) {
          setEditingId(null);
          onClose();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, isDirty]);

  const openNote = note => {
    if (!note) return;
    if (!confirmLeaveIfDirty()) return;
    setEditingId(note.id);
    setDraftTitle(note.title);
    setDraftContent(note.content);
    setEditStatus(
      note.archived
        ? '보관된 포스트잇 · 변경 사항 없음'
        : '임시 답변 원문은 수정할 수 없어요. 보관하면 편집할 수 있습니다.',
    );
  };

  const handleCloseDrawer = () => {
    if (!confirmLeaveIfDirty()) return false;
    setEditingId(null);
    onClose();
    return true;
  };
  if(closeDrawerRef)closeDrawerRef.current=handleCloseDrawer;

  const handleSwitchTab = nextTab => {
    if (!confirmLeaveIfDirty()) return;
    setTab(nextTab);
    setEditingId(null);
  };

  const handleBackToList = () => {
    if (!confirmLeaveIfDirty()) return;
    setEditingId(null);
  };

  const handleArchiveNote = async note => {
    if (!note || saving) return;
    setSaving(true);
    try {
      const updated = await onArchive(note.id);
      if (editingId === note.id && updated) {
        setDraftTitle(updated.title);
        setDraftContent(updated.content);
        setEditStatus('보관 완료 · 이제 내용을 수정하고 변경 저장할 수 있어요');
      }
      onStatus?.('포스트잇을 보관함에 저장했어요 · 본문 리비전은 변경되지 않습니다.');
    } catch (err) {
      setEditStatus(`보관 실패: ${err.message}`);
      onStatus?.(`포스트잇 보관 실패: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingNote || !editingNote.archived || !isDirty || saving) return;
    setSaving(true);
    try {
      const updated = await onSaveEdit(editingNote.id, {
        title: draftTitle.trim() || '제목 없는 포스트잇',
        content: draftContent,
        itemRevision: editingNote.itemRevision,
      });
      if (updated) {
        setDraftTitle(updated.title);
        setDraftContent(updated.content);
      }
      setEditStatus('수정 내용 저장됨 · 본문 리비전에는 영향 없음');
      onStatus?.('수정한 포스트잇을 저장했어요.');
    } catch (err) {
      // Keep local draftTitle and draftContent intact on screen!
      setEditStatus(`저장 실패 · 수정 내용은 화면에 남아 있어요 (${err.message})`);
      onStatus?.(`포스트잇 저장 실패: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReaskNote = note => {
    if (!note) return;
    try {
      const ctx = buildPostitReaskContext(note, {
        draftTitle: editingId === note.id ? draftTitle : note.title,
        draftContent: editingId === note.id ? draftContent : note.content,
      });
      setEditingId(null);
      onReask(ctx);
    } catch (err) {
      setEditStatus(err.message);
      onStatus?.(err.message);
    }
  };

  if (!open) return null;

  const archivedNotes = postits.filter(n => n.archived);
  const draftNotes = postits.filter(n => !n.archived);
  const visibleNotes = tab === 'archive' ? archivedNotes : draftNotes;

  return (
    <aside id="b05PostitDrawer" className="b05-note-drawer" aria-label="포스트잇 보관함">
      <div className="b05-drawer-header">
        <div>
          <span className="b05-eyebrow">별도 보관 공간</span>
          <h2>포스트잇 보관함</h2>
        </div>
        <button
          type="button"
          className="b05-note-close"
          id="b05CloseDrawer"
          aria-label="보관함 닫기"
          onClick={handleCloseDrawer}
        >
          ×
        </button>
      </div>
      <p className="b05-note-explainer">
        AI 답변 원문은 서버에 임시보존하고, 보관한 답변만 수정할 수 있어요. 포스트잇 백업은 문서 백업과 별도입니다.
      </p>
      <div className="b05-backup-actions">
        <button type="button" onClick={async()=>{try{await onExport();setBackupStatus('포스트잇 백업 다운로드를 확인하세요.');}catch{setBackupStatus('백업을 만들지 못했어요.');}}}>포스트잇 백업</button>
        <label>포스트잇 복원<input type="file" accept="application/json,.json" aria-label="포스트잇 백업 파일 선택" onChange={async event=>{
          const file=event.target.files?.[0];event.target.value='';if(!file)return;
          try{
            if(file.size>750000)throw Error('파일이 너무 커요. 750KB 이하 파일을 선택하세요.');
            const bundle=JSON.parse(await file.text());
            if(!bundle?.manifest||!Array.isArray(bundle.postits))throw Error('포스트잇 백업 파일을 확인하세요.');
            if(!window.confirm(`포스트잇 ${bundle.postits.length}개를 복원할까요? 기존 항목은 덮어쓰지 않습니다.`))return;
            const result=await onRestore(bundle);setBackupStatus(`${result.restoredCount}개 포스트잇 복원 완료`);
          }catch(error){setBackupStatus(`복원 실패: ${error.message}`);}
        }}/></label>
        {backupStatus&&<p role="status">{backupStatus}</p>}
      </div>
      <div className="b05-drawer-tabs" role="tablist" aria-label="포스트잇 상태 구분">
        <button
          type="button"
          id="b05ArchiveTab"
          role="tab"
          aria-selected={tab === 'archive'}
          className={tab === 'archive' ? 'active' : ''}
          onClick={() => handleSwitchTab('archive')}
        >
          보관한 답변 <span id="b05ArchiveCount">{archivedNotes.length}</span>
        </button>
        <button
          type="button"
          id="b05DraftTab"
          role="tab"
          aria-selected={tab === 'draft'}
          className={tab === 'draft' ? 'active' : ''}
          onClick={() => handleSwitchTab('draft')}
        >
          임시 저장 <span id="b05DraftCount">{draftNotes.length}</span>
        </button>
      </div>

      {!editingNote ? (
        <div id="b05NotesList" className="b05-notes-list" aria-live="polite">
          {visibleNotes.length === 0 ? (
            <div className="b05-notes-empty">
              {tab === 'archive'
                ? '보관한 포스트잇이 없어요. AI 답변에서 보관을 눌러보세요.'
                : '아직 임시 저장된 답변이 없어요. AI에게 질문하면 답변 원문이 자동 임시보존됩니다.'}
            </div>
          ) : (
            visibleNotes.map(note => {
              const timeBadges = formatPostitTimeDetails(note);
              return (
                <article key={note.id} className="b05-archive-card" data-postit-id={note.id}>
                  <div className="b05-note-meta">
                    <span>{note.documentTitle || '문서'}</span>
                    <span>{timeBadges[0]}</span>
                  </div>
                  <h3>{note.title}</h3>
                  <p>{note.content}</p>
                  <div className="b05-note-time-detail">
                    {timeBadges.map(label => (
                      <span key={label}>{label}</span>
                    ))}
                  </div>
                  <div className="b05-note-actions">
                    <button type="button" onClick={() => openNote(note)}>
                      {note.archived ? '열기 · 수정' : '원문 보기'}
                    </button>
                    <button
                      type="button"
                      className="b05-ask-again"
                      onClick={() => handleReaskNote(note)}
                    >
                      AI 재검토
                    </button>
                    {!note.archived && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleArchiveNote(note)}
                      >
                        보관
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>
      ) : (
        <section id="b05NoteEdit" className="b05-note-edit">
          <div className="b05-note-edit-head">
            <strong id="b05NoteEditHeading">
              {editingNote.archived ? '포스트잇 수정' : '임시 답변 원문'}
            </strong>
            <button type="button" id="b05NoteEditBack" onClick={handleBackToList}>
              ← 목록
            </button>
          </div>
          <div id="b05NoteEditTimes" className="b05-note-edit-times" aria-live="polite">
            {formatPostitTimeDetails(editingNote).map(label => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <label htmlFor="b05NoteTitle">제목</label>
          <input
            id="b05NoteTitle"
            type="text"
            maxLength={90}
            value={draftTitle}
            disabled={!editingNote.archived || saving}
            onChange={e => {
              setDraftTitle(e.target.value);
              setEditStatus(
                e.target.value !== editingNote.title || draftContent !== editingNote.content
                  ? '수정 내용이 저장되지 않았어요 · 변경 저장을 눌러 확정하세요'
                  : '보관된 포스트잇 · 변경 사항 없음',
              );
            }}
          />
          <label htmlFor="b05NoteText">내용 · 자유롭게 고치세요</label>
          <textarea
            id="b05NoteText"
            rows={9}
            value={draftContent}
            disabled={!editingNote.archived || saving}
            onChange={e => {
              setDraftContent(e.target.value);
              setEditStatus(
                draftTitle !== editingNote.title || e.target.value !== editingNote.content
                  ? '수정 내용이 저장되지 않았어요 · 변경 저장을 눌러 확정하세요'
                  : '보관된 포스트잇 · 변경 사항 없음',
              );
            }}
          />
          <div id="b05NoteEditStatus" role="status">
            {editStatus}
          </div>
          <div className="b05-note-edit-actions">
            {!editingNote.archived ? (
              <button
                type="button"
                className="b05-note-neutral"
                id="b05NoteEditArchive"
                disabled={saving}
                onClick={() => void handleArchiveNote(editingNote)}
              >
                보관하기
              </button>
            ) : (
              <button
                type="button"
                className="b05-note-black"
                id="b05NoteSave"
                disabled={!isDirty || saving}
                onClick={() => void handleSaveEdit()}
              >
                변경 저장
              </button>
            )}
            <button
              type="button"
              className="b05-note-neutral"
              id="b05NoteReAsk"
              disabled={saving}
              onClick={() => handleReaskNote(editingNote)}
            >
              AI 재검토
            </button>
          </div>
        </section>
      )}
      <p className="b05-note-footnote">
        임시 답변은 서버에 원문 그대로 보존되며, 보관한 포스트잇만 변경 저장할 수 있습니다. 포스트잇 보관·수정은 메인 문서 리비전에 영향을 주지 않습니다.
      </p>
    </aside>
  );
}

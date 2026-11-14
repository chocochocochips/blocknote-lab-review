import React, { useEffect, useRef, useState } from 'react';

export default function ArchivedPostitView({ note, onClose, onAsk, onInsert, checkInserted, canInsert }) {
  const heading = useRef(null);
  const [inserted, setInserted] = useState(false);
  const [inserting, setInserting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (!checkInserted) return;
    let active = true;
    checkInserted().then(result => {
      if (active && result) setInserted(true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(note.confirmedContent);
      setNotice('복사했어요.');
    } catch {
      setError('클립보드 권한을 확인해 주세요.');
    }
  }

  async function insert() {
    if (inserting || inserted) return;
    setInserting(true);
    setError('');
    try {
      await onInsert();
      setInserted(true);
      setNotice('문서에 삽입했어요.');
    } catch (error) {
      setError(error.message);
    } finally {
      setInserting(false);
    }
  }

  return <div className="phase2-ai-body archived-postit-view" role="region" aria-label="보관한 포스트잇 크게 보기"
    onKeyDown={event => { if (event.key === 'Escape' && !inserting) onClose(); }}>
    <div className="archived-postit-bar">
      {onAsk && <button type="button" className="ai-panel-secondary" disabled={inserting} onClick={onAsk}>AI 질문 열기</button>}
      <button type="button" className="ai-panel-secondary" disabled={inserting} onClick={onClose}>큰 포스트잇 닫기</button>
    </div>
    <article className="answer-card archived-postit-card" aria-labelledby="archivedPostitTitle">
      <h3 id="archivedPostitTitle" ref={heading} tabIndex={-1}>{note.title}</h3>
      <div className="archived-postit-content">{note.confirmedContent}</div>
      <div className="archived-postit-footer">
        <div className="ai-panel-actions">
          <button type="button" className="ai-panel-secondary" onClick={copy}>복사</button>
          <button type="button" className="ai-panel-secondary" disabled>보관됨</button>
          <button type="button" className="ai-panel-primary" disabled={!canInsert || inserting || inserted} onClick={insert}>
            {inserted ? '삽입 완료' : inserting ? '삽입 중…' : '문서에 삽입'}
          </button>
        </div>
        {!onInsert && <p className="archived-postit-feedback">원래 문서를 열면 삽입할 수 있어요.</p>}
        {error && <p className="archived-postit-feedback" role="alert">{error}</p>}
        {notice && <p className="archived-postit-feedback" role="status">{notice}</p>}
      </div>
    </article>
  </div>;
}

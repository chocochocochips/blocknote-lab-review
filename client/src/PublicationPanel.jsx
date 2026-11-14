import React, { useState } from 'react';
import Overlay from './Overlay.jsx';

export default function PublicationPanel({ canPublish, getRevision, preview, publish, onClose }) {
  const [snapshot, setSnapshot] = useState(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');

  const revisionMatches = revision => canPublish() && revision === getRevision();
  async function loadPreview() {
    setMessage('');
    setSnapshot(null);
    setApproved(false);
    if (!canPublish()) {
      setMessage('현재 문서의 저장을 확인한 뒤 미리보기를 열어 주세요.');
      return;
    }
    setBusy(true);
    try {
      const next = await preview();
      if (!revisionMatches(next.revision)) {
        setMessage('편집기에 표시된 변경 번호와 서버 문서가 달라요. 문서를 동기화해 주세요.');
        return;
      }
      setSnapshot(next);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!approved || !snapshot || busy) return;
    if (!revisionMatches(snapshot.revision)) {
      setMessage('문서가 변경됐어요. 미리보기를 다시 열어 주세요.');
      setApproved(false);
      return;
    }
    setBusy(true);
    setMessage('');
    setApproved(false);
    try { setResult(await publish(snapshot)); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(label + '을 복사했어요.');
    } catch { setMessage('텍스트를 선택해서 복사해 주세요.'); }
  }

  return <Overlay title="문서 공개 발행" onClose={()=>{ if (!busy) onClose(); }}>
    {result?.testMode ? <>
      <p>발행 테스트를 마쳤어요. 공개 저장소 연결은 사이트에 GitHub 토큰을 설정하면 사용할 수 있어요.</p>
      <textarea className="publication-text" aria-label="테스트 Markdown" readOnly rows={12} value={snapshot.markdown} />
      <button type="button" onClick={()=>void copy(snapshot.markdown, 'Markdown')}>Markdown 복사</button>
    </> : result ? <>
      <p>{result.unchanged ? '공개 문서가 이미 이 내용과 같아요.' : '공개 문서를 발행했어요.'} · 변경 {result.revision}</p>
      <input className="publication-text" aria-label="공개 URL" value={result.publicUrl} readOnly onFocus={event=>event.target.select()} />
      <div className="publication-actions">
        <button type="button" onClick={()=>void copy(result.publicUrl, '공개 URL')}>공개 URL 복사</button>
        <a href={result.publicUrl} target="_blank" rel="noreferrer">공개 문서 열기</a>
      </div>
    </> : <>
      <p>저장된 제목과 본문을 Markdown으로 확인하세요. 실제 공개 발행 후에는 로그인 없이 읽을 수 있고, 이전 내용은 GitHub 변경 기록에 남을 수 있어요.</p>
      <button type="button" onClick={()=>void loadPreview()} disabled={busy}>{snapshot ? '미리보기 다시 열기' : 'Markdown 미리보기'}</button>
      {snapshot && <>
        {snapshot.testMode && <p>테스트 모드예요. 승인하면 발행 흐름을 확인할 수 있고, 내용은 이 화면에서만 표시돼요.</p>}
        <p>{snapshot.title} · 변경 {snapshot.revision}</p>
        <textarea className="publication-text" aria-label="공개할 Markdown" readOnly rows={12} value={snapshot.markdown} />
        <div className="publication-actions">
          <label><input type="checkbox" checked={approved} disabled={busy} onChange={event=>setApproved(event.target.checked)} /> {snapshot.testMode ? '이 Markdown으로 발행을 테스트합니다.' : '이 Markdown을 공개하는 데 동의합니다.'}</label>
          <button type="button" disabled={!approved || busy} onClick={()=>void confirm()}>{snapshot.testMode ? '발행 테스트 승인' : '공개 발행 승인'}</button>
        </div>
      </>}
    </>}
    {busy && <p role="status">요청을 처리하고 있어요.</p>}
    {message && <p role="status">{message}</p>}
  </Overlay>;
}

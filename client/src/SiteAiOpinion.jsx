import React, { useEffect, useRef, useState } from 'react';

import { googleTimeoutMs, hydrogenModel, hydrogenTimeoutMs } from '../../shared/site-google-models.mjs';
import { exaoneTimeoutMs, exaoneWarningMs } from '../../shared/site-exaone.mjs';

const names = { vercel: 'Vercel AI Gateway', google: 'Google AI Studio', cloudflare: 'Cloudflare Workers AI', exaone: 'EXAONE' };
const historyKey = 'blocknote-site-ai-last-results-v1';

function readHistory() {
  try { return JSON.parse(localStorage.getItem(historyKey)) || {}; }
  catch { return {}; }
}

function resultLabel(result) {
  if (!result || !['success', 'failure'].includes(result.status)) return '⚪ 호출 기록 없음';
  const time = new Date(result.time);
  const displayTime = Number.isNaN(time.getTime()) ? '' : ' · ' + time.toLocaleString('ko-KR');
  const http = result.httpStatus ? ' · ' + (result.source || '사이트') + ' HTTP ' + result.httpStatus : '';
  return (result.status === 'success' ? '🟢 성공' : '🔴 실패') + displayTime + http;
}

async function request(path, body, stream) {
  const timeout = body === undefined ? 12_000
    : stream ? exaoneTimeoutMs : body.provider !== 'google' ? 55_000
      : body.model === hydrogenModel ? hydrogenTimeoutMs + googleTimeoutMs + 15_000 : 90_000;
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(path, {
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(stream && { Accept: 'application/x-ndjson' }) }, body: JSON.stringify(body),
    }),
    cache: 'no-store', signal: stream ? AbortSignal.any([deadline, stream.signal]) : deadline,
  });
  if (stream && response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')) {
    return readOpinionStream(response, stream.onDelta);
  }
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || 'AI 요청에 실패했어요.');
    error.httpStatus = response.status;
    error.fallback = result.fallback;
    throw error;
  }
  return result;
}

async function readOpinionStream(response, onDelta) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (buffer + value).split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'delta') onDelta(event.text);
        if (event.type === 'result') return event.result;
        if (event.type === 'error') {
          const error = Error(event.message || 'AI 요청에 실패했어요.');
          error.httpStatus = event.status;
          throw error;
        }
      }
    }
    throw Error('EXAONE 답변이 끝나기 전에 연결이 끊겼어요.');
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export default function SiteAiOpinion({
  provider, documentId, questionScope, goal, setGoal, getRevision, canAct,
  onEnsureDraftPostit, onArchivePostit, onBusy,
}) {
  const [catalog, setCatalog] = useState(null);
  const [model, setModel] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState(readHistory);
  const [elapsed, setElapsed] = useState(null);
  const [partial, setPartial] = useState('');
  const exaoneRequest = useRef(null);
  const pending = useRef(false);
  const selected = catalog?.provider === provider ? catalog : null;

  useEffect(() => () => exaoneRequest.current?.abort(), []);

  useEffect(() => {
    if (!provider) return;
    let current = true;
    setModel('');
    setError('');
    request('/api/site-ai/models?provider=' + encodeURIComponent(provider)).then(({ models }) => {
      if (current) setCatalog({ provider, models });
    }).catch(error => {
      if (current) setCatalog({ provider, models: [], error: error.message });
    });
    return () => { current = false; };
  }, [provider]);

  async function perform(label, action) {
    if (pending.current) return;
    pending.current = true;
    onBusy(true);
    setBusy(label);
    setError('');
    try { await action(); }
    catch (error) {
      const interrupted = ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name);
      setError(interrupted ? '응답을 확인하지 못했어요. 다시 보내기 전에 포스트잇 보관함을 확인해 주세요.' : error.message);
    } finally {
      pending.current = false;
      onBusy(false);
      setBusy('');
    }
  }

  async function loadSaved(next) {
    setResult(next);
    if (next.postit) await onEnsureDraftPostit({ existingPostitId: next.postit.id });
  }

  function send() {
    if (!canAct() || !selected?.models.some(entry => entry.id === model) || !goal.trim()) return;
    return perform('AI 응답 대기 중…', async () => {
      const controller = provider === 'exaone' ? new AbortController() : null;
      const started = Date.now();
      let timer;
      if (controller) {
        exaoneRequest.current = controller;
        setElapsed(0);
        setPartial('');
        timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1_000);
      }
      let next;
      try {
        next = await request('/api/documents/' + encodeURIComponent(documentId) + '/site-ai', {
          provider, model, prompt: goal, baseRevision: getRevision(), requestId: 'site-ai:' + crypto.randomUUID(),
          targetIds: questionScope?.targetIds ?? [], reaskedFromId: questionScope?.reaskedFromId,
          reaskedItemRevision: questionScope?.reaskedItemRevision,
        }, controller && { signal: controller.signal, onDelta: text => setPartial(previous => previous + text) });
      } catch (error) {
        if (controller?.signal.aborted) {
          setError('EXAONE 요청을 중단했어요.');
          return;
        }
        updateHistory('failure', error.httpStatus, error.fallback);
        if (controller && error.name === 'TimeoutError') {
          setError('EXAONE 응답이 180초를 넘겼어요. 다시 보내기 전에 포스트잇 보관함을 확인해 주세요.');
          return;
        }
        throw error;
      } finally {
        if (controller) {
          clearInterval(timer);
          exaoneRequest.current = null;
          setElapsed(null);
          setPartial('');
        }
      }
      updateHistory('success', undefined, next.fallback);
      await loadSaved(next);
    });
  }

  function updateHistory(status, httpStatus, fallback) {
    const time = new Date().toISOString();
    const latest = {
      ...readHistory(),
      [provider + '/' + (fallback?.model ?? model)]: { status, time, ...(httpStatus && { httpStatus }) },
    };
    if (fallback) latest[provider + '/' + model] = { status: 'failure', time, httpStatus: fallback.httpStatus, source: 'Google' };
    try { localStorage.setItem(historyKey, JSON.stringify(latest)); } catch {}
    setHistory(latest);
  }

  const note = result?.postit;
  const draft = result?.draft;
  const currentAnswer = note || draft;
  return <div className="site-ai-opinion">
    <label className="ai-panel-label" htmlFor="site-ai-model">AI 모델</label>
    <select id="site-ai-model" value={selected?.models.some(entry => entry.id === model) ? model : ''}
      disabled={Boolean(busy) || !selected?.models.length} onChange={event => setModel(event.target.value)}>
      <option value="">모델 선택</option>
      {selected?.models.map(entry => <option key={entry.id} value={entry.id}>{resultLabel(history[provider + '/' + entry.id])} · {entry.name} · {entry.id}</option>)}
    </select>
    <small>표시는 이 기기에서 확인한 마지막 호출 결과예요.</small>
    {!selected && <p role="status">모델 목록을 불러오는 중…</p>}
    {selected?.error && <p role="alert">{selected.error}</p>}
    {selected && !selected.error && !selected.models.length && <p>사용 가능한 텍스트 모델이 없어요.</p>}
    <label className="ai-panel-label" htmlFor="site-ai-goal">AI에게 질문하기</label>
    <textarea id="site-ai-goal" value={goal} maxLength={240} rows={3} disabled={Boolean(busy)}
      onChange={event => setGoal(event.target.value)}/>
    <p className="ai-panel-hint">질문과 위 참고 범위를 {names[provider]}에 전송합니다.</p>
    <button type="button" className="ai-panel-primary" onClick={send}
      disabled={Boolean(busy) || !model || !selected?.models.some(entry => entry.id === model) || !goal.trim() || !canAct()}>질문 보내기</button>
    {busy && elapsed === null && <p role="status">{busy}</p>}
    {elapsed !== null && <>
      <p role="status">{partial ? 'EXAONE 답변을 받는 중이에요.' : 'EXAONE 응답을 기다리고 있어요.'}</p>
      <p>경과 {elapsed}초</p>
      {elapsed * 1000 >= exaoneWarningMs && <p role="status">응답이 평소보다 늦어지고 있어요. 최대 180초까지 기다려요.</p>}
      <button type="button" className="ai-panel-secondary" onClick={() => exaoneRequest.current?.abort()}>중단</button>
      {partial && <p className="ai-panel-proposal">{partial}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    {result?.fallback && !error && !busy && <p role="status">Hydrogen 호출이 제한되어 Gemini 3.6 Flash로 답변했어요.</p>}
    {currentAnswer && elapsed === null && <div className="ai-panel-preview answer-card b05-postit-card">
      <div className="ai-panel-preview-title">{note?.title || 'AI 검토 의견'}<small>{currentAnswer.model}</small></div>
      <p className="ai-panel-proposal">{note?.content ?? draft.rawContent}</p>
      <div className="ai-panel-actions reply-actions">
        {note ? <button type="button" className="ai-panel-secondary" disabled={Boolean(busy) || note.archived}
          onClick={() => perform('보관 중…', async () => setResult({ postit: await onArchivePostit(note.id) }))}>
          {note.archived ? '보관됨' : '보관'}
        </button> : <button type="button" className="ai-panel-secondary" disabled={Boolean(busy)}
          onClick={() => perform('임시 저장 중…', async () => loadSaved({ postit: await onEnsureDraftPostit(draft) }))}>임시 저장 다시 시도</button>}
        <button type="button" className="ai-panel-secondary" disabled={Boolean(busy)}
          onClick={() => perform('복사 중…', () => navigator.clipboard.writeText(note?.content ?? draft.rawContent))}>복사</button>
      </div>
      <small>{note?.archived ? '포스트잇 보관함에서 다시 열 수 있어요.' : note ? '임시 저장됨' : '임시 저장 실패 · 답변을 다시 호출하지 않고 저장할 수 있어요.'}</small>
    </div>}
  </div>;
}

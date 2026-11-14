/** D-03 prepared regression cases. DO NOT RUN until F-01. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoryResponse } from '../client/src/historyViewModel.mjs';

const item = { at: '2026-10-31T01:00:00.000Z', actor: 'human-editor', revision: 2,
  operation: 'document.save', transactionId: 'tx-2' };

test('D03 empty successful history is a valid empty list', () => {
  assert.deepEqual(normalizeHistoryResponse({ events: [] }), []);
});
test('D03 actor, revision, operation, local time are preserved and labeled', () => {
  const [entry] = normalizeHistoryResponse({ events: [item] });
  assert.equal(entry.actor, 'human-editor');
  assert.equal(entry.revision, 2);
  assert.equal(entry.operationLabel, '문서 저장');
  assert.equal(entry.at, item.at);
  assert.ok(entry.localTime.length > 5);
  assert.equal(entry.transactionId, 'tx-2');
});
test('D03 known recovery operation has a human-readable label', () => {
  const [entry] = normalizeHistoryResponse({ events: [{ ...item, operation: 'recovery.restore' }] });
  assert.equal(entry.operationLabel, '백업 복원');
});
test('D03 unknown operation is displayed without inventing a meaning', () => {
  const [entry] = normalizeHistoryResponse({ events: [{ ...item, operation: 'future.op' }] });
  assert.equal(entry.operationLabel, 'future.op');
});
test('D03 invalid history response is not interpreted as empty', () => {
  assert.throws(() => normalizeHistoryResponse({}), /형식/);
  assert.throws(() => normalizeHistoryResponse({ events: null }), /형식/);
});
test('D03 invalid actor/revision/time are rejected', () => {
  for (const event of [{ ...item, actor: '' }, { ...item, revision: '2' },
    { ...item, at: 'not-a-date' }, { ...item, operation: '' }]) {
    assert.throws(() => normalizeHistoryResponse({ events: [event] }), /항목/);
  }
});
test('D03 display uses caller-provided actor without falsely authenticating it', () => {
  const [entry] = normalizeHistoryResponse({ events: [{ ...item, actor: '  demo-agent  ' }] });
  assert.equal(entry.actor, 'demo-agent');
});
test('D03 view model does not reorder newest-first API events', () => {
  const entries = normalizeHistoryResponse({ events: [item, { ...item, revision: 1 }] });
  assert.deepEqual(entries.map(e => e.revision), [2, 1]);
});
test('D03 oldest-first responses still display the newest revisions first without mutating input', () => {
  const events = [{ ...item, revision: 1 }, { ...item, revision: 3 }, item];
  assert.deepEqual(normalizeHistoryResponse({ events }).map(e => e.revision), [3, 2, 1]);
  assert.deepEqual(events.map(e => e.revision), [1, 3, 2]);
});

// D-02 regression scenarios. Intentionally NOT executed until F-01.
import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteDecision } from '../client/src/syncPolicy.mjs';

const base = { remoteRevision: 4, localRevision: 3, composing: false, saving: false,
  editChanged: false, dirty: false, focused: false, discardConfirmed: false };

test('clean, unfocused document accepts a newer revision', () => {
  assert.equal(remoteDecision(base), 'apply');
});
test('dirty document cannot be silently replaced', () => {
  assert.equal(remoteDecision({ ...base, dirty: true }), 'conflict');
});
test('dirty document at same revision remains local', () => {
  assert.equal(remoteDecision({ ...base, remoteRevision: 3, dirty: true }), 'keep-local');
});
test('explicit discard permits replacing dirty document at same revision', () => {
  assert.equal(remoteDecision({ ...base, remoteRevision: 3, dirty: true, discardConfirmed: true }), 'apply');
});
test('new local edits during GET cancel replacement even after discard', () => {
  assert.equal(remoteDecision({ ...base, dirty: true, discardConfirmed: true, editChanged: true }), 'abort');
});
test('IME composition always cancels replacement', () => {
  assert.equal(remoteDecision({ ...base, discardConfirmed: true, composing: true }), 'abort');
});
test('in-flight save always cancels replacement', () => {
  assert.equal(remoteDecision({ ...base, saving: true }), 'abort');
});
test('focused clean editor defers replacement', () => {
  assert.equal(remoteDecision({ ...base, focused: true }), 'defer-focus');
});
test('stale GET never replaces newer local revision', () => {
  assert.equal(remoteDecision({ ...base, remoteRevision: 2 }), 'stale');
});

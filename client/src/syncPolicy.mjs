/** D-02: pure guard for applying a remote document. No DOM or network dependencies. */
export function remoteDecision({
  remoteRevision, localRevision, composing, saving, editChanged,
  dirty, focused, discardConfirmed = false,
}) {
  if (composing || saving || editChanged) return 'abort';
  if (remoteRevision < localRevision) return 'stale';
  if (dirty && !discardConfirmed) return remoteRevision > localRevision ? 'conflict' : 'keep-local';
  if (remoteRevision === localRevision && !discardConfirmed) return 'same';
  if (focused && !discardConfirmed) return 'defer-focus';
  return 'apply';
}

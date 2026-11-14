import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import { initializeWorkspace, openWorkspace } from '../server/workspace.mjs';
import { RequestError } from '../server/validation.mjs';

const maxSnapshotBytes = 12 * 1024 * 1024;
const filePattern = /^(?:workspace\.json|postits\.json|documents\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:document\.json(?:\.bak|\.txn\.json)?|history\.jsonl))$/;

function filesUnder(root, directory = '') {
  return Object.fromEntries(readdirSync(join(root, directory), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = directory + entry.name;
      if (entry.isDirectory()) return Object.entries(filesUnder(root, path + '/'));
      if (!entry.isFile() || !filePattern.test(path)) throw new Error('Unexpected workspace file');
      return [[path, readFileSync(join(root, path), 'utf8')]];
    }));
}

function restoreFiles(root, files) {
  if (!files || typeof files !== 'object' || !Object.hasOwn(files, 'workspace.json')) {
    throw new Error('Invalid workspace snapshot');
  }
  for (const [path, contents] of Object.entries(files)) {
    if (!filePattern.test(path) || typeof contents !== 'string') throw new Error('Invalid workspace file');
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents, 'utf8');
  }
}

// Each request uses a disposable filesystem for the original document engine.
// Conditional object writes publish document, history, and post-it changes together.
export async function withWorkspace(bucket, userId, operate, { readOnly = false } = {}) {
  if (!bucket) throw new Error('Missing workspace storage');
  const key = 'workspaces/' + createHash('sha256').update(userId).digest('hex') + '.json';
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await bucket.get(key);
    if (previous && previous.size > maxSnapshotBytes) throw new Error('Workspace snapshot exceeds limit');
    const saved = previous ? await previous.json() : null;
    if (previous && saved?.format !== 1) throw new Error('Unsupported workspace snapshot');
    const scratch = mkdtempSync('/tmp/blocknote-site-');
    const root = join(scratch, 'workspace');
    try {
      if (saved) restoreFiles(root, saved.files);
      else initializeWorkspace({ destination: root });
      const state = { panel: saved?.panel ?? { connected: true, ai: null }, aiClaims: saved?.aiClaims ?? [] };
      const response = await operate({ root, workspace: openWorkspace(root), state });
      if (readOnly || response.status >= 500) return response;
      const files = filesUnder(root);
      if (saved && JSON.stringify(files) === JSON.stringify(saved.files) &&
          JSON.stringify(state.panel) === JSON.stringify(saved.panel) &&
          JSON.stringify(state.aiClaims) === JSON.stringify(saved.aiClaims ?? [])) return response;
      const next = JSON.stringify({ format: 1, snapshotId: randomUUID(), files, panel: state.panel, ...(state.aiClaims.length && { aiClaims: state.aiClaims }) });
      if (Buffer.byteLength(next) > maxSnapshotBytes) {
        throw new RequestError(507, 'SITE_STORAGE_LIMIT', '시험실 저장 한도에 도달했어요. 필요한 문서를 내보내 주세요.');
      }
      const condition = previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' };
      if (await bucket.put(key, next, { onlyIf: condition })) return response;
    } finally {
      rmSync(scratch, { recursive: true });
    }
  }
  throw new RequestError(409, 'SITE_WRITE_CONFLICT', '다른 작업과 저장이 겹쳤어요. 다시 확인해 주세요.');
}

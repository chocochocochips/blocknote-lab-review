import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './document-app.mjs';
export { createApp, createDocumentHandler } from './document-app.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const server = process.env.LAB_WORKSPACE_DIR
    ? (await import('./workspace.mjs')).createWorkspaceApp({ root: process.env.LAB_WORKSPACE_DIR })
    : createApp({
    documentFile: process.env.DOC_PATH || resolve(ROOT, 'data/document.json'),
    historyFile: process.env.HISTORY_PATH || resolve(ROOT, 'data/history.jsonl'),
  });
  server.listen(port, host, () => console.log(`BlockNote Lab API: http://${host}:${port}`));
}

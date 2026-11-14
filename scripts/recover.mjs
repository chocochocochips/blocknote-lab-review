/** Offline operator recovery; do NOT run while the API server is running. */
import { resolve } from 'node:path';
import { createStorage } from '../server/storage.mjs';

const [mode, documentFile, historyFile] = process.argv.slice(2);
if (!['--status', '--recover', '--restore-backup', '--cleanup-temp'].includes(mode) || !documentFile || !historyFile) {
  console.error('Usage: node scripts/recover.mjs <--status|--recover|--restore-backup|--cleanup-temp> <document.json> <history.jsonl>');
  process.exitCode = 2;
} else {
  try {
    // Existing document required; never seed a missing document in recovery mode.
    const { existsSync } = await import('node:fs');
    if (!existsSync(documentFile)) throw new Error('document file missing; recovery cannot initialize a new document');
    const store = createStorage({ documentFile: resolve(documentFile), historyFile: resolve(historyFile), initialDocument: null });
    if (mode === '--status') {
      console.log(JSON.stringify({ revision: store.readDocument().revision, auditEvents: store.readHistory().length, paths: store.paths }, null, 2));
    } else if (mode === '--recover') {
      console.log(JSON.stringify(store.recover(), null, 2));
    } else if (mode === '--cleanup-temp') {
      console.log(JSON.stringify({ removed: store.cleanupStaleTemps() }, null, 2));
    } else {
      console.log(JSON.stringify(store.restoreBackup(), null, 2));
    }
  } catch (error) {
    console.error(error.code || 'RECOVERY_FAILED', error.message);
    process.exitCode = 1;
  }
}

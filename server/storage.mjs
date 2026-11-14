/**
 * B-03: single-process, crash-recoverable document+audit write-ahead journal.
 * This is NOT a multi-process lock or an atomic multi-file filesystem transaction.
 * All paths must be on a local filesystem supporting same-directory atomic rename.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  openSync, closeSync, fsyncSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, validateBlocks, validateStoredDocumentSize, validateProposalMetadata } from './validation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2);
const storageError = (code, message, extra = {}) => new RequestError(503, code, message, extra);

function syncDirectory(path) {
  // Not all platforms permit directory fsync. Power-loss durability is not guaranteed
  // where it is unsupported; same-directory rename remains the atomicity primitive.
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch { /* portability fallback */ }
  finally { if (fd !== undefined) closeSync(fd); }
}

function atomicText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function parseDocument(path) {
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw storageError('STORAGE_CORRUPT', '문서 JSON을 읽을 수 없습니다. 서버를 중지하고 백업 복구를 검토하세요.'); }
  if (!doc || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || !Array.isArray(doc.blocks)) {
    throw storageError('STORAGE_CORRUPT', '저장된 문서 구조가 유효하지 않습니다.');
  }
  return doc;
}

function parseHistory(path) {
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, 'utf8');
    return content.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line));
  } catch {
    throw storageError('AUDIT_CORRUPT', '감사 로그가 손상되었습니다. 자동으로 삭제하거나 덮어쓰지 않습니다.');
  }
}

function validateJournal(tx) {
  if (!tx || tx.schema !== 1 || !['write', 'restore'].includes(tx.kind) ||
      typeof tx.transactionId !== 'string' || typeof tx.baseHash !== 'string' ||
      typeof tx.afterHash !== 'string' || !tx.afterDoc ||
      hash(encode(tx.afterDoc)) !== tx.afterHash ||
      tx.auditEvent?.transactionId !== tx.transactionId ||
      tx.auditEvent?.revision !== tx.afterDoc.revision) {
    throw storageError('JOURNAL_CORRUPT', '트랜잭션 저널이 손상되었습니다. 수동 확인이 필요합니다.');
  }
  const receipt = tx.auditEvent.idempotency;
  if (receipt && (typeof receipt.requestId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.requestId) ||
      !/^[0-9a-f]{64}$/.test(receipt.fingerprint) ||
      ![200, 201].includes(receipt.status) || !receipt.body ||
      receipt.body.revision !== tx.afterDoc.revision)) {
    throw storageError('JOURNAL_CORRUPT', '저널의 requestId 영수증이 손상되었습니다.');
  }
  if (tx.auditEvent.proposal !== undefined) {
    try {
      const validated = validateProposalMetadata(tx.auditEvent.proposal);
      if (!validated || Object.keys(tx.auditEvent.proposal).length !== (validated.edit || validated.edits ? 5 : 4)) throw new Error('Invalid proposal');
    } catch { throw storageError('JOURNAL_CORRUPT', '저널의 제안/승인 메타데이터가 손상되었습니다.'); }
  }
  try { validateBlocks(tx.afterDoc.blocks); validateStoredDocumentSize(tx.afterDoc); }
  catch { throw storageError('JOURNAL_CORRUPT', '저널에 기록된 문서의 유효성 검증에 실패했습니다.'); }
}

/** faults is an optional test-only function(stage, transactionId). */
export function createStorage({ documentFile, historyFile, initialDocument, faults = () => {}, strict = false }) {
  documentFile = resolve(documentFile);
  historyFile = resolve(historyFile);
  if (documentFile === historyFile) throw new Error('Document and audit paths must differ');
  const journalFile = `${documentFile}.txn.json`;
  const backupFile = `${documentFile}.bak`;
  if ([journalFile, backupFile].includes(historyFile)) throw new Error('Audit path overlaps storage metadata');
  function checkFiles() {
    if (strict && (!existsSync(documentFile) || !existsSync(historyFile)))
      throw storageError('STORAGE_MISSING', '문서 또는 이력 파일이 없습니다. 자동 초기화하지 않습니다.');
  }
  checkFiles();
  if (!strict) {
    mkdirSync(dirname(documentFile), { recursive: true });
    if (!existsSync(documentFile)) atomicText(documentFile, encode(initialDocument));
  }
  if (strict) {
    const doc = parseDocument(documentFile);
    if (typeof doc.id !== 'string' || !doc.id) throw storageError('STORAGE_CORRUPT', '문서 ID가 없습니다.');
    validateBlocks(doc.blocks); validateStoredDocumentSize(doc); parseHistory(historyFile);
  }

  function recover() {
    checkFiles();
    if (strict) {
      const doc = parseDocument(documentFile);
      validateBlocks(doc.blocks); validateStoredDocumentSize(doc);
      const events = parseHistory(historyFile);
      if (events.some(e => !e || typeof e !== 'object' || !Number.isSafeInteger(e.revision) || e.revision < 1 ||
        typeof e.operation !== 'string' || typeof e.actor !== 'string'))
        throw storageError('AUDIT_CORRUPT', '이력 구조가 손상되었습니다. 자동 변경하지 않습니다.');
    }
    if (!existsSync(journalFile)) return { recovered: false };
    let tx;
    try { tx = JSON.parse(readFileSync(journalFile, 'utf8')); }
    catch { throw storageError('JOURNAL_CORRUPT', '트랜잭션 저널 JSON이 손상되었습니다.'); }
    validateJournal(tx);
    try {
      const currentHash = hash(readFileSync(documentFile, 'utf8'));
      if (currentHash !== tx.baseHash && currentHash !== tx.afterHash) {
        throw storageError('RECOVERY_CONFLICT', '저널과 문서 상태가 불일치합니다. 다른 프로세스가 수정했을 수 있습니다.', { transactionId: tx.transactionId });
      }
      if (currentHash !== tx.afterHash) {
        faults('beforeDocument', tx.transactionId);
        atomicText(documentFile, encode(tx.afterDoc));
        faults('afterDocument', tx.transactionId);
      }
      const events = parseHistory(historyFile);
      const matching = events.filter(event => event.transactionId === tx.transactionId);
      if (matching.length > 1 || (matching.length === 1 && JSON.stringify(matching[0]) !== JSON.stringify(tx.auditEvent))) {
        throw storageError('AUDIT_CONFLICT', '트랜잭션 감사 이벤트가 중복되거나 다릅니다.', { transactionId: tx.transactionId });
      }
      if (matching.length === 0) {
        faults('beforeAudit', tx.transactionId);
        atomicText(historyFile, [...events, tx.auditEvent].map(event => JSON.stringify(event)).join('\n') + '\n');
        faults('afterAudit', tx.transactionId);
      }
      faults('beforeFinalize', tx.transactionId);
      unlinkSync(journalFile);
      syncDirectory(dirname(journalFile));
      return { recovered: true, transactionId: tx.transactionId };
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw storageError('RECOVERY_REQUIRED', '트랜잭션 완료 여부가 확정되지 않았습니다. 재시도 전에 복구 후 문서 버전을 조회하세요.', { transactionId: tx.transactionId });
    }
  }

  function readDocument() { recover(); return parseDocument(documentFile); }
  function readHistory() { recover(); return parseHistory(historyFile); }
  function findRequest(requestId) {
    recover(); // a 503 may have committed; never declare 'not found' before recovery
    const events = parseHistory(historyFile).filter(event => event.idempotency?.requestId === requestId);
    if (events.length > 1) throw storageError('REQUEST_RECEIPT_CONFLICT', 'requestId가 감사 로그에 중복되어 수동 확인이 필요합니다.');
    if (events.length === 0) return null;
    const event = events[0];
    const record = event.idempotency;
    if (!record || !/^[0-9a-f]{64}$/.test(record.fingerprint) ||
        ![200, 201].includes(record.status) || !record.body ||
        record.body.revision !== event.revision) {
      throw storageError('REQUEST_RECEIPT_CORRUPT', 'requestId 결과 기록이 손상되어 수동 확인이 필요합니다.');
    }
    return { ...record, transactionId: event.transactionId, revision: event.revision };
  }

  function writeDocument(previousDoc, nextDoc, actor, operation, blockId = null, receipt = null, proposal = null) {
    recover();
    const current = parseDocument(documentFile);
    if (!Number.isSafeInteger(previousDoc.revision + 1)) {
      throw storageError('REVISION_OVERFLOW', 'revision 증가 범위를 초과했습니다.');
    }
    if (hash(encode(current)) !== hash(encode(previousDoc))) {
      throw storageError('RECOVERY_CONFLICT', '저장 직전 문서가 예상 상태와 다릅니다.');
    }
    const transactionId = randomUUID();
    if (receipt && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.requestId) ||
        !/^[0-9a-f]{64}$/.test(receipt.fingerprint) ||
        ![200, 201].includes(receipt.status) || !receipt.body ||
        receipt.body.revision !== nextDoc.revision)) {
      throw new Error('Invalid C-02 idempotency receipt');
    }
    if (proposal) {
      // Validate before writing the journal; no partial audit metadata may be committed.
      validateProposalMetadata(proposal);
    }
    const tx = {
      schema: 1, kind: 'write', transactionId,
      baseHash: hash(readFileSync(documentFile, 'utf8')),
      afterHash: hash(encode(nextDoc)), afterDoc: nextDoc,
      auditEvent: { at: new Date().toISOString(), actor, operation, revision: nextDoc.revision, blockId, transactionId, ...(receipt ? { idempotency: receipt } : {}), ...(proposal ? { proposal } : {}) },
    };
    try {
      // Backup is the last complete document BEFORE this commit, not a live mirror.
      atomicText(backupFile, encode(previousDoc));
      faults('beforeJournal', transactionId);
      atomicText(journalFile, encode(tx));
    } catch (error) {
      if (!existsSync(journalFile)) {
        throw new RequestError(500, 'STORAGE_PREPARE_FAILED', '저장 준비에 실패하여 문서를 변경하지 않았습니다.');
      }
      // Journal exists: the transaction may be committed by recovery.
    }
    try { recover(); }
    catch (error) {
      throw storageError('RECOVERY_REQUIRED', '저장 결과가 미확정입니다. 요청을 무조건 재전송하지 말고 복구 후 revision을 조회하세요.', { transactionId, causeCode: error.code || 'STORAGE_ERROR' });
    }
    return nextDoc;
  }

  function restoreBackup() {
    // Offline-only, operator-invoked. A pending journal must be resolved first.
    recover();
    if (!existsSync(backupFile)) throw storageError('BACKUP_NOT_FOUND', '복구할 백업이 없습니다.');
    let backup;
    try { backup = JSON.parse(readFileSync(backupFile, 'utf8')); }
    catch { throw storageError('BACKUP_CORRUPT', '백업 JSON이 손상되었습니다.'); }
    if (!backup || !Number.isSafeInteger(backup.revision) || !Array.isArray(backup.blocks)) {
      throw storageError('BACKUP_CORRUPT', '백업 문서 구조가 유효하지 않습니다.');
    }
    try { validateBlocks(backup.blocks); validateStoredDocumentSize(backup); }
    catch { throw storageError('BACKUP_CORRUPT', '백업 문서의 블록 구조 또는 크기가 유효하지 않습니다.'); }
    const events = parseHistory(historyFile);
    const latest = Math.max(backup.revision, ...events.map(e => Number.isSafeInteger(e.revision) ? e.revision : 0));
    if (!Number.isSafeInteger(latest + 1)) throw storageError('REVISION_OVERFLOW', 'revision 증가 범위를 초과했습니다.');
    const restored = { ...backup, revision: latest + 1, updatedAt: new Date().toISOString() };
    const original = readFileSync(documentFile, 'utf8');
    const transactionId = randomUUID();
    const tx = {
      schema: 1, kind: 'restore', transactionId, baseHash: hash(original),
      afterHash: hash(encode(restored)), afterDoc: restored,
      auditEvent: { at: new Date().toISOString(), actor: 'system', operation: 'recovery.restore', revision: restored.revision, blockId: null, transactionId },
    };
    const archive = `${documentFile}.pre-restore.${transactionId}`;
    copyFileSync(documentFile, archive);
    atomicText(journalFile, encode(tx));
    try { recover(); }
    catch (error) {
      throw storageError('RECOVERY_REQUIRED', '백업 복원 완료 여부가 미확정입니다. 저널을 보존했습니다.', { transactionId, causeCode: error.code || 'STORAGE_ERROR' });
    }
    return { revision: restored.revision, archive, transactionId };
  }

  function cleanupStaleTemps(olderThanMs = 3600000) {
    const targets = [documentFile, historyFile, journalFile, backupFile];
    let removed = 0;
    for (const target of targets) {
      if (!existsSync(dirname(target))) continue;
      const prefix = `${basename(target)}.`;
      for (const name of readdirSync(dirname(target))) {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
        const path = join(dirname(target), name);
        if (Date.now() - statSync(path).mtimeMs < olderThanMs) continue;
        unlinkSync(path); removed++;
      }
    }
    return removed;
  }

  return { readDocument, readHistory, findRequest, writeDocument, recover, restoreBackup, cleanupStaleTemps,
    paths: { documentFile, historyFile, journalFile, backupFile } };
}

/** F05-02: explicit workspace, ID-addressed stores, no automatic migration. */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, lstatSync, openSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createStorage } from './storage.mjs';
import { createDocumentHandler } from './document-app.mjs';
import { createPostitStore, handlePostitHttp } from './postits.mjs';
import { readJsonBody, RequestError, validateBlocks, validateStoredDocumentSize } from './validation.mjs';
import {inspectBackup} from './restore.mjs';

const error = (status, code, message) => { throw new RequestError(status, code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== '.' && id !== '..';
function titleOf(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) error(400, 'INVALID_TITLE', '제목은 1~120자로 입력하세요.');
  return title.trim();
}
function atomicJson(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
function writeNew(path, text) { writeFileSync(path, text, { flag: 'wx', mode: 0o600 }); }
function writeRestoreFile(path,text){
  const fd=openSync(path,'wx',0o600);
  try{writeFileSync(fd,text,'utf8');fsyncSync(fd);}finally{closeSync(fd);}
}
function realFile(path, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) error(503, 'UNSAFE_STORE', '저장소 파일 형식을 확인하세요.');
}
function readJson(path) {
  try { realFile(path); return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e instanceof RequestError) throw e; error(503, 'WORKSPACE_CORRUPT', '작업실 파일이 없거나 손상되었습니다. 자동 초기화하지 않습니다.'); }
}
export function openWorkspace(root, {restoreFaults=()=>{}}={}) {
  root = resolve(root);
  realFile(root, true); realFile(join(root, 'documents'), true);
  const registryFile = join(root, 'workspace.json');
  let registry = readJson(registryFile);
  if (registry.formatVersion !== 1 || !Array.isArray(registry.documents) || !registry.documents.length ||
      !registry.documents.some(d => d.id === registry.defaultDocumentId)) error(503, 'WORKSPACE_CORRUPT', '작업실 목록 구조가 유효하지 않습니다.');
  const postitStore = createPostitStore({ filePath: join(root, 'postits.json'), documentExists:id=>registry.documents.some(entry=>entry.id===id) });
  const entries = new Map();
  function open(entry) {
    if (!safeId(entry.id) || entries.has(entry.id) || typeof entry.archived !== 'boolean' ||
        !Number.isSafeInteger(entry.metadataVersion) || entry.metadataVersion < 1 ||
        !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.modifiedAt))) error(503, 'WORKSPACE_CORRUPT', '문서 목록 항목이 유효하지 않습니다.');
    titleOf(entry.title);
    const dir = join(root, 'documents', entry.id);
    realFile(dir, true);
    for (const name of readdirSync(dir)) realFile(join(dir, name));
    const options = {
      documentFile: join(dir, 'document.json'),
      historyFile: join(dir, 'history.jsonl'),
      postitStore,
      getDocumentTitle: () => registry.documents.find(e => e.id === entry.id)?.title || entry.title,
      strict: true,
      requireDocumentId: true,
      canWrite: () => !registry.documents.find(e => e.id === entry.id)?.archived,
    };
    const storage = createStorage(options);
    const doc = storage.readDocument();
    if (doc.id !== entry.id) error(503, 'DOCUMENT_ID_MISMATCH', '목록과 문서의 ID가 다릅니다.');
    entries.set(entry.id, { storage, handler: createDocumentHandler(options) });
  }
  for (const entry of registry.documents) open(entry);
  const get = id => {
    if (!safeId(id) || !entries.has(id)) error(404, 'DOCUMENT_NOT_FOUND', '문서를 찾을 수 없습니다.');
    const result = entries.get(id);
    if (result.storage.readDocument().id !== id) error(503, 'DOCUMENT_ID_MISMATCH', '저장 문서의 ID가 변경되었습니다.');
    return result;
  };
  const describe = entry => {
    const doc = get(entry.id).storage.readDocument();
    return { ...entry, revision: doc.revision, updatedAt: doc.updatedAt };
  };
  function saveRegistry(next) { atomicJson(registryFile, next); registry = next; }
  const duplicateOf=checked=>registry.documents.find(e=>e.restoration&&(
    e.restoration.backupIdentity===checked.backupIdentity||e.restoration.digest===checked.digest));
  return {
    defaultId: registry.defaultDocumentId,
    postits: postitStore,
    list: () => registry.documents.map(describe),
    get,
    metadata: id => describe(registry.documents.find(e => e.id === id) || (get(id), {})),
    previewRestore(bundle){
      const checked=inspectBackup(bundle),duplicate=duplicateOf(checked);
      return {...checked.preview,duplicate:duplicate?{id:duplicate.id,title:duplicate.title,archived:duplicate.archived}:null};
    },
    restore({bundle,digest,confirmed,requestId,title}) {
      const checked=inspectBackup(bundle);
      if(confirmed!==true||digest!==checked.digest)error(409,'RESTORE_CONFIRM_REQUIRED','미리보기를 확인한 뒤 복원을 승인해 주세요.');
      if(typeof requestId!=='string'||!/^restore:[0-9a-f-]{36}$/.test(requestId))error(400,'INVALID_RESTORE_REQUEST','복원 요청을 다시 확인해 주세요.');
      const restoredTitle=titleOf(title??(checked.title.slice(0,110)+' (복원)'));
      const previous=registry.documents.find(e=>e.restoration?.requestId===requestId);
      if(previous){if(previous.restoration.digest!==digest||previous.title!==restoredTitle)error(409,'RESTORE_REQUEST_CONFLICT','이미 사용된 복원 요청입니다.');return describe(previous);}
      if(duplicateOf(checked))error(409,'DUPLICATE_BACKUP','이미 가져온 백업이에요. 기존 복원 문서를 확인해 주세요. 새 문서는 만들지 않았어요.');
      if(registry.documents.length>=24)error(409,'RESTORE_DOCUMENT_LIMIT','문서가 많아 복원을 중단했어요. 기존 문서는 유지돼요.');
      const id=randomUUID(),now=new Date().toISOString();
      const entry={id,title:restoredTitle,createdAt:now,modifiedAt:now,archived:false,metadataVersion:1,
        restoration:{sourceDocumentId:checked.doc.id,sourceRevision:checked.doc.revision,kind:checked.kind,digest,backupIdentity:checked.backupIdentity,identityVersion:1,requestId,historyCount:checked.events.length}};
      const stage=join(root,'documents','.restore-'+id+'.tmp'),dir=join(root,'documents',id);
      // Remap identity references, never arbitrary text. Blocks keep document-scoped IDs.
      const doc={...checked.doc,id};
      const events=structuredClone(checked.events);
      for(const e of events){for(const edit of e.proposal?.edits||(e.proposal?.edit?[e.proposal.edit]:[]))edit.documentId=id;}
      let published=false,renamed=false;
      try{
        mkdirSync(stage);
        writeRestoreFile(join(stage,'document.json'),JSON.stringify(doc,null,2));restoreFaults('document');
        writeRestoreFile(join(stage,'history.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+(events.length?'\n':''));restoreFaults('history');
        createStorage({documentFile:join(stage,'document.json'),historyFile:join(stage,'history.jsonl'),strict:true}).readHistory();
        restoreFaults('validated');
        if(existsSync(dir)||entries.has(id))error(409,'RESTORE_ID_COLLISION','문서 식별자가 겹쳐 복원을 중단했어요. 다시 파일을 선택해 주세요.');
        renameSync(stage,dir);renamed=true;restoreFaults('renamed');
        open(entry);restoreFaults('beforeRegistry');
        saveRegistry({...registry,documents:[...registry.documents,entry]});published=true;
        restoreFaults('published');return describe(entry);
      }catch(e){
        if(!published){entries.delete(id);rmSync(renamed?dir:stage,{recursive:true,force:true});}
        error(503,published?'RESTORE_RESULT_UNCERTAIN':'RESTORE_FAILED',published?'복원 응답을 확인하지 못했어요. 문서 목록을 먼저 확인하세요.':'복원하지 못했어요. 기존 문서는 그대로 유지했어요.');
      }
    },
    create(title) {
      title = titleOf(title);
      const id = randomUUID(), now = new Date().toISOString();
      const entry = { id, title, createdAt: now, modifiedAt: now, archived: false, metadataVersion: 1 };
      const dir = join(root, 'documents', id);
      mkdirSync(dir); // unique ID; never reuse an existing directory
      writeNew(join(dir, 'document.json'), JSON.stringify({ id, revision: 1, updatedAt: now, blocks: [
        { id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text: '', styles: {} }], children: [] },
      ] }, null, 2));
      writeNew(join(dir, 'history.jsonl'), '');
      open(entry);
      saveRegistry({ ...registry, documents: [...registry.documents, entry] });
      return describe(entry);
    },
    update(id, body) {
      get(id);
      const previous = registry.documents.find(e => e.id === id);
      if (body.metadataVersion !== previous.metadataVersion) error(409, 'METADATA_CONFLICT', '문서 목록이 변경되었습니다. 다시 확인하세요.');
      if (body.archived !== undefined && typeof body.archived !== 'boolean') error(400, 'INVALID_ARCHIVE', '보관 상태가 유효하지 않습니다.');
      const next = { ...previous, ...(body.title === undefined ? {} : { title: titleOf(body.title) }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
        modifiedAt: new Date().toISOString(), metadataVersion: previous.metadataVersion + 1 };
      saveRegistry({ ...registry, documents: registry.documents.map(e => e.id === id ? next : e) });
      return describe(next);
    },
    export(id) {
      const store = get(id).storage;
      const doc = store.readDocument(); store.readHistory();
      const document = readFileSync(store.paths.documentFile, 'utf8');
      const history = readFileSync(store.paths.historyFile, 'utf8');
      const m = this.metadata(id);
      return { manifest: { format: 'blocknote-project', formatVersion: 1, documentId: id, revision: doc.revision,
        title: m.title, createdAt: m.createdAt, updatedAt: doc.updatedAt, modifiedAt: m.modifiedAt, archived: m.archived,
        files: { 'document.json': hash(document), 'history.jsonl': hash(history) } },
        files: { 'document.json': document, 'history.jsonl': history } };
    },
  };
}
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
export function createWorkspaceApp(options) { return createServer(createWorkspaceHandler(options)); }
export function createWorkspaceHandler({root,workspace=openWorkspace(root),hosted=false}) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/postits' || url.pathname.startsWith('/api/postits/')) {
        const docId = url.searchParams.get('documentId') || undefined;
        let defaultDocumentTitle = '내 작업실 문서';
        if (docId) {
          try { defaultDocumentTitle = workspace.metadata(docId).title; } catch { /* ignore */ }
        }
        return await handlePostitHttp(req, res, { store: workspace.postits, defaultDocumentTitle, hosted });
      }
      if(req.method==='POST'&&url.pathname==='/api/documents/restore/preview')return json(res,200,workspace.previewRestore((await readJsonBody(req)).bundle));
      if(req.method==='POST'&&url.pathname==='/api/documents/restore')return json(res,201,workspace.restore(await readJsonBody(req)));
      if (url.pathname === '/api/documents') {
        if (req.method === 'GET') return json(res, 200, { documents: workspace.list(), defaultDocumentId: workspace.defaultId });
        if (req.method === 'POST') return json(res, 201, workspace.create((await readJsonBody(req)).title));
      }
      const match = url.pathname.match(/^\/api\/documents\/([^/]+)(\/.*)?$/);
      if (match) {
        const id = decodeURIComponent(match[1]), suffix = match[2] || '';
        const target = workspace.get(id);
        if (!suffix && req.method === 'PATCH') return json(res, 200, workspace.update(id, await readJsonBody(req)));
        if (!suffix && req.method === 'GET') return json(res, 200, workspace.metadata(id));
        if (suffix === '/export' && req.method === 'GET') return json(res, 200, workspace.export(id));
        if (workspace.metadata(id).archived && !['GET', 'HEAD'].includes(req.method) && !suffix.startsWith('/postits')) {
          error(409, 'DOCUMENT_ARCHIVED', '보관된 문서를 먼저 복원하세요.');
        }
        req.url = '/api' + suffix + url.search;
        if (hosted && /^\/postits(?:\/|$)/.test(suffix)) {
          return await handlePostitHttp(req, res, {store:workspace.postits, defaultDocumentId:id, defaultDocumentTitle:workspace.metadata(id).title, hosted});
        }
        return await target.handler(req, res);
      }
      // Stable legacy alias addresses only the original/default document. Scoped
      // writes still require its ID, so a selected document cannot leak into it.
      if (/^\/api\/(document|history|blocks|requests|postits)(\/|$)/.test(url.pathname)) {
        if (workspace.metadata(workspace.defaultId).archived && req.method !== 'GET' && !url.pathname.startsWith('/api/postits')) {
          error(409, 'DOCUMENT_ARCHIVED', '보관된 문서를 먼저 복원하세요.');
        }
        return await workspace.get(workspace.defaultId).handler(req, res);
      }
      json(res, 404, { error: '경로를 찾을 수 없습니다.' });
    } catch (e) { json(res, e.status || 503, { error: e.status ? e.message : '저장소를 확인하세요. 자동 복구하지 않았습니다.', code: e.code || 'WORKSPACE_ERROR' }); }
  };
}

/** Offline export verifier: verifies actual bytes and identity before any restore.
 * Public restore/import API deliberately deferred. */
export function verifyExport(bundle) {
  const m = bundle?.manifest, files = bundle?.files;
  if (m?.format !== 'blocknote-project' || m.formatVersion !== 1 || !safeId(m.documentId) ||
      !files || Object.keys(files).sort().join() !== 'document.json,history.jsonl') throw Error('Invalid export manifest');
  titleOf(m.title);
  if(typeof m.archived !== 'boolean' || ['createdAt','updatedAt','modifiedAt'].some(k => !Number.isFinite(Date.parse(m[k])))) throw Error('Invalid export metadata');
  for (const name of ['document.json', 'history.jsonl']) {
    if (typeof files[name] !== 'string' || hash(files[name]) !== m.files?.[name]) throw Error('Export checksum mismatch');
  }
  const doc = JSON.parse(files['document.json']);
  if (doc.id !== m.documentId || doc.revision !== m.revision || !Number.isSafeInteger(doc.revision) || doc.revision < 1 || doc.updatedAt !== m.updatedAt) throw Error('Export identity mismatch');
  validateBlocks(doc.blocks); validateStoredDocumentSize(doc);
  const events = files['history.jsonl'].split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  if(events.some(e => !e || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.revision > doc.revision || typeof e.actor !== 'string' || typeof e.operation !== 'string')) throw Error('Invalid export history');
  return { doc, events };
}

/** Explicit offline initialization; destination must not exist. Source is only
 * read, byte copied into source-backup and the new ID-addressed store. */
export function initializeWorkspace({ destination, source, title = '첫 문서' }) {
  destination = resolve(destination); title = titleOf(title);
  if (existsSync(destination)) throw Error('Destination already exists; refusing overwrite');
  let document, history, backup;
  if (source) {
    source = resolve(source);
    if (existsSync(join(source, 'document.json.txn.json'))) throw Error('Resolve source journal before copying');
    realFile(join(source, 'document.json')); realFile(join(source, 'history.jsonl'));
    document = readFileSync(join(source, 'document.json'), 'utf8');
    history = readFileSync(join(source, 'history.jsonl'), 'utf8');
    if (existsSync(join(source, 'document.json.bak'))) backup = readFileSync(join(source, 'document.json.bak'));
  } else {
    document = JSON.stringify({ id: randomUUID(), revision: 1, updatedAt: new Date().toISOString(), blocks: [
      { id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text: '', styles: {} }], children: [] },
    ] }, null, 2); history = '';
  }
  const doc = JSON.parse(document);
  if (!safeId(doc.id) || !Number.isSafeInteger(doc.revision) || doc.revision < 1) throw Error('Invalid source identity');
  validateBlocks(doc.blocks); validateStoredDocumentSize(doc);
  history.split('\n').filter(l => l.trim()).forEach(l => JSON.parse(l));
  const now = new Date().toISOString();
  mkdirSync(destination, { recursive: false });
  mkdirSync(join(destination, 'documents'));
  const dir = join(destination, 'documents', doc.id); mkdirSync(dir);
  if (source) {
    const b = join(destination, 'source-backup'); mkdirSync(b);
    writeNew(join(b, 'document.json'), document); writeNew(join(b, 'history.jsonl'), history);
    if (backup) writeNew(join(b, 'document.json.bak'), backup);
  }
  writeNew(join(dir, 'document.json'), document); writeNew(join(dir, 'history.jsonl'), history);
  writeNew(join(destination, 'workspace.json'), JSON.stringify({ formatVersion: 1, defaultDocumentId: doc.id,
    documents: [{ id: doc.id, title, createdAt: now, modifiedAt: now, archived: false, metadataVersion: 1 }] }, null, 2));
  const workspace = openWorkspace(destination);
  if (readFileSync(workspace.get(doc.id).storage.paths.documentFile, 'utf8') !== document ||
      readFileSync(workspace.get(doc.id).storage.paths.historyFile, 'utf8') !== history) throw Error('Copy verification failed');
  return workspace.list();
}

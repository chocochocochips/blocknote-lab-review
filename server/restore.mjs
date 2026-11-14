/** F07-01: bounded, fail-closed inspection. No filesystem writes. */
import {createHash} from 'node:crypto';
import {RequestError,validateBlocks,validateStoredDocumentSize,validateProposalMetadata} from './validation.mjs';
import {stableJson} from '../shared/block-edit.mjs';
import {isEditorFontSize} from '../shared/font-size.mjs';
export const BACKUP_BYTES=750_000;
const bad=()=>{throw new RequestError(422,'INVALID_BACKUP','파일이 손상되었거나 지원하지 않는 백업입니다. 기존 문서는 변경하지 않았어요.');};
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,list)=>record(v)&&Object.keys(v).every(k=>list.includes(k));
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const sha=s=>createHash('sha256').update(s).digest('hex');
function safeTree(v,depth=0){
 if(depth>40)bad();
 if(v&&typeof v==='object')for(const [k,x]of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(k))bad();safeTree(x,depth+1);}
}
function safeBlocks(blocks){
 validateBlocks(blocks);
 function inline(items){for(const x of items){
  if(x.type==='text'){
   if(!keys(x,['type','text','styles'])||!keys(x.styles,['bold','italic','underline','strike','code','textColor','backgroundColor','fontSize']))bad();
   for(const [k,v]of Object.entries(x.styles)){
    if(k==='fontSize'){if(!isEditorFontSize(v))bad();}
    else if(k.endsWith('Color')?!(typeof v==='string'&&/^[a-zA-Z0-9#(),.% -]{1,60}$/.test(v)):typeof v!=='boolean')bad();
   }
  }else if(x.type==='link'){
   if(!keys(x,['type','href','content'])||typeof x.href!=='string'||!Array.isArray(x.content))bad();
   let u;try{u=new URL(x.href);}catch{bad();}if(!['https:','http:','mailto:'].includes(u.protocol))bad();inline(x.content);
  }else bad();
 }}
 function walk(rows){for(const b of rows){
  if(!keys(b,['id','type','props','content','children'])||!keys(b.props,['backgroundColor','textColor','textAlignment','level','checked','language','start']))bad();
  for(const [k,v]of Object.entries(b.props)){
   if(['backgroundColor','textColor','language'].includes(k)&&!(typeof v==='string'&&/^[a-zA-Z0-9#(),.% _+-]{0,60}$/.test(v)))bad();
   if(k==='textAlignment'&&!['left','center','right','justify'].includes(v))bad();
   if(k==='checked'&&typeof v!=='boolean')bad();
   if(k==='start'&&(!Number.isSafeInteger(v)||v<1))bad();
  }
  if(b.type==='table'){
   if(!keys(b.content,['type','columnWidths','headerRows','headerCols','rows']))bad();
   for(const row of b.content.rows){
    if(!keys(row,['cells']))bad();
    for(const cell of row.cells){
     if(Array.isArray(cell)){inline(cell);continue;}
     if(!keys(cell,['type','content','props'])||!keys(cell.props,['colspan','rowspan','backgroundColor','textColor','textAlignment']))bad();
     for(const [k,v]of Object.entries(cell.props)){
      if(k.endsWith('Color')&&!(typeof v==='string'&&/^[a-zA-Z0-9#(),.% -]{1,60}$/.test(v)))bad();
      if(k==='textAlignment'&&!['left','center','right','justify'].includes(v))bad();
     }
     inline(cell.content);
    }
   }
  }else inline(b.content ?? []);
  walk(b.children);
 }}walk(blocks);
}
function historyRows(text,doc){
 const events=text.split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s));
 let previous=0;const transactions=new Set(),requests=new Set();
 for(const e of events){
  if(!keys(e,['at','actor','operation','revision','blockId','transactionId','idempotency','proposal'])||!date(e.at)||typeof e.actor!=='string'||!e.actor.trim()||e.actor.length>120||
   !['document.save','block.insert','block.update','block.delete','blocks.update','recovery.restore'].includes(e.operation)||!Number.isSafeInteger(e.revision)||e.revision<=previous||e.revision>doc.revision)bad();
  previous=e.revision;
  if(e.blockId!==undefined&&e.blockId!==null&&typeof e.blockId!=='string')bad();
  if(e.transactionId!==undefined){if(typeof e.transactionId!=='string'||!e.transactionId||transactions.has(e.transactionId))bad();transactions.add(e.transactionId);}
  if(e.idempotency!==undefined){const r=e.idempotency;
   if(!keys(r,['requestId','fingerprint','status','body'])||typeof r.requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.requestId)||requests.has(r.requestId)||!/^[0-9a-f]{64}$/.test(r.fingerprint)||![200,201].includes(r.status)||!record(r.body)||r.body.revision!==e.revision)bad();requests.add(r.requestId);
   if(r.body.block)safeBlocks([r.body.block]);
  }
  if(e.proposal!==undefined){
   if(!keys(e.proposal,['proposalId','goal','reason','approval','edit','edits'])||!validateProposalMetadata(e.proposal))bad();
   const edits=e.proposal.edits||(e.proposal.edit?[e.proposal.edit]:[]);
   // beforeHash covers the complete historical block (including props), not
   // beforeText alone. Its original full state is not present in this format.
   for(const x of edits)if(x.documentId!==doc.id||x.baseRevision+1!==e.revision)bad();
   if(e.proposal.edit&&(e.blockId!==e.proposal.edit.blockId||e.operation!=='block.update'))bad();
   if(e.proposal.edits&&e.operation!=='blocks.update')bad();
  }
 }
 if(events.length&&events.at(-1).revision!==doc.revision)bad();
 return events;
}
export function inspectBackup(bundle){
 try{
  const encoded=JSON.stringify(bundle);if(!encoded||Buffer.byteLength(encoded)>BACKUP_BYTES)bad();safeTree(bundle);
  let doc,events=[],title,kind,verified=false,warnings=[];
  if(bundle?.manifest){
   const m=bundle.manifest,f=bundle.files;
   if(!keys(bundle,['manifest','files'])||!keys(m,['format','formatVersion','documentId','revision','title','createdAt','updatedAt','modifiedAt','archived','files'])||m.format!=='blocknote-project'||m.formatVersion!==1||!id(m.documentId)||
    !keys(f,['document.json','history.jsonl'])||Object.keys(f).length!==2||!keys(m.files,['document.json','history.jsonl'])||Object.keys(m.files).length!==2||typeof m.title!=='string'||!m.title.trim()||m.title.trim().length>120||typeof m.archived!=='boolean'||!['createdAt','updatedAt','modifiedAt'].every(k=>date(m[k])))bad();
   for(const name of ['document.json','history.jsonl'])if(typeof f[name]!=='string'||sha(f[name])!==m.files[name])bad();
   doc=JSON.parse(f['document.json']);if(doc.id!==m.documentId||doc.revision!==m.revision||doc.updatedAt!==m.updatedAt)bad();
   safeTree(doc);events=historyRows(f['history.jsonl'],doc);safeTree(events);title=m.title.trim();kind='project';verified=true;
   if(!events.length)warnings.push('파일에 변경 이력이 포함되어 있지 않아요.');
  }else{
   if(!keys(bundle,['documentId','revision','blocks','localEdits','exportedAt'])||!id(bundle.documentId)||typeof bundle.localEdits!=='boolean'||!date(bundle.exportedAt))bad();
   doc={id:bundle.documentId,revision:bundle.revision,updatedAt:bundle.exportedAt,blocks:bundle.blocks};title='가져온 문서';kind='snapshot';
   warnings.push('이 파일에는 문서 제목·변경 이력·승인 이력·검증용 해시가 없어요.');
   if(bundle.localEdits)warnings.push('미저장 편집이 포함되어 있어요. 표시된 버전은 마지막으로 확인한 저장 버전이며, 이 내용이 저장됐다는 증거는 아니에요.');
  }
  if(!keys(doc,['id','revision','updatedAt','blocks'])||!id(doc.id)||!Number.isSafeInteger(doc.revision)||doc.revision<1||!date(doc.updatedAt))bad();
  safeBlocks(doc.blocks);validateStoredDocumentSize(doc);
  const inlineText=items=>items.map(x=>x.type==='text'?x.text:x.content.map(y=>y.text||'').join('')).join('');
  const texts=[];
  function collect(rows){
   for(const b of rows){
    texts.push(b.type==='table'
     ? b.content.rows.map(row=>row.cells.map(cell=>inlineText(Array.isArray(cell)?cell:cell.content)).join(' | ')).join('\n')
     : inlineText(b.content??[]));
    collect(b.children);
   }
  }
  collect(doc.blocks);
  const digest=sha(encoded);
  // Identity excludes filenames, display metadata and export time; retains source
  // document identity, revision, content, history and snapshot dirty semantics.
  const backupIdentity=sha(stableJson({kind,sourceDocumentId:doc.id,revision:doc.revision,blocks:doc.blocks,events,localEdits:kind==='snapshot'?bundle.localEdits:false}));
  return {doc,events,kind,title,digest,backupIdentity,preview:{digest,title,revision:doc.revision,paragraphs:texts.length,text:texts.join('\n').slice(0,20000),truncated:texts.join('\n').length>20000,historyCount:events.length,history:events.slice(-7).map(e=>({revision:e.revision,actor:e.actor,operation:e.operation})),integrity:verified?'checksum-verified':'structure-only',warnings}};
 }catch(e){if(e instanceof RequestError&&e.code==='INVALID_BACKUP')throw e;bad();}
}

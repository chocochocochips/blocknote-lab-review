const cache=new Map();
const opinionCache=new Map();
const insertedCache=new Map();
const key=id=>'blocknote.ai.request.v1:'+id;
const opinionKey=id=>'blocknote.ai.opinion.v1:'+id;
const insertedKey=id=>'blocknote.ai.inserted.v1:'+id;

export function readPointer(documentId){
  try{const data=JSON.parse(sessionStorage.getItem(key(documentId)));if(data?.documentId===documentId&&typeof data.requestId==='string')return data;}catch{}
  return cache.get(documentId)??null;
}
export function writePointer(pointer){
  cache.set(pointer.documentId,pointer);
  try{sessionStorage.setItem(key(pointer.documentId),JSON.stringify(pointer));}catch{}
}
export const requestLabel=state=>({running:'AI 수정 중',review:'수정안 검토',cancelled:'요청 취소됨',conflict:'문서가 변경되어 다시 요청 필요',expired:'AI 요청 실패',failed:'AI 요청 실패',uncertain:'AI 요청 실패',approving:'승인 저장 중',committed:'저장 확인'})[state]??'';
export function matchesRequest(record,pointer){return Boolean(record&&pointer&&record.requestId===pointer.requestId&&record.documentId===pointer.documentId&&record.targetId===pointer.targetId&&record.baseRevision===pointer.baseRevision);}

export function clearPointer(documentId){cache.delete(documentId);try{sessionStorage.removeItem(key(documentId));}catch{}}

export function readOpinionView(documentId){
  if(!documentId)return null;
  try{
    const data=JSON.parse(sessionStorage.getItem(opinionKey(documentId)));
    if(data&&data.documentId===documentId&&typeof data.requestId==='string'&&typeof data.proposalId==='string'&&typeof data.content==='string'){
      opinionCache.set(documentId,data);
      return data;
    }
  }catch{}
  const cached=opinionCache.get(documentId);
  return cached?.documentId===documentId?cached:null;
}

export function writeOpinionView(documentId,view){
  if(!documentId||!view||view.documentId!==documentId)return;
  opinionCache.set(documentId,view);
  try{sessionStorage.setItem(opinionKey(documentId),JSON.stringify(view));}catch{}
}

export function clearOpinionView(documentId){
  opinionCache.delete(documentId);
  try{sessionStorage.removeItem(opinionKey(documentId));}catch{}
}

export function readInsertedMap(documentId){
  if(!documentId)return {};
  try{
    const data=JSON.parse(sessionStorage.getItem(insertedKey(documentId)));
    if(data&&typeof data==='object'&&!Array.isArray(data)){
      insertedCache.set(documentId,data);
      return {...data};
    }
  }catch{}
  return {...(insertedCache.get(documentId)||{})};
}

export function markInsertedRequest(documentId,{requestId,proposalId,revision=null,receipt='COMMITTED'}={}){
  if(!documentId||!requestId)return readInsertedMap(documentId);
  const current=readInsertedMap(documentId);
  const entry={documentId,requestId,proposalId:proposalId||null,revision,receipt};
  current[requestId]=entry;
  if(proposalId)current[proposalId]=entry;
  insertedCache.set(documentId,current);
  try{sessionStorage.setItem(insertedKey(documentId),JSON.stringify(current));}catch{}
  return {...current};
}

export function isRequestInserted(documentId,requestId,proposalId){
  if(!documentId)return false;
  const current=readInsertedMap(documentId);
  return Boolean((requestId&&current[requestId])||(proposalId&&current[proposalId]));
}

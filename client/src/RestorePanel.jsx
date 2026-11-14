import React,{useEffect,useRef,useState} from 'react';
const MAX_BYTES=750000;
async function post(path,body){
 const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await r.json();if(!r.ok)throw Error(data.error||'파일을 확인하지 못했어요.');return data;
}
export default function RestorePanel({onClose,onRestore}){
 const [preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[title,setTitle]=useState('');
 const bundle=useRef(null),requestId=useRef(null),serial=useRef(0),dialog=useRef(null),inFlight=useRef(false);
 useEffect(()=>{
  const el=dialog.current;el.querySelector('button')?.focus();
  const key=e=>{
   if(e.key==='Escape'){e.preventDefault();if(!inFlight.current)onClose();}
   if(e.key==='Tab'){
    const nodes=[...el.querySelectorAll('button,input')].filter(n=>!n.disabled),first=nodes[0],last=nodes.at(-1);
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
   }
  };el.addEventListener('keydown',key);return()=>{serial.current++;el.removeEventListener('keydown',key);};
 },[]);
 async function choose(e){
  const file=e.target.files?.[0],token=++serial.current;bundle.current=null;setPreview(null);setError('');
  if(!file)return;
  setBusy(true);
  try{
   if(file.size>MAX_BYTES)throw Error('파일이 너무 커요. 750KB 이하의 백업을 선택해 주세요.');
   const raw=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
   const value=JSON.parse(raw);const p=await post('/api/documents/restore/preview',{bundle:value});
   if(token!==serial.current)return;
   bundle.current=value;requestId.current='restore:'+crypto.randomUUID();setPreview(p);setTitle((p.title.slice(0,110)+' (복원)'));
  }catch(err){if(token===serial.current)setError('파일을 가져오지 못했어요. '+(err instanceof SyntaxError?'올바른 JSON 파일을 선택해 주세요.':err.message));}
  finally{if(token===serial.current)setBusy(false);}
 }
 async function restore(){
  if(inFlight.current||!preview||preview.duplicate||!bundle.current||!title.trim())return;
  inFlight.current=true;setBusy(true);setError('');
  try{await onRestore({bundle:bundle.current,digest:preview.digest,confirmed:true,requestId:requestId.current,title});}
  catch(err){setError(err.message+' 자동으로 다시 시도하지 않아요. 닫은 뒤 문서 목록을 확인하세요.');setPreview(null);bundle.current=null;}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <div className="restore-overlay"><section className="restore-panel" role="dialog" aria-modal="true" aria-labelledby="restore-title" ref={dialog}>
  <div className="restore-heading"><h2 id="restore-title">백업에서 복원하기</h2><button onClick={onClose} disabled={busy}>닫기</button></div>
  <p>기존 문서는 그대로 두고 새 문서로 가져와요. 원본 백업 파일은 바꾸지 않아요.</p>
  <label>백업 파일 선택<input type="file" accept=".json,application/json" onChange={choose} disabled={busy}/></label>
  {busy&&<p role="status">처리 중…</p>}
  {error&&<p role="alert">{error}</p>}
  {preview&&<>
   <h3>복원할 내용 미리보기</h3>
   {preview.duplicate&&<p className="restore-warning" role="alert">이미 가져온 백업이에요. 기존 복원 문서 ‘{preview.duplicate.title}’{preview.duplicate.archived?'(보관됨)':''}를 확인해 주세요. 중복 복원은 차단했어요.</p>}
   <label>새 문서 제목<input value={title} maxLength={120} onChange={e=>setTitle(e.target.value)} disabled={busy}/></label>
   <p>저장 버전 {preview.revision} · 문단 {preview.paragraphs}개 · 포함된 변경 이력 {preview.historyCount}개</p>
   <p>{preview.integrity==='checksum-verified'?'파일의 손상 여부를 확인했어요.':'파일 형식은 확인했지만 원본과 같은지 비교할 정보가 없어요.'}</p>
   <p>백업은 서명된 자료가 아니에요. 이력은 파일에 기록된 내용이며 실제 승인자의 신원을 증명하지 않아요.</p>
   {preview.warnings.map((w,i)=><p className="restore-warning" key={i}>{w}</p>)}
   <pre className="restore-text">{preview.text}</pre>{preview.truncated&&<p>긴 내용의 앞부분만 표시했어요.</p>}
   {preview.history.length>0&&<><h3>포함된 최근 변경 기록</h3><ul>{preview.history.map((e,i)=><li key={i}>저장 버전 {e.revision} · {e.actor} · {({'document.save':'문서 저장','block.insert':'문단 추가','block.update':'문단 수정','blocks.update':'여러 문단 수정','block.delete':'문단 삭제','recovery.restore':'이전 백업 복구'})[e.operation]}</li>)}</ul></>}
   <p>로그인 정보·AI 연결·미승인 제안은 복원되지 않아요.</p>
   {!preview.duplicate&&<button onClick={()=>void restore()} disabled={busy||!title.trim()}>새 문서로 복원 승인</button>}
  </>}
 </section></div>;
}

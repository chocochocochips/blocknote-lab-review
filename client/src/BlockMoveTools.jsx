import React,{useEffect,useRef,useState} from 'react';
export default function BlockMoveTools({editor,container,enabled,canMove,onStatus}) {
 const [rows,setRows]=useState([]),[drop,setDrop]=useState(null),drag=useRef(null);
 useEffect(()=>{
  if(!enabled)return;
  const surface=container.current;let frame;
  const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const parent=surface.getBoundingClientRect();
   setRows(editor.document.map(b=>{const el=surface.querySelector(`[data-id="${CSS.escape(b.id)}"]`);const r=el?.getBoundingClientRect();return r?{id:b.id,top:r.top-parent.top+surface.scrollTop,height:r.height}:null;}).filter(Boolean));
  });};
  const unsubscribe=editor.onChange(update),observer=new ResizeObserver(update);observer.observe(surface);surface.addEventListener('scroll',update);window.addEventListener('resize',update);update();
  return()=>{unsubscribe();observer.disconnect();surface.removeEventListener('scroll',update);window.removeEventListener('resize',update);cancelAnimationFrame(frame);};
 },[editor,enabled]);
 const move=(id,target)=>{
  if(!canMove()){onStatus('입력 조합·문서 전환·AI 작업을 마친 뒤 이동하세요.');return;}
  const ids=editor.document.map(b=>b.id),from=ids.indexOf(id),to=ids.indexOf(target);if(from<0||to<0||from===to)return;
  editor.transact(()=>{for(let n=0;n<Math.abs(to-from);n++){if(to<from)editor.moveBlocksUp(id);else editor.moveBlocksDown(id);}});
  editor.setTextCursorPosition(id,'start');editor.focus();onStatus('문단 순서를 변경했어요 · 자동 저장 대기');
 };
 if(!enabled)return null;
 return <div className="block-move-layer" aria-label="문서 내부 블록 이동">
  {rows.map((row,i)=><div key={row.id} className={'block-move-tools'+(drop===row.id?' drop-target':'')} style={{top:row.top}}>
   <button type="button" aria-label={`블록 ${i+1} 드래그 이동`} className="block-grip" onPointerDown={e=>{
    if(!canMove())return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={id:row.id,target:row.id};
   }} onPointerMove={e=>{if(!drag.current)return;const r=container.current.getBoundingClientRect(),y=e.clientY-r.top+container.current.scrollTop;
    const nearest=rows.reduce((a,b)=>Math.abs(b.top+b.height/2-y)<Math.abs(a.top+a.height/2-y)?b:a,rows[0]);drag.current.target=nearest.id;setDrop(nearest.id);
    if(e.clientY>r.bottom-45)container.current.scrollTop+=12;else if(e.clientY<r.top+45)container.current.scrollTop-=12;
   }} onPointerUp={()=>{if(drag.current)move(drag.current.id,drag.current.target);drag.current=null;setDrop(null);}}
    onPointerCancel={()=>{drag.current=null;setDrop(null);}}>⠿</button>
   <button type="button" aria-label={`블록 ${i+1} 위로`} disabled={i===0} onPointerDown={e=>e.preventDefault()} onClick={()=>move(row.id,rows[i-1].id)}>↑</button>
   <button type="button" aria-label={`블록 ${i+1} 아래로`} disabled={i===rows.length-1} onPointerDown={e=>e.preventDefault()} onClick={()=>move(row.id,rows[i+1].id)}>↓</button>
  </div>)}
 </div>;
}

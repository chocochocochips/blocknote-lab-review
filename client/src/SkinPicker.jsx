import React,{useEffect,useRef,useState} from 'react';
import {SKINS} from './appearance.mjs';
export default function SkinPicker({value,onChange}) {
 const [open,setOpen]=useState(false),root=useRef(null),trigger=useRef(null);
 useEffect(()=>{
  if(!open)return;
  const close=e=>{if(!root.current?.contains(e.target))setOpen(false);};
  const key=e=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}};
  document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);};
 },[open]);
 return <div className="skin-picker" ref={root}>
  <button type="button" className="phase2-skin-slot" ref={trigger} aria-label="AI 도우미 배경 스킨 변경"
   aria-expanded={open} aria-controls="skin-menu" onClick={()=>setOpen(!open)}>◉ <span>스킨</span></button>
  {open&&<div className="skin-menu" id="skin-menu" role="radiogroup" aria-label="AI 도우미 배경 스킨 선택">
   <strong>AI 도우미 배경</strong>
   {SKINS.map(([id,label],i)=><button key={id} type="button" role="radio" aria-checked={value===id} data-skin={id}
    className="skin-option" onKeyDown={e=>{if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(e.key)){e.preventDefault();const n=(i+(e.key==='ArrowDown'||e.key==='ArrowRight'?1:3))%4;onChange(SKINS[n][0]);root.current.querySelectorAll('[role=radio]')[n].focus();}}}
    onClick={()=>{onChange(id);setOpen(false);trigger.current?.focus();}}><span className="skin-swatch"/>{label}<span className="skin-check">{value===id?'✓':''}</span></button>)}
  </div>}
 </div>;
}

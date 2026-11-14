import React,{useEffect,useRef} from 'react';
export default function Overlay({title,onClose,children}) {
 const dialog=useRef(null);
 useEffect(()=>{const before=document.activeElement;dialog.current.showModal();return()=>{before?.focus();};},[]);
 return <dialog ref={dialog} className="phase2-overlay" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===dialog.current){const r=dialog.current.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}>
  <header><h2>{title}</h2><button type="button" onClick={onClose} aria-label="닫기">×</button></header>{children}
 </dialog>;
}

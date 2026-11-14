import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './phase2.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);


if(import.meta.env.VITE_LAB_CLOUD_TEST==='1'){
 const banner=document.createElement('aside');banner.setAttribute('role','status');
 banner.textContent='비공개 합성 시험실 · 실제 자료 입력 금지 · 재시작 시 모든 시험 데이터 초기화';
 banner.style.cssText='background:#fff0cb;color:#463712;padding:10px;text-align:center;font:14px sans-serif';
 document.body.prepend(banner);
 const logout=document.createElement('form');logout.action='/logout';logout.method='post';
 const button=document.createElement('button');button.textContent='시험실 로그아웃';logout.append(button);banner.append(logout);
}

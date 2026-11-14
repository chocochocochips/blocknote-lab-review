export const PREFERRED_TEST_MODEL='gpt-6-luna';
export const connectionPending=state=>['starting','waiting_browser','verifying'].includes(state?.phase);
export const connectionLabel=state=>({
  idle:'연결 안 됨',starting:'연결 시작',waiting_browser:'브라우저 로그인 대기',
  verifying:'인증 결과 확인',connected:'연결 완료',failed:'연결 실패 · 다시 시도할 수 있어요.',
  cancelled:'연결 취소됨 · 다시 시도할 수 있어요.',expired:'인증 대기 또는 세션이 만료됐어요. 다시 연결하세요.',
})[state?.phase]||'연결 상태 확인 중';
export function chooseAccountModel(models,previous,{cloud=false}={}){
  if(previous&&models.some(m=>m.slug===previous))return previous;
  if(cloud)return models[0]?.slug??'';
  // A removed selection is never silently replaced. A fresh local connection
  // prefers Luna only if it is actually present in the account's catalog.
  if(previous)return '';
  return models.find(m=>m.slug===PREFERRED_TEST_MODEL)?.slug??'';
}

/**
 * B-02: Compute the compact status chip text from the actual connection state
 * and looked-up model catalog. Never displays a hardcoded "always connected" label.
 */
export function formatConnectionChip({ connected = false, connection = { phase: 'idle' }, models = [], model = '', cloud = false } = {}) {
  if (connected) {
    if (cloud) {
      return { longLabel: '합성 AI · 연결됨', shortLabel: '합성됨', state: 'connected' };
    }
    const found = Array.isArray(models) ? models.find(m => m.slug === model) : null;
    const modelDisplay = found?.name || found?.slug || '모델 미선택';
    return {
      longLabel: `${modelDisplay} · 연결됨`,
      shortLabel: found ? found.slug.replace(/^gpt-6(\.1)?-/, '').toUpperCase() : '연결됨',
      state: 'connected',
    };
  }
  if (connectionPending(connection)) {
    return {
      longLabel: 'ChatGPT · 로그인 중',
      shortLabel: '대기',
      state: 'waiting',
    };
  }
  return {
    longLabel: 'ChatGPT 연결',
    shortLabel: '연결 안 됨',
    state: 'disconnected',
  };
}

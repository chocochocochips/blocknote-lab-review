/** ChatGPT subscription transport. Public Responses endpoint, NOT private ChatGPT endpoints. */
import { makeOpenAIRequest, parseOpenAIProposal } from './openai-provider.mjs';
import { RESOURCE } from './siwc-auth.mjs';

export function parseModelCatalog(data){
  if(!Array.isArray(data?.models))throw Error('Invalid account model catalog');
  return data.models.filter(m=>m?.visibility==='list' && typeof m.slug==='string' && m.slug && typeof m.display_name==='string')
    .map(m=>({slug:m.slug,name:m.display_name}));
}
export async function listSubscriptionModels({bearer,fetchImpl=fetch}){
  if(!bearer)throw Error('No authorized ChatGPT access token');
  const response=await fetchImpl(`${RESOURCE}/models`,{headers:{Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`ChatGPT model catalog HTTP ${response.status}`);
  return parseModelCatalog(await response.json());
}
export function makeSubscriptionRequest({document,model,mode,targetId,goal,reference}){
  // We use a separate adapter because this OAuth route has different requirements
  // from API-key Responses (streaming, no max_output_tokens, input as an array).
  const req=makeOpenAIRequest({document,model:'gpt-6-luna',mode,targetId,goal,reference});
  return {model,store:false,stream:true,
    text:req.text,
    instructions:req.instructions,
    input:[{role:'user',content:req.input}]};
}
export async function readSSE(response,{maxChars=130000}={}){
  if(!response.body?.getReader)throw Error('Missing streamed response body');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',total=0,terminal=null,output='';
  const processEvent=(record)=>{
    const lines=record.split(/\r?\n/).filter(line=>line.startsWith('data:'));
    if(!lines.length)return;
    const raw=lines.map(line=>line.slice(5).trimStart()).join('\n');
    if(raw==='[DONE]')return;
    let obj;try{obj=JSON.parse(raw);}catch{throw Error('Invalid SSE event JSON');}
    if(obj.type==='response.output_text.delta' && typeof obj.delta==='string')output+=obj.delta;
    if(obj.type==='response.failed' || obj.type==='response.incomplete' || obj.type==='error')throw Error(`Model stream did not complete: ${obj.error?.code??obj.response?.error?.code??obj.type}`);
    if(obj.type==='response.completed')terminal=obj.response;
  };
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>maxChars)throw Error('ChatGPT stream too large');
      buffer+=decoder.decode(value,{stream:true});
      let index;
      while((index=buffer.search(/\r?\n\r?\n/))!==-1){
        const match=buffer.slice(index).match(/^\r?\n\r?\n/)[0];
        processEvent(buffer.slice(0,index));buffer=buffer.slice(index+match.length);
      }
    }
    if(!terminal)throw Error('Stream ended before response.completed');
    if(terminal.status && terminal.status!=='completed')throw Error('Model response not completed');
    if(output)return {status:'completed',id:terminal.id,usage:terminal.usage,output:[{type:'message',content:[{type:'output_text',text:output}]}]};
    return terminal;
  }finally{reader.releaseLock();}
}
export async function requestSubscriptionProposal({document,model,mode,targetId,goal,reference,bearer,fetchImpl=fetch,signal}){
  if(!bearer)throw Error('ChatGPT plan authorization required');
  const payload=makeSubscriptionRequest({document,model,mode,targetId,goal,reference});
  const response=await fetchImpl(`${RESOURCE}/responses`,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:signal??AbortSignal.timeout(60000)});
  if(!response.ok){const error=new Error('모델 요청에 실패했습니다.');error.code=[401,403].includes(response.status)?'AUTH_EXPIRED':'AI_PROVIDER_UNAVAILABLE';throw error;}
  const streamed=await readSSE(response);
  return {proposal:parseOpenAIProposal(streamed),model,responseId:streamed.id,usage:streamed.usage??null};
}

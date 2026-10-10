'use strict';
const fs=require('./raw-fs.cjs').promises;
function cancellation(signal){if(signal?.aborted)throw Object.assign(Error('操作已取消'),{code:'ABORT_ERR'});}
function boundedSignal(signal,timeoutMs){cancellation(signal);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});return {signal:controller.signal,dispose(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}};}
async function jsonRequest(fetch,url,{body,signal,timeoutMs=20000}={}){
 const lifetime=boundedSignal(signal,timeoutMs);
 try{
  const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{Accept:'application/vnd.github+json'},body:body?JSON.stringify(body):undefined,signal:lifetime.signal});
  if(!response.ok)throw Error('服务连接失败（'+response.status+'）');if(!response.body)throw Error('服务没有返回内容');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{while(true){cancellation(lifetime.signal);const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>1024*1024)throw Error('服务返回内容过大');chunks.push(Buffer.from(next.value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{await reader.cancel().catch(()=>{});}
 }finally{lifetime.dispose();}
}
async function download(fetch,record,file,{signal,onProgress}={}){
 const lifetime=boundedSignal(signal,10*60000);let handle;
 try{
  const response=await fetch(record.url,{signal:lifetime.signal});if(!response.ok)throw Error('下载连接失败（'+response.status+'）');if(!response.body)throw Error('下载没有返回内容');
  handle=await fs.open(file,'wx',0o600);const reader=response.body.getReader();let received=0;
  try{while(true){cancellation(lifetime.signal);const item=await reader.read();if(item.done)break;received+=item.value.length;if(received>record.size)throw Error('下载大小超过发行记录');await handle.write(item.value);onProgress?.(received,record.size);}await handle.sync();}
  finally{await reader.cancel().catch(()=>{});}
 }finally{await handle?.close();lifetime.dispose();}
}
module.exports={jsonRequest,download};

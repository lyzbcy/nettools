'use strict';
const path=require('node:path');
const {validateRequest,runProcess}=require('./common.cjs');
const UNCERTAIN_CLEANUP=new Set(['ABORT_ERR','ABORTED','PROCESS_TIMEOUT','OUTPUT_LIMIT']);
function createDarwinPlatform({enginePath,configDir,resourcesDir,runner=runProcess}={}){
 for(const p of [enginePath,configDir,resourcesDir])if(typeof p!=='string'||!path.isAbsolute(p))throw TypeError('Mac 原生路径必须是绝对路径');
 let tail=Promise.resolve(),cleanupBlocked=false;
 function serial(fn){const next=tail.then(fn,fn);tail=next.catch(()=>{});return next;}
 async function invoke(action,args={}, {signal,background=false}={}){
  const valid=validateRequest(action,args);if(typeof background!=='boolean')throw TypeError('background 必须是布尔值');
  return serial(async()=>{
   if(signal?.aborted)throw Object.assign(Error('操作已取消'),{code:'ABORT_ERR'});
   if(cleanupBlocked)return {ok:false,error:{code:'CLEANUP_PENDING',message:'上一系统操作的清理尚未确认，已停止后续调用；请重启应用后再检查'}};
   let raw='',cleanupConfirmed=false;
   const observe=chunk=>{raw+=chunk.toString('utf8');if(raw.length>524288)raw=raw.slice(-524288);for(const line of raw.split('\n')){try{if(JSON.parse(line).cleanupComplete===true)cleanupConfirmed=true;}catch{}}};
   let result;try{result=await runner(enginePath,['--rpc','--config-dir',configDir,'--resources-dir',resourcesDir],{
    input:JSON.stringify({action,args:valid,background}),signal,onStdout:observe,timeoutMs:['install-helper','uninstall-helper'].includes(action)?150000:action==='network-check'?30000:45000});
   }catch(error){if(UNCERTAIN_CLEANUP.has(error.code)&&!cleanupConfirmed)cleanupBlocked=true;if(error.code==='ABORT_ERR')throw error;return {ok:false,error:{code:error.code||'PROCESS_FAILED',message:error.message}};}
   try{
    const answer=JSON.parse(result.stdout);
    if(answer?.cleanupComplete===false)cleanupBlocked=true;
    if(typeof answer?.ok!=='boolean'||(!answer.ok&&typeof answer.error?.code!=='string'))throw Error();
    if(!answer.ok&&UNCERTAIN_CLEANUP.has(answer.error.code)&&answer.cleanupComplete!==true&&!cleanupConfirmed)cleanupBlocked=true;
    return answer;
   }
   catch{return {ok:false,error:{code:'INVALID_RESULT',message:'Mac 原生执行层返回无效结果'}};}
  });
 }
 async function repair(issue,{signal}={}){
  const action={dns:'flush-dns',http:'flush-dns','stale-proxy':'clear-proxy','no-route':'renew-dhcp','no-link':'renew-dhcp'}[typeof issue==='string'?issue:issue?.issue];
  return action?invoke(action,{}, {signal,background:true}):{ok:false,error:{code:'UNSUPPORTED_ISSUE',message:'当前故障没有安全的自动修复动作'}};
 }
 async function restart({signal}={}){
  // User-level system API remains outside helper and general invoke whitelist.
  return serial(async()=>{if(cleanupBlocked)return {ok:false,error:{code:'CLEANUP_PENDING',message:'上一操作清理未确认，未请求重启'}};try{await runner('/usr/bin/osascript',['-e','tell application "System Events" to restart'],{signal,timeoutMs:10000});return {ok:true,data:{message:'已请求系统重启'}};}catch(e){if(e.code==='ABORT_ERR')throw e;return {ok:false,error:{code:e.code||'RESTART_FAILED',message:'系统未允许重启'}};}});
 }
 async function prepareRestart({signal}={}){
  // Called only while the user explicitly enables automatic restart. This
  // obtains Automation consent while they are present, without a system change.
  return serial(async()=>{if(cleanupBlocked)return {ok:false,error:{code:'CLEANUP_PENDING',message:'上一操作清理未确认，未请求授权'}};try{await runner('/usr/bin/osascript',['-e','tell application "System Events" to get name'],{signal,timeoutMs:60000});return {ok:true,data:{ready:true}};}catch(e){if(e.code==='ABORT_ERR')throw e;return {ok:false,error:{code:'AUTOMATION_REQUIRED',message:'请先允许本应用控制 System Events；自动重启尚未开启'}};}});
 }
 return {invoke,repair,restart,prepareRestart,isCleanupPending:()=>cleanupBlocked};
}
module.exports={createDarwinPlatform};

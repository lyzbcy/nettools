'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const {validateRequest,runProcess}=require('./common.cjs');
const PRIVILEGED=new Set(['flush-dns','set-dns','restore-dns','clear-proxy','restore-proxy','renew-dhcp','vpn-coexist','vpn-coexist-reset']);
function nativeResult(stdout){
 let result;try{result=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));}catch{throw Object.assign(Error('系统返回格式无效'),{code:'INVALID_RESULT'});}
 if(result?.ok!==true)throw Object.assign(Error(result?.error?.message||'系统操作失败'),{code:result?.error?.code||'NATIVE_ERROR'});
 if(!result.data||typeof result.data!=='object')throw Object.assign(Error('系统返回内容无效'),{code:'INVALID_RESULT'});return result.data;
}
function createWindowsPlatform({configDir,resourcesDir,runner=runProcess,stateIO=fs,pollDelayMs=350}){
 if(!path.isAbsolute(configDir)||!path.isAbsolute(resourcesDir))throw TypeError('平台目录必须是完整路径');
 if(!Number.isInteger(pollDelayMs)||pollDelayMs<1||pollDelayMs>5000)throw TypeError('无效任务检查间隔');
 const powershell=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const script=path.join(resourcesDir,'windows-network.ps1'),authorization=path.join(resourcesDir,'windows-authorization.ps1');
 let active=null;
 async function rpc(action,args={},signal){
  const request={action,args,configDir,version:'5.0.0'};
  try{const result=await runner(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:JSON.stringify(request),signal,timeoutMs:action==='speedtest'?90000:30000,maxOutput:512*1024});return nativeResult(result.stdout);}
  catch(error){if(error.code==='PROCESS_EXIT'&&error.stdout)return nativeResult(error.stdout);throw error;}
 }
 async function authorized(action,args,signal){
  const status=await rpc('helper-status',{},signal);if(!status.installed)throw Object.assign(Error('请先安装无人值守修复授权'),{code:'PERMISSION_REQUIRED'});
  if(signal?.aborted)throw Object.assign(Error('操作已取消，未启动后台任务'),{code:'ABORT_ERR'});
  const nonce=crypto.randomUUID();
  if(action==='vpn-coexist'){const configuration=await rpc('get-config',{},signal);args={config:configuration.config};}
  const request={action,args,nonce,version:'5.0.0',requestedAt:new Date().toISOString()};
  await stateIO.writeFile(status.requestFile+'.tmp',JSON.stringify(request),{mode:0o600});await stateIO.rename(status.requestFile+'.tmp',status.requestFile);
  if(signal?.aborted)throw Object.assign(Error('操作已取消，未启动后台任务'),{code:'ABORT_ERR'});
  const name=`\\LaoyuNetTools\\${status.sid}\\${action}`;
  const schtasks=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','schtasks.exe');
  let cancellation=false,endSent=false,result=null,pendingFailure=null;
  // /Run may dispatch the task before the launcher fails or times out. From
  // this point every error retains the lease until actual task exit is known.
  try{await runner(schtasks,['/Run','/TN',name],{timeoutMs:10000,maxOutput:32768});}catch(error){pendingFailure=error;}
  while(true){
   if(signal?.aborted)cancellation=true;
   try{const read=JSON.parse(await stateIO.readFile(status.resultFiles[action],'utf8'));if(read.nonce===nonce)result=read;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))pendingFailure??=e;}
   if((cancellation||pendingFailure)&&!endSent){endSent=true;try{await runner(schtasks,['/End','/TN',name],{timeoutMs:10000,maxOutput:32768});}catch{}}
   // A result alone is not proof that the privileged worker has exited. Task
   // query failure leaves the promise pending and prevents overlapping actions.
   let task;try{task=await rpc('task-status',{taskAction:action});}catch{}
   if(task?.state==='Ready'||task?.state==='Disabled'){
    if(pendingFailure)throw pendingFailure;
    if(cancellation)throw Object.assign(Error('修复已取消，后台任务已停止'),{code:'ABORT_ERR'});
    if(result)return nativeResult(JSON.stringify(result));
    throw Object.assign(Error('后台任务已停止但没有返回本次结果'),{code:'TASK_NO_RESULT'});
   }
   await new Promise(resolve=>setTimeout(resolve,pollDelayMs));
  }
 }
 async function invoke(action,args={},options={}){
  const normalized=validateRequest(action,args);if(active)throw Object.assign(Error('正在执行网络操作，请稍后重试'),{code:'BUSY'});
  const lease={};active=lease;
  try{
   if(action==='install-helper'||action==='uninstall-helper'){
    const status=await rpc('helper-status',{},options.signal),mode=action==='install-helper'?'install':'uninstall';
    let result;try{result=await runner(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',authorization,'-Mode',mode,'-CallerSid',status.sid],{input:'',signal:options.signal,timeoutMs:120000,maxOutput:32768});}catch(error){if(error.code==='PROCESS_EXIT'&&error.stdout)return nativeResult(error.stdout);throw error;}
    const data=nativeResult(result.stdout);return data;
   }
   if(PRIVILEGED.has(action))return await authorized(action,normalized,options.signal);
   return await rpc(action,normalized,options.signal);
  }finally{if(active===lease)active=null;}
 }
 async function repair(issue,{signal}={}){
  const action=({dns:'flush-dns',http:'flush-dns','stale-proxy':'clear-proxy','no-route':'renew-dhcp','no-link':'renew-dhcp'})[issue];
  if(!action)return {ok:false,error:{code:'UNSUPPORTED_REPAIR',message:'此类故障需要检查路由器或物理连接'}};
  const result=await invoke(action,{}, {signal,background:true});return {ok:true,...result};
 }
 async function restart({signal}={}){
  if(active)throw Object.assign(Error('网络操作仍在清理，未重启'),{code:'BUSY'});
  const shutdown=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','shutdown.exe');
  await runner(shutdown,['/r','/t','0','/d','p:0:0','/c','Laoyu NetTools: repair timeout, explicitly enabled by user'],{signal,timeoutMs:10000});return {ok:true};
 }
 return {invoke,repair,restart};
}
module.exports={createWindowsPlatform,nativeResult};

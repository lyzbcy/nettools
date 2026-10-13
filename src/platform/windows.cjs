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
 let active=null,cleanupBlocked=false;
 async function rpc(action,args={},signal){
  const request={action,args,configDir,version:'5.0.2'};
  try{const result=await runner(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:JSON.stringify(request),signal,timeoutMs:action==='speedtest'?90000:30000,maxOutput:512*1024});return nativeResult(result.stdout);}
  catch(error){if(error.code==='PROCESS_EXIT'&&error.stdout)return nativeResult(error.stdout);throw error;}
 }
 async function authorizationOperation(mode,sid,signal){
  if(signal?.aborted)throw Object.assign(Error('操作已取消，未启动授权'),{code:'ABORT_ERR'});
  const nonce=crypto.randomUUID();let ack=null,ambiguous=false,buffer='',bytes=0;
  const bound=value=>value&&value.nonce===nonce&&value.mode===mode&&value.CallerSid===sid;
  const onStderr=chunk=>{
   bytes+=chunk.length;if(bytes>32768){ambiguous=true;return;}buffer+=chunk.toString('utf8');
   while(buffer.includes('\n')){const index=buffer.indexOf('\n'),line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);let value;try{value=JSON.parse(line);}catch{continue;}
    if(value?.type!=='nettools-auth-child')continue;
    const keys=['type','nonce','mode','CallerSid','pid','createdTicks'];
    if(!bound(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key))||!Number.isInteger(value.pid)||value.pid<1||value.pid>2147483647||typeof value.createdTicks!=='string'||!/^\d{18}$/.test(value.createdTicks)){ambiguous=true;continue;}
    if(ack&&(ack.pid!==value.pid||ack.createdTicks!==value.createdTicks)){ambiguous=true;continue;}ack=value;
   }
  };
  let response,failure;
  try{response=await runner(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',authorization,'-Mode',mode,'-CallerSid',sid,'-Nonce',nonce],{input:'',signal,timeoutMs:null,maxOutput:32768,onStderr,killDescendants:false});}
  catch(error){failure=error;response={stdout:error.stdout||''};}
  let envelope;try{envelope=JSON.parse(response.stdout.trim().replace(/^\uFEFF/,''));}catch{}
  const completed=envelope?.authorization;
  // Only a bound completion from the fixed parent script, emitted after its
  // original Process handle closed, can prove closure without a query.
  const completionValid=bound(completed)&&completed.closed===true&&(
   (completed.execution==='direct'&&!ack&&!ambiguous)||
   (completed.execution==='child'&&ack&&!ambiguous&&completed.pid===ack.pid&&completed.createdTicks===ack.createdTicks)||
   (completed.execution==='none'&&!ack&&!ambiguous&&envelope?.ok===false&&['AUTH_CANCELLED','UNAUTHORIZED','INVALID_SID','INVALID_NONCE'].includes(envelope.error?.code))
  );
  if(!completionValid){
   if(ack&&!ambiguous){
    try{while(true){
     const identity={nonce,mode,CallerSid:sid,pid:ack.pid,createdTicks:ack.createdTicks};
     const status=await rpc('authorization-process-status',identity);
     if(!bound(status)||status.pid!==ack.pid||status.createdTicks!==ack.createdTicks||!['running','exited','replaced'].includes(status.state))throw Object.assign(Error('授权进程查询格式无效'),{code:'INVALID_RESULT'});
     if(status.state!=='running')break;
     await new Promise(resolve=>setTimeout(resolve,pollDelayMs));
    }}catch{cleanupBlocked=true;}
   }else cleanupBlocked=true;
   // A response without a completion proof is never a success, even if the
   // action returned an apparent success object before its parent was killed.
   failure??=Object.assign(Error('授权进程退出尚未确认'),{code:'AUTH_CLEANUP_UNCONFIRMED'});
  }
  if(completionValid&&failure?.code==='PROCESS_EXIT')return nativeResult(response.stdout);
  if(failure){if(cleanupBlocked)failure.cleanupPending=true;throw failure;}
  return nativeResult(response.stdout);
 }
 async function authorized(action,args,signal){
  const status=await rpc('helper-status',{},signal);if(!status.installed)throw Object.assign(Error('请先安装无人值守修复授权'),{code:'PERMISSION_REQUIRED'});
  if(signal?.aborted)throw Object.assign(Error('操作已取消，未启动后台任务'),{code:'ABORT_ERR'});
  const nonce=crypto.randomUUID();
  if(action==='vpn-coexist'){const configuration=await rpc('get-config',{},signal);args={config:configuration.config};}
  const request={action,args,nonce,version:'5.0.2',requestedAt:new Date().toISOString()};
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
  const normalized=validateRequest(action,args);if(active||cleanupBlocked)throw Object.assign(Error('正在执行网络操作，请稍后重试'),{code:'BUSY'});
  const lease={};active=lease;
  try{
   if(action==='install-helper'||action==='uninstall-helper'){
    const status=await rpc('helper-status',{},options.signal),mode=action==='install-helper'?'install':'uninstall';
    return await authorizationOperation(mode,status.sid,options.signal);
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
  if(active||cleanupBlocked)throw Object.assign(Error('网络操作仍在清理，未重启'),{code:'BUSY'});
  const shutdown=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','shutdown.exe');
  await runner(shutdown,['/r','/t','0','/d','p:0:0','/c','Laoyu NetTools: repair timeout, explicitly enabled by user'],{signal,timeoutMs:10000});return {ok:true};
 }
 return {invoke,repair,restart,isCleanupPending:()=>Boolean(active)||cleanupBlocked};
}
module.exports={createWindowsPlatform,nativeResult};

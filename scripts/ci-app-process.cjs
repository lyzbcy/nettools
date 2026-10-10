'use strict';
// Interactive CI applications use normal visibility. Native helpers keep their
// separate common.runProcess defaults; this module never sets visible=true.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {privatePath}=require('../src/core/update-desktop-acceptance.cjs');
function startCiApp(executable,args,{env=process.env,timeoutMs=10*60000,logFile,spawnFn=spawn,terminateFn}={}){
 if(env.CI!=='true'||!env.RUNNER_TEMP||!path.isAbsolute(env.RUNNER_TEMP)||!Number.isFinite(timeoutMs)||timeoutMs<1)throw Error('交互应用验收只允许隔离 CI');
 const runner=fs.realpathSync(env.RUNNER_TEMP),file=privatePath(runner,executable,{kind:'file'});if(!['LaoyuNetTools','LaoyuNetTools.exe'].includes(path.basename(file))||!Array.isArray(args)||args.length!==1||!args[0].startsWith('--nettools-data='))throw Error('CI 只启动固定应用和私有数据参数');
 privatePath(runner,args[0].slice('--nettools-data='.length),{missing:true});let log;
 if(logFile){privatePath(runner,logFile,{missing:true});fs.mkdirSync(path.dirname(logFile),{recursive:true,mode:0o700});log=fs.openSync(logFile,'wx',0o600);}
 const child=spawnFn(file,args,{env:{...env},shell:false,windowsHide:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let ended=false,error=null,timer,size=0,stopPromise=null;
 const terminate=force=>{
  if(ended)return;
  if(terminateFn)return terminateFn(child,force);
  if(process.platform==='win32'){
   const command=path.win32.join(env.SystemRoot||'C:\\Windows','System32','taskkill.exe');const killer=spawn(command,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});killer.on('error',()=>child.kill('SIGKILL'));
  }else{try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(cause){if(cause.code!=='ESRCH')throw cause;}}
 };
 const closed=new Promise((resolve,reject)=>{
  const collect=chunk=>{size+=chunk.length;if(log!==undefined&&size<=2*1024*1024)fs.writeSync(log,chunk);};child.stdout?.on('data',collect);child.stderr?.on('data',collect);
  child.once('error',cause=>error=cause);child.once('close',(code,signal)=>{ended=true;clearTimeout(timer);if(log!==undefined){fs.closeSync(log);log=undefined;}if(error)reject(error);else if(code!==0)reject(Object.assign(Error('CI 应用退出异常'),{code:'CI_APP_EXIT',exitCode:code,exitSignal:signal}));else resolve({code,signal});});
 });closed.catch(()=>{});
 const stop=()=>{if(stopPromise)return stopPromise;if(ended)return closed;stopPromise=(async()=>{terminate(false);let deadline;const escalate=setTimeout(()=>terminate(true),750);try{return await Promise.race([closed,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Object.assign(Error('CI 自有应用退出未确认，保留临时目录'),{code:'CI_CLEANUP_UNCONFIRMED'})),7000);})]);}finally{clearTimeout(escalate);clearTimeout(deadline);}})();return stopPromise;};
 timer=setTimeout(()=>{error=Object.assign(Error('CI 应用验收超时'),{code:'CI_APP_TIMEOUT'});void stop().catch(()=>{});},timeoutMs);
 return {child,closed,stop,get ended(){return ended;}};
}
module.exports={startCiApp};

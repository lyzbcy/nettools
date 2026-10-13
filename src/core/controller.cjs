'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {Watchdog}=require('./watchdog.cjs'),{loadSettings,saveSettings,validateSettings}=require('./settings.cjs');
const {validateRequest,WRITE_ACTIONS}=require('../platform/common.cjs');
const {normalizeIssue}=require('./log.cjs');
const LINKS=Object.freeze({release:'https://github.com/lyzbcy/nettools/releases',source:'https://github.com/lyzbcy/nettools',author:'https://lyzbcy.github.io/',stickers:'https://lyzbcy.github.io/weshoto-study/'});
function validateSender(sender,expected){if(!sender||sender.senderId!==expected.senderId||sender.url!==expected.url||sender.isMainFrame!==true)throw Error('拒绝非本地应用页面请求');return true;}
function validateLink(key){if(typeof key!=='string'||!Object.hasOwn(LINKS,key))throw Error('链接不受信任');return LINKS[key];}
function unwrap(result){
 if(result&&typeof result.ok==='boolean'&&(Object.hasOwn(result,'data')||Object.hasOwn(result,'error'))){if(!result.ok)throw Object.assign(Error(result.error?.message||'网络操作失败'),{code:result.error?.code||'NATIVE_ERROR'});return result.data;}
 return result;
}
function plainFile(file){try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('状态文件不是普通文件');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function resultLogMeta(action,result){
 if(action==='network-check')return {ok:result?.ok===true,issue:normalizeIssue(result?.issue)};
 if(action==='diagnose'){const issue=normalizeIssue(result?.issue);return {ok:issue==='ok',issue};}
 return {ok:true};
}
class Controller{
 constructor({dataDir,platform,version,name='捞鱼的网络工具',onState,log,clock,confirmRestart=async()=>false,applyLoginStartup,readLoginStartup}){
  if(!path.isAbsolute(dataDir)||!platform||typeof platform.invoke!=='function')throw TypeError('控制器配置无效');
  Object.assign(this,{dataDir,platform,version,name,onState,log,clock,confirmRestart,applyLoginStartup,readLoginStartup});this.settings=null;this.guard=null;this.network=null;this.status=null;this.authorization={installed:false};this.operation=null;this.lastError=null;this.settingsTail=Promise.resolve();
  this.settingsFile=path.join(dataDir,'settings.json');this.markerFile=path.join(dataDir,'reboot-guard.json');this.manualBusy=false;this.guardResultVersion=0;this.calls=new Set();this.shuttingDown=false;this.shutdownPromise=null;
 }
 snapshot(){return structuredClone({name:this.name,version:this.version,platform:process.platform,arch:process.arch,settings:this.settings,guard:this.guard?.snapshot()||null,network:this.network,status:this.status,authorization:this.authorization,operation:this.operation,lastError:this.lastError,shuttingDown:this.shuttingDown,now:this.clock?.now()??performance.now()});}
 _publish(){try{this.onState?.(this.snapshot());}catch{}}
 _log(level,action,meta={}){try{this.log?.add(level,action,meta);}catch{}}
 _assertOpen(){if(this.shuttingDown)throw Object.assign(Error('正在停止系统操作，请等待退出完成'),{code:'CLOSING'});}
 async _tracked(action,fn,signal){
  this._assertOpen();const controller=new AbortController(),lease={action,controller};const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});this.calls.add(lease);
  try{return await fn(controller.signal);}finally{signal?.removeEventListener('abort',abort);this.calls.delete(lease);}
 }
 async _call(action,args={},options={}){return this._tracked(action,async signal=>unwrap(await this.platform.invoke(action,args,{...options,signal})),options.signal);}
 async initialize(){
  fs.mkdirSync(this.dataDir,{recursive:true,mode:0o700});if(fs.lstatSync(this.dataDir).isSymbolicLink())throw Error('应用数据目录不能是符号链接');plainFile(this.settingsFile);
  this.settings=loadSettings(this.settingsFile);
  if(this.readLoginStartup){const actual=await this.readLoginStartup();if(typeof actual!=='boolean')throw Error('无法确认系统登录启动状态');if(actual!==this.settings.launchAtLogin)this.settings=saveSettings(this.settingsFile,{...this.settings,launchAtLogin:actual});}
  if(plainFile(this.markerFile)){this.settings=saveSettings(this.settingsFile,{...this.settings,restartOnTimeout:false});fs.unlinkSync(this.markerFile);this._log('warn','reboot-loop-protected',{message:'上次自动重启请求之后已暂停自动重启，请自行确认后重新开启'});}
  this.guard=new Watchdog({clock:this.clock,settings:this.settings,
   check:async({signal})=>this._call('network-check',{}, {signal,background:true}),
   repair:async(issue,{signal})=>this.platform.repair(issue,{signal}),
   restart:async({signal})=>{
    const cancelled=()=>{if(signal?.aborted)throw Object.assign(Error('重启已取消'),{code:'ABORT_ERR'});};cancelled();
    plainFile(this.markerFile);const temporary=this.markerFile+'.'+crypto.randomUUID()+'.tmp';let fd;
    try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({createdAt:new Date().toISOString(),reason:'repair-timeout'})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,this.markerFile);if(process.platform!=='win32'){const dir=fs.openSync(this.dataDir,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}}
    finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
    const refused=new Set(['RESTART_DENIED','PERMISSION_REQUIRED','AUTOMATION_REQUIRED','BUSY','CLEANUP_PENDING']);let dispatched=false;
    try{cancelled();dispatched=true;const result=await this.platform.restart({signal});if(result?.ok===false&&refused.has(result.error?.code))fs.rmSync(this.markerFile,{force:true});return result;}catch(error){if(!dispatched||refused.has(error.code))fs.rmSync(this.markerFile,{force:true});throw error;}
   },
   beforeRestart:async({signal})=>{
    const authorization=await this._call('helper-status',{}, {signal});if(signal?.aborted)throw Object.assign(Error('重启已取消'),{code:'ABORT_ERR'});this.authorization=authorization;
    if(!authorization.installed)return {ok:false,error:{code:'PERMISSION_REQUIRED',message:'修复授权未就绪，自动重启已阻止'}};
    return {ok:true};
   },
   onState:snapshot=>{if(snapshot.resultVersion>this.guardResultVersion){this.guardResultVersion=snapshot.resultVersion;this.network=snapshot.lastResult;}this._publish();},onLog:event=>this._log(event.ok===false?'warn':'info',event.action,{ok:event.ok,durationMs:event.durationMs,code:event.error?.code,message:event.error?.message,...(Object.hasOwn(event,'issue')?{issue:normalizeIssue(event.issue)}:{})})});
  for(const action of ['get-status','helper-status','network-check']){
   const startedAt=performance.now();
   try{const value=await this._call(action);if(action==='get-status')this.status=value;else if(action==='helper-status')this.authorization=value;else{this.network=value;const meta=resultLogMeta(action,value);this._log(meta.ok?'info':'warn',action,{...meta,durationMs:performance.now()-startedAt});}}
   catch(error){this.lastError={code:error.code||'INITIAL_CHECK',message:error.message};this._log('warn',action,{...this.lastError,ok:false});}
   this._publish();
  }
  if(!this.shuttingDown)void this.guard.start().catch(error=>{this.lastError={code:error.code||'GUARD_START',message:error.message};this._publish();});return this.snapshot();
 }
 async updateSettings(patch){
  validateSettings(patch);const request=structuredClone(patch);const result=this.settingsTail.then(()=>this._updateSettings(request));this.settingsTail=result.catch(()=>{});return result;
 }
 async _updateSettings(patch){
  this._assertOpen();
  const next=validateSettings({...this.settings,...patch});
  if(!this.settings.restartOnTimeout&&next.restartOnTimeout){
   if(!await this._tracked('restart-confirmation',signal=>this.confirmRestart({signal})))throw Object.assign(Error('已取消开启自动重启'),{code:'CANCELLED'});
   this._assertOpen();if(this.platform.prepareRestart){const ready=await this._tracked('restart-preparation',signal=>this.platform.prepareRestart({signal}));if(ready?.ok!==true)throw Object.assign(Error(ready?.error?.message||'系统未允许自动重启'),{code:ready?.error?.code||'RESTART_PERMISSION'});}
  }
  const loginChanged=this.settings.launchAtLogin!==next.launchAtLogin;
  if(loginChanged&&this.applyLoginStartup)await this.applyLoginStartup(next.launchAtLogin);
  try{this.settings=saveSettings(this.settingsFile,next);}catch(error){if(loginChanged&&this.applyLoginStartup)await this.applyLoginStartup(this.settings.launchAtLogin);throw error;}
  // Cancellation and schema application happen synchronously. A slow first
  // check must never hold the settings transaction and delay an off request.
  void this.guard.updateSettings(next).catch(error=>{this.lastError={code:error.code||'GUARD_SETTINGS',message:error.message};this._publish();});this._publish();return this.snapshot();
 }
 async checkNow(){if(this.settings.enabled){await this.guard.checkNow();return this.snapshot();}await this.invoke('network-check');return this.snapshot();}
 cancelRestart(){this.guard.cancelRestart();this._log('info','restart-cancelled',{message:'已取消本轮自动重启'});return this.snapshot();}
 suspend(){this.guard?.suspend();}
 resume(){return this.guard?.resume();}
 stop(){this.guard?.stop();}
 shutdown({timeoutMs=180000}={}){
  if(this.shutdownPromise)return this.shutdownPromise;this.shuttingDown=true;this.stop();
  // A UAC/administrator installation may already be running independently.
  // Let that explicit authorization finish; killing its parent cannot cancel it.
  for(const call of this.calls)if(!['install-helper','uninstall-helper'].includes(call.action))call.controller.abort();this._publish();
  this.shutdownPromise=(async()=>{const deadline=performance.now()+timeoutMs;while(this.calls.size||this.manualBusy||this.guard?.snapshot().operationPending){if(performance.now()>=deadline)throw Object.assign(Error('系统操作尚未确认退出，已停止保活；请稍后再退出'),{code:'OPERATION_CLEANUP'});await new Promise(r=>setTimeout(r,10));}await this.settingsTail;if(this.platform.isCleanupPending?.())throw Object.assign(Error('已停止保活，但系统操作清理未确认。请先在系统中确认操作已结束，再重新打开应用；修复记录会保留'),{code:'CLEANUP_PENDING'});return this.snapshot();})().catch(error=>{this.lastError={code:error.code||'SHUTDOWN_FAILED',message:error.message};this._publish();throw error;}).finally(()=>{this.shutdownPromise=null;});return this.shutdownPromise;
 }
 async reopenAfterShutdown(){if(this.calls.size||this.manualBusy||this.guard?.snapshot().operationPending||this.platform.isCleanupPending?.())throw Object.assign(Error('上一系统操作尚未确认结束'),{code:'CLEANUP_PENDING'});this.shuttingDown=false;await this.guard?.start();this._publish();}
 async _drain(){const until=Date.now()+60000;while(this.guard.snapshot().operationPending){if(Date.now()>until)throw Object.assign(Error('上一项操作尚未确认退出，请稍后重试'),{code:'OPERATION_CLEANUP'});await new Promise(r=>setTimeout(r,25));}}
 async invoke(action,args={}){
  this._assertOpen();
  const normalized=validateRequest(action,args);
  if(this.manualBusy)throw Object.assign(Error('正在执行网络操作，请稍后重试'),{code:'BUSY'});
  const write=WRITE_ACTIONS.has(action);this.manualBusy=true;
  try{
   if(write){this.guard.suspend();await this._drain();}
   else if(this.guard.snapshot().operationPending)throw Object.assign(Error('正在执行保活检查，请稍后重试'),{code:'BUSY'});
   this.operation={action,startedAt:performance.now()};this.lastError=null;this._publish();this._log('info',action,{phase:'started'});
   const result=await this._call(action,normalized);
   if(action==='network-check')this.network=result;if(action==='get-status')this.status=result;
   if(['install-helper','uninstall-helper','helper-status'].includes(action))this.authorization=await this._call('helper-status');
   const meta=resultLogMeta(action,result);this._log(meta.ok?'info':'warn',action,{...meta,durationMs:performance.now()-this.operation.startedAt});return result;
  }catch(error){if(action==='network-check')this.network=null;this.lastError={code:error.code||'ACTION_FAILED',message:error.message};this._log('error',action,{...this.lastError,ok:false});throw error;}
  finally{this.operation=null;this.manualBusy=false;if(write&&!this.shuttingDown)void this.guard.resume().catch(error=>{this.lastError={code:error.code||'RESUME_FAILED',message:error.message};this._publish();});this._publish();}
 }
}
module.exports={Controller,unwrap,validateSender,validateLink};

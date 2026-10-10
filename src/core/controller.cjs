'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const {Watchdog}=require('./watchdog.cjs'),{loadSettings,saveSettings,validateSettings}=require('./settings.cjs');
const {validateRequest,WRITE_ACTIONS}=require('../platform/common.cjs');
const LINKS=Object.freeze({release:'https://github.com/lyzbcy/nettools/releases',source:'https://github.com/lyzbcy/nettools',author:'https://lyzbcy.github.io/',stickers:'https://lyzbcy.github.io/weshoto-study/'});
function validateSender(sender,expected){if(!sender||sender.senderId!==expected.senderId||sender.url!==expected.url||sender.isMainFrame!==true)throw Error('拒绝非本地应用页面请求');return true;}
function validateLink(key){if(typeof key!=='string'||!Object.hasOwn(LINKS,key))throw Error('链接不受信任');return LINKS[key];}
function unwrap(result){
 if(result&&typeof result.ok==='boolean'&&(Object.hasOwn(result,'data')||Object.hasOwn(result,'error'))){if(!result.ok)throw Object.assign(Error(result.error?.message||'网络操作失败'),{code:result.error?.code||'NATIVE_ERROR'});return result.data;}
 return result;
}
function plainFile(file){try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('状态文件不是普通文件');return st;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
class Controller{
 constructor({dataDir,platform,version,name='捞鱼的网络工具',onState,log,clock,confirmRestart=async()=>false,applyLoginStartup,readLoginStartup}){
  if(!path.isAbsolute(dataDir)||!platform||typeof platform.invoke!=='function')throw TypeError('控制器配置无效');
  Object.assign(this,{dataDir,platform,version,name,onState,log,clock,confirmRestart,applyLoginStartup,readLoginStartup});this.settings=null;this.guard=null;this.network=null;this.status=null;this.authorization={installed:false};this.operation=null;this.lastError=null;this.settingsTail=Promise.resolve();
  this.settingsFile=path.join(dataDir,'settings.json');this.markerFile=path.join(dataDir,'reboot-guard.json');this.manualBusy=false;this.guardResultVersion=0;
 }
 snapshot(){return structuredClone({name:this.name,version:this.version,platform:process.platform,arch:process.arch,settings:this.settings,guard:this.guard?.snapshot()||null,network:this.network,status:this.status,authorization:this.authorization,operation:this.operation,lastError:this.lastError,now:this.clock?.now()??performance.now()});}
 _publish(){try{this.onState?.(this.snapshot());}catch{}}
 _log(level,action,meta={}){try{this.log?.add(level,action,meta);}catch{}}
 async _call(action,args={},options={}){return unwrap(await this.platform.invoke(action,args,options));}
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
   onState:snapshot=>{if(snapshot.resultVersion>this.guardResultVersion){this.guardResultVersion=snapshot.resultVersion;this.network=snapshot.lastResult;}this._publish();},onLog:event=>this._log(event.ok===false?'warn':'info',event.action,{ok:event.ok,durationMs:event.durationMs,code:event.error?.code,message:event.error?.message})});
  for(const action of ['get-status','helper-status','network-check']){
   try{const value=await this._call(action);if(action==='get-status')this.status=value;else if(action==='helper-status')this.authorization=value;else this.network=value;}
   catch(error){this.lastError={code:error.code||'INITIAL_CHECK',message:error.message};this._log('warn',action,this.lastError);}
   this._publish();
  }
  await this.guard.start();return this.snapshot();
 }
 async updateSettings(patch){
  validateSettings(patch);const request=structuredClone(patch);const result=this.settingsTail.then(()=>this._updateSettings(request));this.settingsTail=result.catch(()=>{});return result;
 }
 async _updateSettings(patch){
  const next=validateSettings({...this.settings,...patch});
  if(!this.settings.restartOnTimeout&&next.restartOnTimeout){
   if(!await this.confirmRestart())throw Object.assign(Error('已取消开启自动重启'),{code:'CANCELLED'});
   if(this.platform.prepareRestart){const ready=await this.platform.prepareRestart({});if(ready?.ok!==true)throw Object.assign(Error(ready?.error?.message||'系统未允许自动重启'),{code:ready?.error?.code||'RESTART_PERMISSION'});}
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
 async _drain(){const until=Date.now()+60000;while(this.guard.snapshot().operationPending){if(Date.now()>until)throw Object.assign(Error('上一项操作尚未确认退出，请稍后重试'),{code:'OPERATION_CLEANUP'});await new Promise(r=>setTimeout(r,25));}}
 async invoke(action,args={}){
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
   this._log('info',action,{ok:true,durationMs:performance.now()-this.operation.startedAt});return result;
  }catch(error){if(action==='network-check')this.network=null;this.lastError={code:error.code||'ACTION_FAILED',message:error.message};this._log('error',action,this.lastError);throw error;}
  finally{this.operation=null;this.manualBusy=false;if(write)void this.guard.resume().catch(error=>{this.lastError={code:error.code||'RESUME_FAILED',message:error.message};this._publish();});this._publish();}
 }
}
module.exports={Controller,unwrap,validateSender,validateLink};

'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const RELEASE_PAGE='https://github.com/lyzbcy/nettools/releases';
function parsedVersion(v){if(typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v))throw Error('版本号必须是正式 x.y.z');const nums=v.split('.').map(Number);if(nums.some(n=>!Number.isSafeInteger(n)))throw Error('版本号过大');return nums;}
function compareVersions(a,b){const x=parsedVersion(a),y=parsedVersion(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;}
function selectRelease(release,current,platform,arch){
 if(!release||release.draft||release.prerelease)throw Error('只接受正式发行');
 const version=String(release.tag_name||'').replace(/^v/,'');parsedVersion(version);parsedVersion(current);
 if(!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch)||(platform==='win32'&&arch!=='x64'))throw Error('当前平台尚不支持自动更新');
 const releaseUrl=`${RELEASE_PAGE}/tag/${release.tag_name}`;
 if(release.html_url!==releaseUrl)throw Error('发行来源不受信任');
 if(compareVersions(version,current)<=0)return {hasUpdate:false,version,current,releaseUrl};
 const name=`nettools-${version}-${platform==='darwin'?'mac':'win'}-${arch}.zip`;
 const assets=Array.isArray(release.assets)?release.assets.filter(a=>a.name===name):[];
 if(assets.length!==1)throw Error('没有唯一匹配当前平台和芯片的更新包');
 const asset=assets[0],expected=`${RELEASE_PAGE}/download/${release.tag_name}/${name}`;
 if(asset.browser_download_url!==expected||!/^sha256:[a-f\d]{64}$/i.test(asset.digest||'')||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>1024*1024*1024)throw Error('更新地址、大小或 SHA-256 不合法');
 return {hasUpdate:true,version,current,name,url:expected,sha256:asset.digest.slice(7).toLowerCase(),size:asset.size,releaseUrl};
}
function dayInShanghai(date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
function notLink(file){try{if(fs.lstatSync(file).isSymbolicLink())throw Error('更新状态不能使用符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}}
function atomicJson(file,data){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});notLink(file);const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
async function hashFile(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
class Updater{
 constructor({version,platform,arch,historyFile,downloadDir,getRelease,download,prepare,onProgress,now=()=>new Date()}){
  parsedVersion(version);for(const [k,v]of Object.entries({getRelease,download,prepare}))if(typeof v!=='function')throw TypeError(k+' must be a function');
  Object.assign(this,{version,platform,arch,historyFile,downloadDir,getRelease,download,prepare,onProgress,now});
  this.record=null;this.stageRunning=false;this.pendingCheck=null;this.controller=null;
  this.status={state:'idle',lastAttemptDay:null,lastSuccessDay:null,error:null,progress:null,release:null};
  notLink(historyFile);try{const history=JSON.parse(fs.readFileSync(historyFile,'utf8'));for(const key of ['lastAttemptDay','lastSuccessDay'])if(/^\d{4}-\d{2}-\d{2}$/.test(history[key]||''))this.status[key]=history[key];}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 }
 snapshot(){return structuredClone(this.status);}
 _publish(){try{this.onProgress?.(this.snapshot());}catch{}}
 _history(){atomicJson(this.historyFile,{lastAttemptDay:this.status.lastAttemptDay,lastSuccessDay:this.status.lastSuccessDay});}
 check({manual=false}={}){
  if(this.pendingCheck)return this.pendingCheck;
  const day=dayInShanghai(this.now());if(!manual&&this.status.lastAttemptDay===day)return Promise.resolve(this.record);
  this.status.lastAttemptDay=day;this._history();this.status.state='checking';this.status.error=null;this._publish();
  this.pendingCheck=Promise.resolve().then(()=>this.getRelease()).then(release=>{
   const record=selectRelease(release,this.version,this.platform,this.arch);this.record=record;this.status.release=record;this.status.lastSuccessDay=day;this.status.state=record.hasUpdate?'available':'current';this._history();this._publish();return record;
  },error=>{throw error;}).catch(error=>{this.status.state='error';this.status.error=String(error.message||error);this._publish();throw error;}).finally(()=>{this.pendingCheck=null;});
  return this.pendingCheck;
 }
 cancel(){this.controller?.abort();}
 async stage(){
  if(this.stageRunning)throw Error('正在准备更新，请等待');
  this.stageRunning=true;this.controller=new AbortController();const signal=this.controller.signal;let partial;
  try{
   const record=await this.check({manual:true});if(signal.aborted)throw Error('更新已取消');if(!record?.hasUpdate)throw Error('当前没有可用的正式更新');
   await fsp.mkdir(this.downloadDir,{recursive:true,mode:0o700});notLink(this.downloadDir);
   partial=path.join(this.downloadDir,crypto.randomUUID()+'-'+record.name+'.part');
   this.status.state='downloading';this.status.progress={received:0,total:record.size,percent:0};this._publish();
   await this.download(record,partial,{signal,onProgress:(received,total=record.size)=>{if(signal.aborted)return;this.status.progress={received,total,percent:total>0?Math.min(100,Math.floor(received/total*100)):0};this._publish();}});
   if(signal.aborted)throw Error('更新已取消');
   this.status.state='verifying';this._publish();
   const stat=await fsp.lstat(partial);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.size||await hashFile(partial)!==record.sha256)throw Error('更新包 SHA-256 或大小校验失败，未执行更新');
   if(signal.aborted)throw Error('更新已取消');
   const file=partial.slice(0,-5);await fsp.rename(partial,file);partial=null;
   this.status.state='preparing';this._publish();
   const ready=await this.prepare({...record,file},{signal});if(signal.aborted)throw Error('更新已取消');if(ready?.ready!==true)throw Error('更新准备失败，保留当前程序');
   this.status.state='ready';this._publish();return {...record,file,...ready};
  }catch(error){this.status.state='error';this.status.error=String(error.message||error);this._publish();throw error;}
  finally{if(partial)await fsp.rm(partial,{force:true});this.stageRunning=false;this.controller=null;}
 }
}
module.exports={Updater,compareVersions,selectRelease,dayInShanghai,hashFile,RELEASE_PAGE};

'use strict';
// Fixed CI acceptance, never renderer-supplied code, commands or URLs.
const fs=require('./raw-fs.cjs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {compareVersions,parsedVersion}=(()=>{const u=require('./updater.cjs');return {compareVersions:u.compareVersions,parsedVersion:v=>u.compareVersions(v,v)};})();
const PLAN_KEY='NETTOOLS_UPDATE_ACCEPTANCE_PLAN',NONCE_KEY='NETTOOLS_UPDATE_ACCEPTANCE_NONCE';
function inside(root,file){const relative=path.relative(root,file);return relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);}
function privatePath(root,file,{kind,missing=false}={}){
 const base=fs.lstatSync(root);if(base.isSymbolicLink()||!base.isDirectory()||fs.realpathSync(root)!==path.resolve(root))throw Error('CI 根目录必须是真实普通目录');
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\x00-\x1f]/.test(file))throw Error('CI 路径格式无效');const absolute=path.resolve(file);if(!inside(root,absolute))throw Error('CI 路径不在独立根目录内');
 const parts=path.relative(root,absolute).split(path.sep);let current=root;
 for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);let stat;try{stat=fs.lstatSync(current);}catch(error){if(missing&&error.code==='ENOENT')continue;throw error;}if(stat.isSymbolicLink()||(i<parts.length-1&&!stat.isDirectory()))throw Error('CI 路径包含链接或非目录');if(i===parts.length-1&&kind&&(kind==='file'?!stat.isFile():!stat.isDirectory()))throw Error('CI 路径类型无效');}
 return absolute;
}
function fixtureVersions(candidate){parsedVersion(candidate);const baseline='4.99.0';if(compareVersions(candidate,baseline)<=0)throw Error('CI 旧副本版本必须低于候选版');const parts=candidate.split('.').map(Number);parts[2]++;const failure=parts.join('.');parsedVersion(failure);return {candidate,baseline,failure};}
function planPaths(plan){return {evidenceDir:path.join(plan.caseRoot,'evidence'),driverFile:path.join(plan.caseRoot,'driver.json'),probeFile:path.join(plan.caseRoot,'probe.json'),errorFile:path.join(plan.caseRoot,'error.json'),stopFile:path.join(plan.caseRoot,'stop.json'),failureStartedFile:path.join(plan.caseRoot,'failure-started.json')};}
function loadUpdateAcceptancePlan({env=process.env,appPath,dataDir,version,argv=process.argv,platform=process.platform,arch=process.arch}={}){
 const input=env[PLAN_KEY],nonce=env[NONCE_KEY];if(!input&&!nonce)return null;
 if(env.CI!=='true'||typeof env.RUNNER_TEMP!=='string'||!path.isAbsolute(env.RUNNER_TEMP)||!/^[a-f0-9]{64}$/.test(nonce||''))throw Error('更新验收仅允许私有 CI 计划');
 const runner=fs.realpathSync(env.RUNNER_TEMP),file=privatePath(runner,input,{kind:'file'}),st=fs.lstatSync(file),parent=fs.lstatSync(path.dirname(file));if(path.basename(file)!=='plan.json'||st.size>16384||st.nlink!==1)throw Error('CI 计划文件格式无效');
 if(process.platform!=='win32'&&(st.uid!==process.getuid()||parent.uid!==process.getuid()||(st.mode&0o077)||(parent.mode&0o077)))throw Error('CI 计划必须由当前用户独占');
 const plan=JSON.parse(fs.readFileSync(file,'utf8')),mode=plan.mode||'update',common=['protocol','mode','nonce','platform','arch','suiteRoot','caseRoot','installPath','dataDir'],specific=mode==='observe'?['version']:['fixture','published','transport','scenario','sourceArchive','size','sha256','driveVersion','targetVersion','configSha256','sentinelSha256'];
 if(Object.keys(plan).some(key=>![...common,...specific].includes(key))||plan.protocol!==1||plan.nonce!==nonce||!['update','observe'].includes(mode)||plan.platform!==platform||plan.arch!==arch||!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch)||(platform==='win32'&&arch!=='x64'))throw Error('CI 计划身份或字段无效');
 const suiteRoot=privatePath(runner,plan.suiteRoot,{kind:'directory'}),caseRoot=privatePath(suiteRoot,plan.caseRoot,{kind:'directory'}),installPath=privatePath(suiteRoot,plan.installPath,{kind:'directory'}),data=privatePath(suiteRoot,plan.dataDir,{kind:'directory'}),overlaps=(a,b)=>a===b||inside(a,b)||inside(b,a);if(path.dirname(file)!==caseRoot||path.resolve(appPath)!==installPath||path.resolve(dataDir)!==data||overlaps(installPath,data)||overlaps(caseRoot,installPath)||overlaps(caseRoot,data))throw Error('CI 安装、数据或验收目录身份不匹配');
 const confirms=argv.filter(arg=>typeof arg==='string'&&arg.startsWith('--nettools-update-confirm=')),results=argv.filter(arg=>typeof arg==='string'&&arg.startsWith('--nettools-update-result='));if(confirms.length>1||results.length>1||(confirms.length&&results.length)||argv.includes('--nettools-smoke'))throw Error('CI 更新观察角色不唯一或使用了模拟平台');
 let role='drive';
 if(mode==='observe'){if(confirms.length||results.length||version!==plan.version)throw Error('独立观察不能介入更新握手');parsedVersion(plan.version);role='observe';}
 else{
  if(plan.fixture!==true||plan.published!==false||plan.transport!=='fixture.local'||!['success','rollback'].includes(plan.scenario)||!/^[a-f0-9]{64}$/.test(plan.sha256||'')||!/^[a-f0-9]{64}$/.test(plan.configSha256||'')||!/^[a-f0-9]{64}$/.test(plan.sentinelSha256||'')||!Number.isSafeInteger(plan.size)||plan.size<1||plan.size>1024*1024*1024)throw Error('本地 CI 包来源必须明确且有完整校验');
  parsedVersion(plan.driveVersion);parsedVersion(plan.targetVersion);if(compareVersions(plan.targetVersion,plan.driveVersion)<=0||(plan.scenario==='success'?plan.driveVersion!==fixtureVersions(plan.targetVersion).baseline:plan.targetVersion!==fixtureVersions(plan.driveVersion).failure))throw Error('CI 版本隔离不匹配');
  const source=privatePath(caseRoot,plan.sourceArchive,{kind:'file'}),name=`nettools-${plan.targetVersion}-${platform==='darwin'?'mac':'win'}-${arch}.zip`;if(path.basename(source)!==name||fs.statSync(source).size!==plan.size)throw Error('CI 原始包身份不匹配');
  if(confirms.length||results.length){const argument=confirms[0]||results[0],flagFile=privatePath(data,argument.slice(argument.indexOf('=')+1),{kind:'file'});if(!inside(path.join(data,'updates'),flagFile)||path.basename(flagFile)!==(confirms.length?'confirm-request.json':'result.json'))throw Error('CI 观察参数越界');role=confirms.length?'confirmed':'rollback';}
  if(version!==(role==='confirmed'?plan.targetVersion:plan.driveVersion)||(role==='rollback'&&plan.scenario!=='rollback'))throw Error('CI 当前版本或角色不匹配');
 }
 // Even the observe-only mode cannot let a pre-existing CI data file start repair.
 const settingsFile=path.join(data,'settings.json');if(fs.existsSync(settingsFile)){privatePath(data,settingsFile,{kind:'file'});const settings=require('./settings.cjs').validateSettings(JSON.parse(fs.readFileSync(settingsFile,'utf8')));if(settings.enabled||settings.restartOnTimeout||settings.launchAtLogin)throw Error('CI 数据不能开启修复、重启或登录启动');}if(fs.existsSync(path.join(data,'reboot-guard.json')))throw Error('CI 数据不能包含待处理的重启保护记录');
 return {...plan,mode,role,runnerRoot:runner,file,...planPaths(plan)};
}
function fixtureTransport(plan){
 if(plan.mode!=='update'||plan.transport!=='fixture.local'||plan.fixture!==true||plan.published!==false)throw Error('独立观察不能启用本地更新传输');
 const tag='v'+plan.targetVersion,name=path.basename(plan.sourceArchive),base='https://github.com/lyzbcy/nettools/releases',release={fixture:true,published:false,transport:'fixture.local',tag_name:tag,html_url:base+'/tag/'+tag,draft:false,prerelease:false,assets:[{name,browser_download_url:base+'/download/'+tag+'/'+name,digest:'sha256:'+plan.sha256,size:plan.size}]};
 return {getRelease:async()=>structuredClone(release),download:async(record,file,{signal,onProgress}={})=>{
  const expected=release.assets[0];if(record.name!==name||record.version!==plan.targetVersion||record.sha256!==plan.sha256||record.size!==plan.size||record.url!==expected.browser_download_url)throw Error('CI 下载记录与私有来源不一致');privatePath(path.join(plan.dataDir,'updates'),file,{missing:true});privatePath(plan.caseRoot,plan.sourceArchive,{kind:'file'});
  let received=0;const handle=await fsp.open(file,'wx',0o600);try{for await(const bytes of fs.createReadStream(plan.sourceArchive,{highWaterMark:65536,signal})){if(signal?.aborted)throw Object.assign(Error('CI 下载已取消'),{code:'ABORT_ERR'});let offset=0;while(offset<bytes.length){const written=await handle.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw Error('CI 字节复制未完成');offset+=written.bytesWritten;received+=written.bytesWritten;if(received>plan.size)throw Error('CI 源文件大小改变');onProgress?.(received,plan.size);}}if(received!==plan.size)throw Error('CI 源文件大小改变');await handle.sync();}finally{await handle.close();}
 }};
}
function assertUpdateSnapshot({plan,role,version,isPackaged,visible,execPath,dataDir,state,domVersion,diskSettings,configHash,sentinelHash}){
 const expected=plan.mode==='observe'?plan.version:role==='confirmed'?plan.targetVersion:plan.driveVersion,exe=plan.platform==='darwin'?path.join(plan.installPath,'Contents/MacOS/LaoyuNetTools'):path.join(plan.installPath,'LaoyuNetTools.exe');
 if(isPackaged!==true||visible!==true||version!==expected||domVersion!==expected||path.resolve(execPath)!==exe||path.resolve(dataDir)!==plan.dataDir||state?.initializing||state?.version!==expected)throw Error('真实安装版、窗口、DOM 或路径身份不一致');
 const safe=settings=>settings&&settings.enabled===false&&settings.restartOnTimeout===false&&settings.launchAtLogin===false;
 if(!safe(state.settings)||(diskSettings&&!safe(diskSettings)))throw Error('验收安全设置改变');
 if(plan.mode==='update'&&(state.settings.intervalMinutes!==17||diskSettings?.intervalMinutes!==17||configHash!==plan.configSha256||sentinelHash!==plan.sentinelSha256))throw Error('17分钟或公司配置/数据未保留');
 return {version,packaged:true,visible:true,execPath,dataDir,intervalMinutes:state.settings.intervalMinutes,safeSwitches:true,configPreserved:plan.mode==='update',sentinelPreserved:plan.mode==='update'};
}
async function digest(file){const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function atomic(file,value){const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fsp.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fsp.rename(tmp,file);}
module.exports={PLAN_KEY,NONCE_KEY,inside,privatePath,fixtureVersions,planPaths,loadUpdateAcceptancePlan,fixtureTransport,assertUpdateSnapshot,digest,atomic};
async function watchInstallHandoff({app,window,getState,waitFor,onFailure}){
 let closing=false;const beforeQuit=()=>{closing=true;};app.once('before-quit',beforeQuit);try{await waitFor(async()=>{if(closing||window.isDestroyed())return true;const update=getState().update;if(update?.state==='error'){const failure=Object.assign(Error('实际更新交接失败：'+update.error),{code:'CI_HANDOFF_FAILED'});try{await onFailure(update);}catch(error){failure.captureError=error.message;}throw failure;}return false;});return 'original-closing';}finally{app.removeListener('before-quit',beforeQuit);}
}
module.exports.watchInstallHandoff=watchInstallHandoff;
async function updateDesktopAcceptance({app,window,getState,getReady,plan,requestQuit}){
 if(!plan||process.env.CI!=='true')throw Error('缺少已验证的 CI 计划');
 const evaluate=code=>window.webContents.executeJavaScript(code,true),pause=()=>new Promise(resolve=>setTimeout(resolve,75));
 const report={protocol:1,nonce:plan.nonce,mode:plan.mode,scenario:plan.scenario||null,role:plan.role,fixture:plan.mode==='update',published:plan.mode==='update'?false:null,transport:plan.mode==='update'?'fixture.local':'normal',pid:process.pid,startedAt:new Date().toISOString(),steps:[]};
 const cancelled=async()=>{if(plan.role!=='drive')return;try{privatePath(plan.caseRoot,plan.stopFile,{kind:'file'});const stop=JSON.parse(await fsp.readFile(plan.stopFile,'utf8'));if(stop.nonce===plan.nonce)throw Object.assign(Error('外部CI已停止本次驱动'),{code:'CI_ACCEPTANCE_STOP'});}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}};
 const waitFor=async(check,timeout=10*60000)=>{const end=Date.now()+timeout;while(Date.now()<end){await cancelled();if(await check())return;await pause();}throw Error('实际升级界面/进程等待超时');};
 async function snapshot(){
  const state=getState(),settingsFile=path.join(plan.dataDir,'settings.json');let diskSettings=null;try{privatePath(plan.dataDir,settingsFile,{kind:'file'});diskSettings=JSON.parse(await fsp.readFile(settingsFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return assertUpdateSnapshot({plan,role:plan.role,version:app.getVersion(),isPackaged:app.isPackaged,visible:window.isVisible(),execPath:process.execPath,dataDir:app.getPath('userData'),state,domVersion:await evaluate("document.getElementById('version').textContent"),diskSettings,configHash:plan.mode==='update'?await digest(path.join(plan.dataDir,'netconfig/config.json')):null,sentinelHash:plan.mode==='update'?await digest(path.join(plan.dataDir,'update-sentinel.txt')):null});
 }
 async function capture(name){await require('./desktop-acceptance.cjs').settlePage(window);report.snapshot=await snapshot();const pixels=await window.webContents.capturePage();await fsp.writeFile(path.join(plan.evidenceDir,name+'.png'),pixels.toPNG());report.steps.push({name,screenshot:name+'.png',ok:true});}
 async function clickSelector(selector){
  await cancelled();const result=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);if(element.disabled||!rect.width||!rect.height||rect.top<0||rect.bottom>innerHeight||!hit||(hit!==element&&!element.contains(hit)))return false;element.click();return true;})()`);if(!result)throw Error('实际更新入口不可见或不可点击：'+selector);
 }
 const click=id=>clickSelector('#'+id);
 async function stopWhenRequested(){
  await waitFor(async()=>{try{privatePath(plan.caseRoot,plan.stopFile,{kind:'file'});const stop=JSON.parse(await fsp.readFile(plan.stopFile,'utf8'));return stop.nonce===plan.nonce;}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}},15*60000);await requestQuit();
 }
 try{
  privatePath(plan.caseRoot,plan.evidenceDir,{kind:'directory',missing:true});await fsp.mkdir(plan.evidenceDir,{recursive:true,mode:0o700});await waitFor(()=>!getState().initializing&&getState().version===app.getVersion(),60000);await waitFor(async()=>await evaluate("document.getElementById('version').textContent")===app.getVersion(),60000);report.snapshot=await snapshot();
  if(plan.role==='observe'){
   await capture('01-observed-production-window');report.ok=true;report.observerOnly=true;await atomic(plan.probeFile,report);await stopWhenRequested();return report;
  }
  if(plan.role==='drive'){
   await capture('01-fixture-old-installed-window');await click('check-update');await waitFor(()=>{const status=getState().update;if(status?.state==='error')throw Error('实际更新查新失败：'+status.error);return status?.state==='available';});if(getState().update.release.version!==plan.targetVersion)throw Error('UI 查新未选中精确 CI 版本');await capture('02-ui-available-local-source');await click('download-update');
   await waitFor(()=>{const status=getState().update;if(status?.state==='error')throw Error('实际更新准备失败：'+status.error);return status?.state==='ready'&&getReady()?.ready;});const ready=getReady();if(!ready?.ready||ready.version!==plan.targetVersion)throw Error('实际准备记录缺失');privatePath(plan.dataDir,ready.payloadFile,{kind:'file'});
   await waitFor(async()=>await evaluate("document.getElementById('install-update').getBoundingClientRect().height>0"));await capture('03-verified-ready-local-package');report.ok=true;report.ready={token:ready.token,payloadFile:ready.payloadFile,attempt:ready.attempt,version:ready.version};await atomic(plan.driverFile,report);await click('install-update');report.phase='handoff';await watchInstallHandoff({app,window,getState,waitFor,onFailure:async update=>{report.update=update;await capture('04-original-visible-handoff-failure');}});return report;
  }
  if(plan.role==='confirmed'){
   if(plan.scenario!=='success')throw Error('故障副本错误地完成了正常启动确认');await capture('04-real-updated-visible-window');
  }else if(plan.role==='rollback'){
   const recovery=getState().updateRecovery;if(!recovery?.failed||!recovery.rolledBack||getState().update.state!=='error')throw Error('原 main 没有显示已验证的回滚失败结果');await waitFor(async()=>await evaluate("!document.getElementById('update-modal').classList.contains('hidden')&&document.getElementById('update-message').textContent.includes('已恢复原版本')"));report.recovery=recovery;await capture('05-real-rollback-failure-message');await click('close-update');await waitFor(async()=>await evaluate("document.getElementById('update-modal').classList.contains('hidden')"));
  }else throw Error('CI 观察角色无效');
  await clickSelector('[data-page=guard]');await waitFor(async()=>await evaluate("document.getElementById('page-guard').classList.contains('active')&&document.getElementById('interval-trigger').textContent.includes('17')"));await capture('06-preserved-seventeen-minute-setting');report.ok=true;await atomic(plan.probeFile,report);await stopWhenRequested();return report;
 }catch(error){report.ok=false;report.error=error.message;if(error.captureError)report.captureError=error.captureError;try{await atomic(plan.errorFile,report);}catch{}throw error;}
}
module.exports.updateDesktopAcceptance=updateDesktopAcceptance;

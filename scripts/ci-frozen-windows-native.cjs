'use strict';
// Supplemental acceptance only. It installs the already frozen CI artifact,
// drives its normal UI through shipped IPC, and never rebuilds candidate bytes.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {runProcess}=require('../src/platform/common.cjs');
const {installationMetadata,uninstallCiApplication,processIdentity}=require('./ci-electron-update.cjs');
const {spawn}=require('node:child_process'),net=require('node:net'),{pathToFileURL}=require('node:url');
const ASSETS={
 'nettools-5.0.1-win-x64-setup.exe':{size:114206186,sha256:'49bb9360141f964346a538e02cc11c0072d9d81a4404765826a743c1b599b66a'},
 'nettools-5.0.1-win-x64.zip':{size:155501826,sha256:'15a37c88b11a50d50e3f4b499b8cb9b9aefc50bb502442a1caf77a53343ef25d'}
};
async function digest(file){return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function find(root,name){const matches=[];async function walk(dir,depth){if(depth>8)throw Error('Artifact layout exceeded');for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Unexpected artifact symlink');const p=path.join(dir,e.name);if(e.isDirectory())await walk(p,depth+1);else if(e.name===name)matches.push(p);}}await walk(root,0);if(matches.length!==1)throw Error('Expected one exact frozen asset: '+name);return matches[0];}
async function compare(reference,installed){let count=0;async function walk(relative){const source=path.join(reference,relative),target=path.join(installed,relative),st=await fs.lstat(source);if(st.isSymbolicLink())throw Error('Unexpected portable symlink');if(st.isDirectory()){for(const name of await fs.readdir(source))await walk(path.join(relative,name));}else{const actual=await fs.lstat(target);if(!actual.isFile()||actual.size!==st.size||await digest(source)!==await digest(target))throw Error('Installed candidate differs at '+relative);count++;}}await walk('');return count;}
// CDP is an external, runner-only driver. No shipped file or preload is patched.
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,timeoutMs=90000){const end=Date.now()+timeoutMs;while(Date.now()<end){const result=await check();if(result)return result;await pause(100);}throw Error('Frozen normal UI acceptance timeout');}
function launchConfig(data,port,environment){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid loopback debugging port');
 const env={...environment};for(const key of Object.keys(env))if(/^NETTOOLS_/i.test(key)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase()))delete env[key];
 return {args:['--nettools-data='+data,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],env};
}
function cleanupConfirmed(state){return state.uninstalled===true&&state.grantRemoved===true&&state.appHandleClosed===true&&state.processQuerySucceeded===true&&Array.isArray(state.remainingProcesses)&&state.remainingProcesses.length===0;}
class Cdp{
 static async connect(url){
  const endpoint=new URL(url);if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||!endpoint.port)throw Error('CDP requires runner loopback endpoint');
  const socket=new WebSocket(url),client=new Cdp(socket);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(Error('CDP connect timeout'));},10000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP connection failed'));},{once:true});});return client;
 }
 constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();socket.addEventListener('message',event=>{let message;try{message=JSON.parse(event.data);}catch{return;}const job=this.pending.get(message.id);if(!job)return;this.pending.delete(message.id);clearTimeout(job.timer);if(message.error)job.reject(Error('CDP: '+message.error.message));else job.resolve(message.result);});const closed=()=>{for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(Error('CDP connection closed'));}this.pending.clear();};socket.addEventListener('close',closed);socket.addEventListener('error',closed);}
 send(method,params={},timeoutMs=15000){return new Promise((resolve,reject)=>{if(this.socket.readyState!==WebSocket.OPEN)return reject(Error('CDP connection closed'));const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP '+method+' timeout'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
 close(){this.socket.close();}
 async evaluate(expression){const result=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error('Normal renderer evaluation failed: '+(result.exceptionDetails.exception?.description||result.exceptionDetails.text));return result.result?.value;}
}
async function freePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function debuggingJson(port,route){const response=await fetch('http://127.0.0.1:'+port+route,{signal:AbortSignal.timeout(2000),redirect:'error'});if(!response.ok)throw Error('CDP discovery failed');return response.json();}
const POWERSHELL_HEADER="$ErrorActionPreference='Stop';$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine');[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);";
async function ps(script){const executable=path.win32.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');return runProcess(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(POWERSHELL_HEADER+script,'utf16le').toString('base64')],{timeoutMs:30000,maxOutput:65536});}
async function expandPortable(archive,destination,{executable=path.win32.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')}={}){
 const quote=value=>"'"+value.replaceAll("'","''")+"'",script=POWERSHELL_HEADER+"$ProgressPreference='SilentlyContinue';"+`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)}`;
 return runProcess(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeoutMs:180000,maxOutput:32768});
}
async function cleanupInstallation({platform,grantMayExist,grantRemoved,uninstalled,original,report,install,data},{metadata=installationMetadata,uninstall=uninstallCiApplication}={}){
 // Before the bridge is loaded, this suite has never started authorization.
 // A loaded or timed-out authorizer must retain its separately verified state.
 if(!platform&&!grantMayExist)grantRemoved=true;
 if(!uninstalled&&original&&grantRemoved&&report.appHandleClosed&&report.beforeCleanupProcesses?.length===0){try{report.failureUninstall=await uninstall(install,data,original,'5.0.1');uninstalled=true;}catch(error){report.uninstallError=error.message;}}
 if(!original&&!uninstalled){try{original=await metadata(install);if(original.displayVersion==='5.0.1'&&report.appHandleClosed&&grantRemoved&&report.beforeCleanupProcesses?.length===0){report.failureUninstall=await uninstall(install,data,original,'5.0.1');uninstalled=true;}}catch(error){report.partialInstallCleanupError=error.message;}}
 return {grantRemoved,uninstalled,original};
}
function suiteProcessScript(roots){
 const quoted=roots.map(root=>"'"+root.replaceAll("'","''")+"'").join(',');
 return `$roots=@(${quoted});$all=@(Get-CimInstance Win32_Process);$owned=@{};foreach($item in $all){if($item.ProcessId -eq $PID -or $item.ProcessId -eq ${process.pid}){continue};$command=[string]$item.CommandLine;$match=[regex]::Match($command,'(?i)-EncodedCommand\\s+([a-z0-9+/=]+)');if($match.Success){$command=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($match.Groups[1].Value))};foreach($root in $roots){if($command.Contains($root)){$owned[[int]$item.ProcessId]=$item;break}}};do{$changed=$false;foreach($item in $all){if($item.ProcessId -eq $PID -or $item.ProcessId -eq ${process.pid}){continue};if(!$owned.ContainsKey([int]$item.ProcessId) -and $owned.ContainsKey([int]$item.ParentProcessId)){$owned[[int]$item.ProcessId]=$item;$changed=$true}}}while($changed);$rows=@();foreach($item in $owned.Values){$handle=$null;try{$handle=[Diagnostics.Process]::GetProcessById([int]$item.ProcessId);if(!$handle.HasExited){$rows+=@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;command=[string]$item.CommandLine;created=$handle.StartTime.ToUniversalTime().Ticks.ToString()}}}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if($cause -isnot [ArgumentException]){throw}}finally{if($handle){$handle.Dispose()}}};[Console]::Out.WriteLine((@{rows=$rows}|ConvertTo-Json -Compress))`;
}
async function suiteProcesses(roots){const result=await ps(suiteProcessScript(roots));return JSON.parse(result.stdout).rows;}
function terminationScript(item){
 if(!Number.isInteger(item.pid)||item.pid<2||!/^\d{18}$/.test(item.created))throw Error('Unsafe suite process identity');
 return `$p=$null;try{$p=[Diagnostics.Process]::GetProcessById(${item.pid})}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if($cause -is [ArgumentException]){exit 0};throw};try{if(!$p.HasExited -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${item.created}'){$p.Kill();if(!$p.WaitForExit(10000)){throw 'Owned process handle still open'}}}finally{$p.Dispose()}`;
}
async function terminateOwned(item){await ps(terminationScript(item));}
async function authorizationReceipt(status,mode,evidence){
 const file=path.join(path.dirname(status.resultFiles['flush-dns']),'authorization-result.json'),bytes=await fs.readFile(file);if(bytes.length>32768)throw Error('Authorization receipt oversized');const result=JSON.parse(bytes),completion=result.authorization;
 if(result.ok!==true||result.data?.mode!==mode||result.data.version!=='5.0.1'||result.data.installed!==(mode==='install')||completion?.mode!==mode||completion.CallerSid!==status.sid||completion.closed!==true||!['direct','child'].includes(completion.execution)||!/^[a-f0-9-]{36}$/.test(completion.nonce))throw Error('Actual authorization receipt not bound to this UI operation');
 await fs.writeFile(path.join(evidence,'authorization-'+mode+'.json'),bytes);return {ok:true,mode,execution:completion.execution,closed:completion.closed,sidBound:true,sha256:await digest(file),closureProof:'receipt plus ordinary UI business success after shipped bridge awaited original authorization Process close'};
}
async function debugListener(port,pid){
 const result=await ps(`$rows=@(Get-NetTCPConnection -State Listen -LocalPort ${port}|ForEach-Object{@{address=$_.LocalAddress;pid=[int]$_.OwningProcess}});[Console]::Out.WriteLine((@{rows=$rows}|ConvertTo-Json -Compress))`),rows=JSON.parse(result.stdout).rows;
 if(!rows.length||rows.some(item=>item.pid!==pid||!['127.0.0.1','::1'].includes(item.address)))throw Error('Actual CDP listener is not bound exclusively to original PID and loopback');return rows;
}
async function verifySystemTask(status,installedWorkerSha256,evidence){
 if(!/^S-1-5-(?:\d+-)*\d+$/.test(status.sid))throw Error('Invalid actual grant SID');
 const root=path.dirname(status.resultFiles['flush-dns']),worker=path.join(root,'windows-network.ps1'),taskPath='\\LaoyuNetTools\\'+status.sid+'\\',quote=value=>"'"+value.replaceAll("'","''")+"'";
 const query=await ps(`$tasks=@(Get-ScheduledTask -TaskPath ${quote(taskPath)} -TaskName 'flush-dns');if($tasks.Count -ne 1){throw 'Exact SYSTEM task not unique'};$t=$tasks[0];[Console]::Out.WriteLine((@{taskPath=$t.TaskPath;taskName=$t.TaskName;state=[string]$t.State;principal=@{userId=$t.Principal.UserId;logonType=[string]$t.Principal.LogonType;runLevel=[string]$t.Principal.RunLevel};actions=@($t.Actions|ForEach-Object{@{execute=$_.Execute;arguments=$_.Arguments;workingDirectory=$_.WorkingDirectory}})}|ConvertTo-Json -Depth 5 -Compress))`);
 const task=JSON.parse(query.stdout),action=task.actions?.[0],expectedArguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+worker+'" -WorkerAction flush-dns -GrantSid '+status.sid;
 const samePath=(a,b)=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
 if(task.taskPath!==taskPath||task.taskName!=='flush-dns'||!['Ready','Disabled'].includes(task.state)||!['SYSTEM','S-1-5-18'].includes(task.principal?.userId)||task.principal.logonType!=='ServiceAccount'||task.principal.runLevel!=='Highest'||task.actions?.length!==1||!samePath(action.execute,path.win32.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'))||action.arguments!==expectedArguments||!samePath(action.workingDirectory,root))throw Error('Actual SYSTEM task action/principal/state does not match this installed grant');
 const manifestBytes=await fs.readFile(path.join(root,'grant.json'));if(manifestBytes.length>32768)throw Error('Grant manifest oversized');const manifest=JSON.parse(manifestBytes),workerSha256=await digest(worker);
 if(manifest.sid!==status.sid||manifest.version!=='5.0.1'||manifest.scriptSha256!==workerSha256||workerSha256!==installedWorkerSha256)throw Error('Actual SYSTEM worker is not the exact installed script');
 const identity={task,manifest,workerSha256,installedWorkerSha256};await fs.writeFile(path.join(evidence,'actual-system-task-identity.json'),JSON.stringify(identity,null,2)+'\n');return identity;
}
async function grantResidue(status){
 if(!/^S-1-5-(?:\d+-)*\d+$/.test(status.sid))throw Error('Actual grant SID invalid');
 const quote=value=>"'"+value.replaceAll("'","''")+"'",root=path.dirname(status.resultFiles['flush-dns']),taskPath='\\LaoyuNetTools\\'+status.sid+'\\';
 const result=await ps(`$tasks=@(Get-ScheduledTask|Where-Object{$_.TaskPath -eq ${quote(taskPath)}});[Console]::Out.WriteLine((@{tasks=@($tasks|ForEach-Object{$_.TaskName});manifest=(Test-Path -LiteralPath ${quote(path.join(root,'grant.json'))});worker=(Test-Path -LiteralPath ${quote(path.join(root,'windows-network.ps1'))})}|ConvertTo-Json -Compress))`),value=JSON.parse(result.stdout);
 return {...value,removed:!value.manifest&&!value.worker&&value.tasks.length===0};
}
async function bounded(promise,timeoutMs,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(message)),timeoutMs))]);}finally{clearTimeout(timer);}}
async function visibleWindow(pid){const value=await ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FrozenWindow{[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);}';$p=[Diagnostics.Process]::GetProcessById(${pid});try{[Console]::Out.WriteLine((@{handle=$p.MainWindowHandle.ToInt64().ToString();visible=[FrozenWindow]::IsWindowVisible($p.MainWindowHandle)}|ConvertTo-Json -Compress))}finally{$p.Dispose()}`);return JSON.parse(value.stdout);}
function normalApp(executable,config,logFile){
 const child=spawn(executable,config.args,{env:config.env,shell:false,windowsHide:false,stdio:['ignore','pipe','pipe']});let ended=false,output=Buffer.alloc(0);const collect=chunk=>{output=Buffer.concat([output,chunk]);if(output.length>262144)output=output.subarray(output.length-262144);};child.stdout.on('data',collect);child.stderr.on('data',collect);
 let failure;const closed=new Promise((resolve,reject)=>{child.once('error',error=>failure=error);child.once('close',(code,signal)=>{ended=true;if(failure)reject(failure);else resolve({code,signal});});});closed.catch(()=>{});
 return {child,closed,get ended(){return ended;},save:()=>fs.writeFile(logFile,output)};
}
async function uiState(cdp){return cdp.evaluate(`(async()=>{const snapshot=await window.nettools.snapshot(),logs=await window.nettools.logs();const shown=id=>{const e=document.getElementById(id);return !!e&&!e.classList.contains('hidden')&&e.getClientRects().length>0;};return {snapshot,logs,ui:{url:location.href,version:document.getElementById('version').textContent,page:document.querySelector('.page.active')?.id,auth:document.getElementById('auth-status').textContent,busyBanner:shown('busy-banner'),busyText:document.getElementById('busy-text').textContent,rendererBusy:busy,guardEnabled:document.getElementById('guard-enabled').checked,restartEnabled:document.getElementById('restart-enabled').checked,loginEnabled:document.getElementById('login-enabled').checked}};})()`);}
function safeState(value){const s=value.snapshot;if(s.version!=='5.0.1'||value.ui.version!=='5.0.1'||s.platform!=='win32'||s.smoke!==false||s.updateFixture||s.settings?.enabled!==false||s.settings?.restartOnTimeout!==false||s.settings?.launchAtLogin!==false||value.ui.guardEnabled||value.ui.restartEnabled||value.ui.loginEnabled)throw Error('Normal frozen app identity or safety settings mismatch');}
async function click(cdp,selector){await cdp.evaluate(`(()=>{const matches=document.querySelectorAll(${JSON.stringify(selector)});if(matches.length!==1)throw Error('Expected one ordinary UI control');const button=matches[0];if(button.disabled||!button.getClientRects().length)throw Error('Ordinary control is hidden or disabled');button.scrollIntoView({block:'center'});button.click();return true;})()`);}
async function screenshot(cdp,evidence,name){const value=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const buffer=Buffer.from(value.data,'base64');if(buffer.length<100||buffer.length>8*1024*1024)throw Error('Invalid normal UI screenshot');await fs.writeFile(path.join(evidence,name+'.png'),buffer);}
async function evidenceState(cdp,evidence,name){const value=await uiState(cdp);safeState(value);await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await screenshot(cdp,evidence,name);await fs.writeFile(path.join(evidence,name+'.json'),JSON.stringify(value,null,2)+'\n');return value;}
async function navigate(cdp,page){await click(cdp,'[data-page="'+page+'"]');await waitFor(async()=>{const value=await uiState(cdp);return value.ui.page==='page-'+page&&value;},10000);}
async function uiAction(cdp,evidence,action,installed){
 const before=await uiState(cdp),offset=before.logs.entries.length,observations=[];safeState(before);if(before.ui.rendererBusy||before.ui.busyBanner||before.snapshot.operation)throw Error('Ordinary UI was busy before action');
 await click(cdp,'[data-action="'+action+'"]');
 const value=await waitFor(async()=>{const state=await uiState(cdp);safeState(state);if(observations.length<40)observations.push({at:new Date().toISOString(),operation:state.snapshot.operation?.action||null,busy:state.ui.busyBanner,rendererBusy:state.ui.rendererBusy,auth:state.ui.auth});const rows=state.logs.entries.slice(offset).filter(row=>row.action===action);const failure=rows.find(row=>row.ok===false);if(failure)throw Error('Actual ordinary IPC failed: '+action+' '+(failure.code||''));const started=rows.some(row=>row.phase==='started'),success=rows.find(row=>row.ok===true&&row.phase!=='started');return started&&success&&!state.ui.rendererBusy&&!state.ui.busyBanner&&!state.snapshot.operation&&state.snapshot.authorization.installed===installed&&state;},180000);
 if(value.ui.auth!==(installed?'已授权':'未授权'))throw Error('Ordinary authorization UI mismatch');
 await evidenceState(cdp,evidence,action);return {ok:true,via:'ordinary DOM click -> shipped preload -> controller IPC',businessLogSuccess:true,installed,observations};
}
async function run(){
 if(process.platform!=='win32'||process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||!process.env.RUNNER_TEMP)throw Error('Actual isolated Windows runner required');
 const artifact=path.resolve(process.argv[2]||''),runner=await fs.realpath(process.env.RUNNER_TEMP);
 const suite=await fs.mkdtemp(path.join(runner,'nettools-frozen-native-')),install=path.join(suite,'Installed','LaoyuNetTools'),data=path.join(suite,'data'),portable=path.join(suite,'portable');
 const evidence=path.resolve(__dirname,'../verification/frozen-501/windows-native');await fs.mkdir(evidence,{recursive:true});await fs.mkdir(data,{mode:0o700});
 const report={sourceHead:'ac1597a5956386c4f7f5dd101ed9fd247085c4bb',sourceRun:38337392645,sourceArtifact:11784644714,version:'5.0.1',scope:'Frozen installer and normal visible installed Electron UI through shipped preload/controller IPC: SYSTEM grant, DNS cache flush and revocation; external native bridge only read-only corroboration or failure cleanup; no adapter/proxy/DNS server/VPN changes, reboot or feedback',assets:[],steps:[],ok:false};
 let platform,grantMayExist=false,grantRemoved=false,original,uninstalled=false,app,cdp,browser,beforeGrant;const processRoots=[suite];const owned=()=>suiteProcesses(processRoots);report.appHandleClosed=true;
 async function step(name,fn,verify=()=>({ok:true})){report.currentStep=name;const start=Date.now(),value=await fn();report.steps.push({name,durationMs:Date.now()-start,...verify(value)});return value;}
 try{
  const files={};for(const [name,expected]of Object.entries(ASSETS)){const file=await find(artifact,name),size=(await fs.stat(file)).size,sha256=await digest(file);if(size!==expected.size||sha256!==expected.sha256)throw Error('Frozen asset integrity mismatch');files[name]=file;report.assets.push({name,size,sha256});}
  process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT=install;try{await step('actual-visible-frozen-installer',()=>runProcess(files['nettools-5.0.1-win-x64-setup.exe'],[],{timeoutMs:240000,maxOutput:1048576}));}finally{delete process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT;}
  const installerEvidence=path.join(runner,'nettools-installer-evidence');await fs.cp(installerEvidence,path.join(evidence,'installer'),{recursive:true});const ui=JSON.parse(await fs.readFile(path.join(installerEvidence,'installer-report.json'),'utf8'));if(!ui.ok||!ui.visible||ui.desktopSelected!==false||ui.version!=='5.0.1'||path.resolve(ui.installRoot).toLowerCase()!==install.toLowerCase())throw Error('Actual visible installer identity failed');report.installer=ui;
  original=await installationMetadata(install);if(original.displayVersion!=='5.0.1')throw Error('Installed registration version mismatch');
  await step('expand-frozen-portable-archive',()=>expandPortable(files['nettools-5.0.1-win-x64.zip'],portable));
  report.installedFilesMatchedFrozenPortable=await step('compare-frozen-portable-installation',()=>compare(portable,install),count=>({ok:true,filesMatched:count}));
  const platformDir=path.join(install,'resources/app/src/platform');
  const pkg=JSON.parse(await fs.readFile(path.join(install,'resources/app/package.json'),'utf8'));if(pkg.version!=='5.0.1')throw Error('Actual installed package version mismatch');
  platform=require(path.join(platformDir,'windows.cjs')).createWindowsPlatform({configDir:path.join(data,'netconfig'),resourcesDir:platformDir});
  report.nativeFiles={};for(const name of ['windows.cjs','windows-network.ps1','windows-authorization.ps1'])report.nativeFiles[name]=await digest(path.join(platformDir,name));
  beforeGrant=await step('installed-authorization-before',()=>platform.invoke('helper-status'),v=>{if(v.installed)throw Error('Runner has an existing grant');return {ok:true,installed:false};});grantRemoved=true;processRoots.push(path.dirname(beforeGrant.resultFiles['flush-dns']));report.processScopeRoots=processRoots;
  report.currentStep='normal-installed-exe-launch';
  const executable=path.join(install,'LaoyuNetTools.exe'),port=await freePort(),config=launchConfig(data,port,process.env);
  report.launch={executable,args:config.args,visibleRequested:true,acceptanceMode:false,debuggingScope:'127.0.0.1 isolated GitHub Windows runner only'};
  app=normalApp(executable,config,path.join(evidence,'normal-process.log'));report.appHandleClosed=false;
  report.pid=app.child.pid;report.identity=await processIdentity(report.pid);if(!report.identity.exists||path.resolve(report.identity.executable).toLowerCase()!==executable.toLowerCase()||!report.identity.command.includes('--nettools-data='+data))throw Error('Actual installed EXE process identity mismatch');
  let discovered;
  try{discovered=await waitFor(async()=>{if(app.ended)throw Error('Frozen normal app exited before CDP attachment');try{return await debuggingJson(port,'/json/version');}catch{return false;}},30000);}catch(error){throw Error('Frozen normal installed EXE did not expose loopback CDP; flags unavailable or startup failed: '+error.message);}
  if(new URL(discovered.webSocketDebuggerUrl).port!==String(port))throw Error('CDP discovery port mismatch');browser=await Cdp.connect(discovered.webSocketDebuggerUrl);
  const info=await browser.send('SystemInfo.getProcessInfo');if(!info.processInfo.some(item=>item.type==='browser'&&Number(item.id)===report.pid))throw Error('CDP browser is not original installed EXE PID');report.browserPidBound=true;report.debugListener=await debugListener(port,report.pid);
  const expectedUrl=pathToFileURL(path.join(install,'resources/app/ui/index.html')).href;
  const target=await waitFor(async()=>{const pages=await debuggingJson(port,'/json/list');const matches=pages.filter(item=>item.type==='page'&&item.url.toLowerCase()===expectedUrl.toLowerCase());if(matches.length>1)throw Error('Ambiguous frozen installed UI target');return matches[0];},30000);
  if(new URL(target.webSocketDebuggerUrl).port!==String(port))throw Error('CDP page port mismatch');cdp=await Cdp.connect(target.webSocketDebuggerUrl);report.renderer={targetId:target.id,fileUrl:target.url,expectedFileUrl:expectedUrl};await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await waitFor(async()=>{const state=await uiState(cdp);return !state.snapshot.initializing&&!state.ui.busyBanner&&!state.ui.rendererBusy&&state;});
  report.window=await visibleWindow(report.pid);if(!report.window.visible||report.window.handle==='0')throw Error('Original normal installed app window is not visible');
  await navigate(cdp,'guard');const initial=await evidenceState(cdp,evidence,'01-normal-guard-before');if(initial.ui.url.toLowerCase()!==expectedUrl.toLowerCase())throw Error('Public snapshot renderer URL is not installed UI');if(initial.snapshot.authorization.installed||initial.ui.auth!=='未授权')throw Error('Existing runner authorization');grantRemoved=true;
  grantMayExist=true;grantRemoved=false;
  await step('ordinary-ui-install-authorization',()=>uiAction(cdp,evidence,'install-helper',true),value=>value);
  report.authorizationInstall=await authorizationReceipt(beforeGrant,'install',evidence);report.authorizationParentProcessesAfterInstall=(await owned()).filter(item=>item.command.includes('windows-authorization.ps1'));if(report.authorizationParentProcessesAfterInstall.length)throw Error('Original authorization parent still running after UI success');
  const authorized=await step('readonly-installed-system-grant',()=>platform.invoke('helper-status'),v=>{if(!v.installed||v.version!=='5.0.1')throw Error('Actual installed SYSTEM grant mismatch');return {ok:true,installed:true,version:v.version};});
  await navigate(cdp,'repair');await step('ordinary-ui-actual-dns-cache-flush',()=>uiAction(cdp,evidence,'flush-dns',true),value=>value);
  const requestBytes=await fs.readFile(authorized.requestFile),resultBytes=await fs.readFile(authorized.resultFiles['flush-dns']);if(requestBytes.length>32768||resultBytes.length>32768)throw Error('Actual SYSTEM evidence oversized');const request=JSON.parse(requestBytes),result=JSON.parse(resultBytes);
  if(request.action!=='flush-dns'||request.version!=='5.0.1'||!/^[a-f0-9-]{36}$/.test(request.nonce)||result.nonce!==request.nonce||result.ok!==true)throw Error('Actual SYSTEM task result does not bind ordinary UI cache flush');
  await fs.writeFile(path.join(evidence,'actual-flush-request.json'),requestBytes);await fs.writeFile(path.join(evidence,'actual-flush-result.json'),resultBytes);
  const systemIdentity=await verifySystemTask(authorized,report.nativeFiles['windows-network.ps1'],evidence);report.systemFlush={ok:true,nonceBound:true,nonce:request.nonce,requestAction:request.action,resultSha256:await digest(authorized.resultFiles['flush-dns']),finalTaskState:systemIdentity.task.state,exactTaskIdentityVerified:true};
  await navigate(cdp,'guard');await step('ordinary-ui-revoke-authorization',()=>uiAction(cdp,evidence,'uninstall-helper',false),value=>value);
  report.authorizationUninstall=await authorizationReceipt(beforeGrant,'uninstall',evidence);report.authorizationParentProcessesAfterUninstall=(await owned()).filter(item=>item.command.includes('windows-authorization.ps1'));if(report.authorizationParentProcessesAfterUninstall.length)throw Error('Original authorization parent still running after revocation success');
  await step('readonly-installed-grant-removed',()=>platform.invoke('helper-status'),v=>{if(v.installed)throw Error('Grant remains');return {ok:true,installed:false};});grantMayExist=false;const removed=await grantResidue(beforeGrant);report.actualGrantRemoval=removed;if(!removed.removed)throw Error('Actual authorization tasks or grant worker remain');grantRemoved=true;
  await evidenceState(cdp,evidence,'04-before-ordinary-exit');await click(cdp,'#quit-app');
  const exit=await bounded(app.closed,30000,'Original app close handle did not complete');if(exit.code!==0)throw Error('Ordinary app exit was not clean');report.normalExit={...exit,originalHandleClosed:true,via:'ordinary quit-app button'};report.appHandleClosed=true;await app.save();
  cdp.close();cdp=null;browser.close();browser=null;
  await waitFor(async()=>!(await owned()).length,30000);report.beforeUninstallProcesses=await owned();if(report.beforeUninstallProcesses.length)throw Error('Suite process still running before uninstall');
  report.installedFilesMatchedAfterUi=await compare(portable,install);
  report.uninstall=await uninstallCiApplication(install,data,original,'5.0.1');uninstalled=true;
  report.remainingProcesses=await owned();if(report.remainingProcesses.length)throw Error('Owned processes remain');report.ok=true;
 }catch(e){report.error={code:e.code||'ACCEPTANCE_FAILED',message:e.message,stdout:String(e.stdout||'').slice(-4000),stderr:String(e.stderr||'').slice(-4000)};throw e;}
 finally{
  // Save bounded actual renderer evidence before shutting down a failed run.
  if(cdp){try{await screenshot(cdp,evidence,'failure-last-visible');await fs.writeFile(path.join(evidence,'failure-last-state.json'),JSON.stringify(await uiState(cdp),null,2)+'\n');}catch(error){report.failureEvidenceError=error.message;}}
  if(app&&!app.ended&&cdp){try{await click(cdp,'#quit-app');await bounded(app.closed,15000,'Failure ordinary exit timeout');}catch(error){report.failureNormalExitError=error.message;}}
  if(cdp)cdp.close();if(browser)browser.close();
  if(app&&!app.ended){try{for(const item of await owned())await terminateOwned(item);await bounded(app.closed,10000,'Original process handle still open');report.failureForcedExit=true;}catch(error){report.processCleanupError=error.message;}}
  if(app){report.appHandleClosed=app.ended;try{await app.save();}catch(error){report.processLogError=error.message;}}
  try{const log=await fs.readFile(path.join(data,'logs/operations.jsonl'));await fs.writeFile(path.join(evidence,'actual-operations.jsonl'),log.subarray(Math.max(0,log.length-262144)));}catch(error){if(error.code!=='ENOENT')report.operationLogError=error.message;}
  try{
   // Terminate only identities proven to be owned by this private suite.
   const remaining=await owned();report.failureProcessesBeforeTermination=remaining;for(const item of remaining)await terminateOwned(item);
   await waitFor(async()=>!(await owned()).length,15000);report.beforeCleanupProcesses=await owned();
  }catch(error){report.processCleanupError=error.message;}
  // External bridge may revoke a failed UI attempt only after app/helper exit.
  if(platform&&!uninstalled&&report.appHandleClosed&&report.beforeCleanupProcesses?.length===0){
   try{
    if(grantMayExist){
     const abort=new AbortController(),pending=platform.invoke('uninstall-helper',{}, {signal:abort.signal});pending.catch(()=>{});
     try{await bounded(pending,90000,'Failure grant revocation timed out');}
     catch(error){abort.abort();report.cleanupAuthorizerTimedOut=error.message==='Failure grant revocation timed out';if(report.cleanupAuthorizerTimedOut){for(const item of await owned())await terminateOwned(item);try{await bounded(pending,10000,'Aborted grant operation did not settle');}catch(settle){report.cleanupAuthorizerSettleError=settle.message;}}throw error;}
    }
    const status=await platform.invoke('helper-status');grantRemoved=!status.installed;if(grantRemoved&&beforeGrant){const residue=await grantResidue(beforeGrant);report.failureGrantResidue=residue;grantRemoved=residue.removed;}report.failureGrantCleanup=grantRemoved;
   }catch(error){grantRemoved=false;report.failureGrantCleanup=false;report.cleanupError=error.code||error.message;}
  }
  ({grantRemoved,uninstalled,original}=await cleanupInstallation({platform,grantMayExist,grantRemoved,uninstalled,original,report,install,data}));
  try{report.remainingProcesses=await owned();report.processQuerySucceeded=true;}catch(error){report.processQuerySucceeded=false;report.finalProcessQueryError=error.message;}
  report.uninstalled=uninstalled;report.grantRemoved=grantRemoved;report.finishedAt=new Date().toISOString();report.cleanupConfirmed=cleanupConfirmed(report);report.ok=report.ok&&report.cleanupConfirmed;
  if(report.cleanupConfirmed){try{await fs.rm(suite,{recursive:true,force:true});report.privateFixtureRemoved=true;}catch(error){report.privateFixtureRemoved=false;report.fixtureRemovalError=error.message;report.ok=false;}}else report.privateFixtureRemoved=false;
  await fs.writeFile(path.join(evidence,'native-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  // A timed-out cleanup remains unconfirmed: preserve the install and fixture.
  // Stop only this isolated driver so its completed failure report is uploaded,
  // even if a frozen bridge lease remains pending after abort and bounded kill.
  if(report.cleanupAuthorizerTimedOut)process.exit(1);
  if(!report.ok)process.exitCode=1;
 }
}
module.exports={Cdp,launchConfig,cleanupConfirmed,suiteProcessScript,terminationScript,expandPortable,cleanupInstallation};
if(require.main===module)run().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});

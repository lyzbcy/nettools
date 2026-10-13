'use strict';
// Verification wrapper only: replay the immutable candidate, then observe the
// restored 5.0.1 through its normal UI without changing shipped files.
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {runProcess}=require('../src/platform/common.cjs');
const {startCiApp}=require('./ci-app-process.cjs');
const {runElectronUpdateAcceptance,ownedProcesses,processIdentity,fingerprint}=require('./ci-electron-update.cjs');
const {Cdp,launchConfig}=require('./ci-frozen-windows-native.cjs');
const ZIP={arm64:{size:131361919,sha256:'4ee757b30722505be6c8ce7c4ff6fe8bd847b1647a2eef76d423c2743d180cce'},x64:{size:137053666,sha256:'ec9be178deeeb76cc54f08f8cc42bd8e37751e03c861b7739674e00e32e185a2'}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(check,limit=90000){const end=Date.now()+limit;while(Date.now()<end){const result=await check();if(result)return result;await pause(100);}throw Error('Frozen Mac observation timeout');}
async function digest(file){return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
async function oneFile(root,name){const found=[];async function walk(dir,depth){if(depth>8)throw Error('Artifact depth');for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Unexpected artifact symlink');const p=path.join(dir,e.name);if(e.isDirectory())await walk(p,depth+1);else if(e.name===name)found.push(p);}}await walk(root,0);if(found.length!==1)throw Error('Exact candidate ZIP not unique');return found[0];}
async function port(){const server=net.createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function discovery(p,route){const r=await fetch('http://127.0.0.1:'+p+route,{redirect:'error',signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Discovery status');return r.json();}
async function deadline(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,j)=>timer=setTimeout(()=>j(Error('Original process close timeout')),ms))]);}finally{clearTimeout(timer);}}
async function run(){
 if(process.platform!=='darwin'||!ZIP[process.arch]||process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||!process.env.RUNNER_TEMP)throw Error('Isolated actual Mac runner required');
 const expected=ZIP[process.arch],runner=await fs.realpath(process.env.RUNNER_TEMP),suite=await fs.mkdtemp(path.join(runner,'nettools-frozen-rollback.noindex-')),unpacked=path.join(suite,'candidate'),install=path.join(suite,'捞鱼的网络工具.app'),data=path.join(suite,'data'),evidence=path.resolve(__dirname,'../verification/frozen-501/macos-'+process.arch);
 await fs.mkdir(evidence,{recursive:true});await fs.mkdir(unpacked,{mode:0o700});await fs.mkdir(data,{mode:0o700});
 const report={sourceHead:'ac1597a5956386c4f7f5dd101ed9fd247085c4bb',originalRun:38337392645,version:'5.0.1',arch:process.arch,scope:'Immutable Mac ZIP and actual local-fixture update/rollback, then normally reopened restored 5.0.1 guard UI; not a historical published upgrade or first-download quarantine test',ok:false};let actor,normal,cdp,browser,closed=false,cleanupReady=false;
 try{
  const archive=await oneFile(path.resolve(process.argv[2]),'nettools-5.0.1-mac-'+process.arch+'.zip');if((await fs.stat(archive)).size!==expected.size||await digest(archive)!==expected.sha256)throw Error('Frozen original ZIP integrity mismatch');report.asset={name:path.basename(archive),...expected};
  await runProcess('/usr/bin/ditto',['-x','-k',archive,unpacked],{timeoutMs:120000});const originalApp=path.join(unpacked,'捞鱼的网络工具.app');await runProcess('/usr/bin/codesign',['--verify','--deep','--strict',originalApp]);await runProcess('/usr/bin/ditto',[originalApp,install],{timeoutMs:120000});
  const pack={candidate:true,version:'5.0.1',platform:'darwin',arch:process.arch,verifiedDirectory:unpacked,assets:[{name:path.basename(archive),file:archive,...expected}]};
  report.originalDirectorySha256=await fingerprint(unpacked);
  const desktop=path.join(evidence,'initial-desktop');actor=startCiApp(path.join(install,'Contents/MacOS/LaoyuNetTools'),['--nettools-data='+data],{env:{...process.env,NETTOOLS_ACCEPTANCE_DIR:desktop},timeoutMs:180000,logFile:path.join(suite,'initial.log')});await actor.closed;actor=null;
  const initial=JSON.parse(await fs.readFile(path.join(desktop,'desktop-report.json'),'utf8'));if(!initial.ok||!initial.visible||!initial.packaged)throw Error('Original candidate desktop did not save actual 17-minute setting');
  const update=await runElectronUpdateAcceptance({installPath:install,dataDir:data,suiteRoot:suite,packageReport:pack,reportDir:path.join(evidence,'update')});if(!update.ok||!update.cleanupConfirmed||update.cases.length!==2||update.cases[1].scenario!=='rollback'||!update.cases[1].rolledBack)throw Error('Actual candidate rollback not verified');report.update=update;
  const files=['settings.json','netconfig/config.json','update-sentinel.txt'],preserved={};for(const f of files)preserved[f]=await digest(path.join(data,f));
  const installedPkg=JSON.parse(await fs.readFile(path.join(install,'Contents/Resources/app/package.json'),'utf8'));if(installedPkg.version!=='5.0.1')throw Error('Rollback did not restore actual candidate version');await runProcess('/usr/bin/codesign',['--verify','--deep','--strict',install]);
  const p=await port(),config=launchConfig(data,p,process.env),exe=path.join(install,'Contents/MacOS/LaoyuNetTools');normal=spawn(exe,config.args,{env:config.env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});let output=Buffer.alloc(0);const collect=b=>{output=Buffer.concat([output,b]);if(output.length>262144)output=output.subarray(-262144);};normal.stdout.on('data',collect);normal.stderr.on('data',collect);
  const exited=new Promise((r,j)=>{normal.once('error',j);normal.once('close',(code,signal)=>{closed=true;r({code,signal});});});exited.catch(()=>{});normal.closed=exited;normal.savedLog=()=>fs.writeFile(path.join(evidence,'normal-reopen-process.log'),output);
  report.reopen={pid:normal.pid,identity:await processIdentity(normal.pid),args:config.args,fixtureFlagsRemoved:true};if(!report.reopen.identity.command.includes(exe)||!report.reopen.identity.command.includes('--nettools-data='+data))throw Error('Normal restored app process identity mismatch');
  const info=await wait(async()=>{try{return await discovery(p,'/json/version');}catch{return false;}},30000);browser=await Cdp.connect(info.webSocketDebuggerUrl);const processes=await browser.send('SystemInfo.getProcessInfo');if(!processes.processInfo.some(v=>v.type==='browser'&&Number(v.id)===normal.pid))throw Error('Browser PID mismatch');
  const wanted=pathToFileURL(path.join(install,'Contents/Resources/app/ui/index.html')).href,target=await wait(async()=>{const pages=await discovery(p,'/json/list'),matches=pages.filter(v=>v.type==='page'&&v.url===wanted);if(matches.length>1)throw Error('Ambiguous restored page');return matches[0];},30000);cdp=await Cdp.connect(target.webSocketDebuggerUrl);await cdp.send('Page.enable');
  await wait(async()=>{const s=await cdp.evaluate('window.nettools.snapshot()');return !s.initializing&&s;});
  await cdp.evaluate(`document.querySelector('[data-page="guard"]').click()`);
  const state=await wait(async()=>cdp.evaluate(`(async()=>{const s=await window.nettools.snapshot(),g=document.getElementById('page-guard'),t=document.getElementById('interval-trigger');if(!g.classList.contains('active')||!t.textContent.includes('17'))return false;return {snapshot:s,activePage:document.querySelector('.page.active').id,guardDisplay:getComputedStyle(g).display,guardVisible:g.getClientRects().length>0,intervalText:t.textContent,url:location.href,version:document.getElementById('version').textContent};})()`));
  if(state.snapshot.version!=='5.0.1'||state.snapshot.smoke!==false||state.snapshot.updateFixture||state.snapshot.settings.intervalMinutes!==17||state.snapshot.settings.enabled||state.snapshot.settings.restartOnTimeout||state.snapshot.settings.launchAtLogin||state.activePage!=='page-guard'||!state.guardVisible||state.guardDisplay==='none'||state.url!==wanted||state.version!=='5.0.1')throw Error('Actual normally reopened guard settings mismatch');
  await pause(750);await cdp.send('Page.getLayoutMetrics');const screenshot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});await fs.writeFile(path.join(evidence,'normal-reopened-rollback-guard17.png'),Buffer.from(screenshot.data,'base64'));await fs.writeFile(path.join(evidence,'normal-reopened-rollback-state.json'),JSON.stringify(state,null,2)+'\n');report.normalGuard={version:'5.0.1',intervalMinutes:17,activePage:state.activePage,guardVisible:true,visualReviewRequired:true};
  for(const f of files)if(await digest(path.join(data,f))!==preserved[f])throw Error('Normal reopen changed preserved settings/config/sentinel');report.preserved=preserved;
  await cdp.evaluate(`document.getElementById('quit-app').click()`);const exit=await deadline(exited,30000);if(exit.code!==0)throw Error('Normal restored app exit failed');report.normalExit={...exit,originalHandleClosed:true};await normal.savedLog();cdp.close();cdp=null;browser.close();browser=null;
  await wait(async()=>!(await ownedProcesses(suite)).length,30000);report.remainingProcesses=await ownedProcesses(suite);if(report.remainingProcesses.length)throw Error('Owned update/reopen process remains');
  if(await digest(archive)!==expected.sha256||await fingerprint(unpacked)!==report.originalDirectorySha256)throw Error('Frozen original candidate changed');report.originalBytesUnchanged=true;cleanupReady=true;report.ok=true;
 }catch(error){report.error={code:error.code||'ACCEPTANCE_FAILED',message:error.message};throw error;}
 finally{
  if(actor&&!actor.ended)await actor.stop().catch(()=>{});
  if(normal&&!closed&&cdp){try{await cdp.evaluate(`document.getElementById('quit-app').click()`);await deadline(normal.closed,15000);}catch(e){report.closeError=e.message;}}
  if(normal&&!closed){
   try{const live=await processIdentity(normal.pid),initial=report.reopen?.identity;if(!live.exists||!initial?.created||live.created!==initial.created||!live.command.includes(install))throw Error('Original private app identity cannot be proved for failure termination');process.kill(-normal.pid,'SIGTERM');try{await deadline(normal.closed,5000);}catch{const again=await processIdentity(normal.pid);if(again.exists&&again.created===initial.created&&again.command.includes(install))process.kill(-normal.pid,'SIGKILL');await deadline(normal.closed,5000);}report.failureOriginalAppStopped=true;}catch(e){report.failureTerminationError=e.message;}
  }
  if(cdp)cdp.close();if(browser)browser.close();if(normal)await normal.savedLog().catch(()=>{});
  try{report.remainingProcesses=await ownedProcesses(suite);}catch(e){report.processQueryError=e.message;cleanupReady=false;}
  report.cleanupConfirmed=cleanupReady&&(!normal||closed)&&report.remainingProcesses?.length===0;
  if(report.cleanupConfirmed){await runProcess('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-u',install],{timeoutMs:10000}).catch(()=>{});await fs.rm(suite,{recursive:true,force:true});report.fixtureRemoved=true;}else report.fixtureRemoved=false;
  report.ok=report.ok&&report.cleanupConfirmed;await fs.writeFile(path.join(evidence,'rollback-observation-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({ok:report.ok,arch:process.arch,cleanupConfirmed:report.cleanupConfirmed,error:report.error}));if(!report.ok)process.exitCode=1;
 }
}
if(require.main===module)run().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});

'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{runProcess}=require('../src/platform/common.cjs');
const {startCiApp}=require('./ci-app-process.cjs'),{runElectronUpdateAcceptance,ownedProcesses}=require('./ci-electron-update.cjs');
async function run(){
 if(process.platform!=='win32'||process.env.CI!=='true'||!process.env.RUNNER_TEMP)throw Error('需要实际隔离 Windows CI');
 const runner=await fs.realpath(process.env.RUNNER_TEMP),version=require('../package.json').version,report=JSON.parse(await fs.readFile(path.resolve(__dirname,'../verification/packages/win32-x64.json'),'utf8')),installer=report.assets.find(asset=>asset.name.endsWith('-setup.exe')).file;
 const temp=await fs.mkdtemp(path.join(runner,'nettools-desktop-')),install=path.join(temp,'Installed','LaoyuNetTools'),data=path.join(temp,'data'),evidence=path.resolve(__dirname,'../verification/windows/desktop');let application,cleanupConfirmed=false;
 try{
  await require('../src/core/update-private-path.cjs').ensureWindowsPrivateDirectory(data,{privateRequired:true});process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT=install;try{await runProcess(installer,[],{timeoutMs:240000,maxOutput:1024*1024});}finally{delete process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT;}
  const installerEvidence=path.join(runner,'nettools-installer-evidence');await fs.cp(installerEvidence,path.resolve(__dirname,'../verification/windows/installer'),{recursive:true});const installerReport=JSON.parse(await fs.readFile(path.join(installerEvidence,'installer-report.json'),'utf8'));if(!installerReport.ok||!installerReport.visible||installerReport.desktopSelected!==false)throw Error('真实可见 WPF 安装未通过：'+(installerReport.error||''));
  const exe=path.join(install,'LaoyuNetTools.exe');await fs.access(exe);const installedVersion=JSON.parse(await fs.readFile(path.join(install,'resources/app/package.json'),'utf8')).version;if(installedVersion!==version)throw Error('实际安装版本不匹配');
  const env={...process.env,NETTOOLS_ACCEPTANCE_DIR:evidence};application=startCiApp(exe,['--nettools-data='+data],{env,timeoutMs:180000,logFile:path.join(temp,'initial-desktop-process.log')});await application.closed;
  const result=JSON.parse(await fs.readFile(path.join(evidence,'desktop-report.json'),'utf8'));if(!result.ok||!result.visible||!result.packaged)throw Error('安装版桌面验收失败');const settings=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'));if(settings.intervalMinutes!==17||settings.enabled||settings.restartOnTimeout||settings.launchAtLogin)throw Error('实际设置不符合验收结果');
  const update=await runElectronUpdateAcceptance({installPath:install,dataDir:data,suiteRoot:temp,packageReport:report,reportDir:path.resolve(evidence,'../update')});cleanupConfirmed=update.cleanupConfirmed&&update.uninstall?.uninstalled;
  console.log(JSON.stringify({ok:true,platform:'win32',version,steps:result.steps.length,settingsPreserved:true,updateCases:update.cases.length,actuallyUninstalled:update.uninstall?.uninstalled}));
 }finally{
  if(application&&!application.ended)await application.stop().catch(()=>{});
  await fs.mkdir(evidence,{recursive:true});await fs.copyFile(path.join(temp,'initial-desktop-process.log'),path.join(evidence,'initial-desktop-process.log')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(!cleanupConfirmed){try{const report=JSON.parse(await fs.readFile(path.resolve(evidence,'../update/update-report.json'),'utf8'));cleanupConfirmed=report.cleanupConfirmed===true&&(report.uninstall?.uninstalled===true||report.failureUninstall?.uninstalled===true);}catch{}}
  if(cleanupConfirmed&&!(await ownedProcesses(temp)).length)await fs.rm(temp,{recursive:true,force:true});else console.error('CI 临时安装保留；尚未确认真实卸载与自有进程结束：'+temp);
 }
}
if(require.main===module)run().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
module.exports={run};

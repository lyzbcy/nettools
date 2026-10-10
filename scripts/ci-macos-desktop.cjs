'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{runProcess}=require('../src/platform/common.cjs');
const {startCiApp}=require('./ci-app-process.cjs'),{runElectronUpdateAcceptance,ownedProcesses}=require('./ci-electron-update.cjs');
async function run(){
 if(process.platform!=='darwin'||process.env.CI!=='true'||!process.env.RUNNER_TEMP)throw Error('需要实际隔离 Mac CI');
 const runner=await fs.realpath(process.env.RUNNER_TEMP),pack=JSON.parse(await fs.readFile(path.resolve(__dirname,`../verification/packages/darwin-${process.arch}.json`),'utf8')),temp=await fs.mkdtemp(path.join(runner,'nettools-install.noindex-')),install=path.join(temp,'捞鱼的网络工具.app'),data=path.join(temp,'data'),reportDir=path.resolve(__dirname,`../verification/macos-${process.arch}/desktop`);let application,cleanupConfirmed=false;
 try{
  await fs.mkdir(data,{mode:0o700});await runProcess('/usr/bin/ditto',[path.join(pack.verifiedDirectory,'捞鱼的网络工具.app'),install],{timeoutMs:60000});await runProcess('/usr/bin/codesign',['--verify','--deep','--strict',install]);
  const env={...process.env,NETTOOLS_ACCEPTANCE_DIR:reportDir};application=startCiApp(path.join(install,'Contents/MacOS/LaoyuNetTools'),['--nettools-data='+data],{env,timeoutMs:180000,logFile:path.join(temp,'initial-desktop-process.log')});await application.closed;
  const result=JSON.parse(await fs.readFile(path.join(reportDir,'desktop-report.json'),'utf8'));if(!result.ok||!result.visible||!result.packaged)throw Error('实际 Mac 安装版桌面验收失败');
  const update=await runElectronUpdateAcceptance({installPath:install,dataDir:data,suiteRoot:temp,packageReport:pack,reportDir:path.resolve(reportDir,'../update')});cleanupConfirmed=update.cleanupConfirmed;
  console.log(JSON.stringify({ok:true,platform:'darwin',arch:process.arch,version:result.version,steps:result.steps.length,updateCases:update.cases.length}));
 }finally{
  if(application&&!application.ended)await application.stop().catch(()=>{});
  await fs.mkdir(reportDir,{recursive:true});await fs.copyFile(path.join(temp,'initial-desktop-process.log'),path.join(reportDir,'initial-desktop-process.log')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(!cleanupConfirmed){try{const report=JSON.parse(await fs.readFile(path.resolve(reportDir,'../update/update-report.json'),'utf8'));cleanupConfirmed=report.cleanupConfirmed===true;}catch{}}
  if(cleanupConfirmed&&!(await ownedProcesses(temp)).length){const unregister='/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';await runProcess(unregister,['-u',install],{timeoutMs:10000}).catch(()=>{});await fs.rm(temp,{recursive:true,force:true});}else console.error('CI 临时安装目录保留，进程/更新清理尚未完整确认：'+temp);
 }
}
if(require.main===module)run().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
module.exports={run};

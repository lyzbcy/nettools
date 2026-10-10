'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{runProcess}=require('../src/platform/common.cjs');
async function run(){
 if(process.platform!=='win32'||process.env.CI!=='true')throw Error('需要实际隔离 Windows CI');
 const version=require('../package.json').version,report=JSON.parse(await fs.readFile(path.resolve(__dirname,'../verification/packages/win32-x64.json'),'utf8')),installer=report.assets.find(a=>a.name.endsWith('-setup.exe')).file;
 const temp=await fs.mkdtemp(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'nettools-desktop-')),install=path.join(temp,'Installed','LaoyuNetTools'),data=path.join(temp,'data'),evidence=path.resolve(__dirname,'../verification/windows/desktop');
 try{
  process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT=install;try{await runProcess(installer,[],{timeoutMs:240000,maxOutput:1024*1024});}finally{delete process.env.NETTOOLS_INSTALLER_ACCEPTANCE_ROOT;}
  const installerEvidence=path.join(process.env.RUNNER_TEMP,'nettools-installer-evidence');await fs.cp(installerEvidence,path.resolve(__dirname,'../verification/windows/installer'),{recursive:true});const installerReport=JSON.parse(await fs.readFile(path.join(installerEvidence,'installer-report.json'),'utf8'));if(!installerReport.ok||!installerReport.visible||installerReport.desktopSelected!==false)throw Error('真实可见 WPF 安装未通过：'+(installerReport.error||''));
  const exe=path.join(install,'LaoyuNetTools.exe');await fs.access(exe);
  const installedVersion=JSON.parse(await fs.readFile(path.join(install,'resources/app/package.json'),'utf8')).version;if(installedVersion!==version)throw Error('实际安装版本不匹配');
  const original=process.env.NETTOOLS_ACCEPTANCE_DIR;process.env.NETTOOLS_ACCEPTANCE_DIR=evidence;
  try{await runProcess(exe,['--nettools-data='+data],{timeoutMs:180000,maxOutput:1024*1024});}finally{if(original===undefined)delete process.env.NETTOOLS_ACCEPTANCE_DIR;else process.env.NETTOOLS_ACCEPTANCE_DIR=original;}
  const result=JSON.parse(await fs.readFile(path.join(evidence,'desktop-report.json'),'utf8'));if(!result.ok||!result.visible||!result.packaged)throw Error('安装版桌面验收失败');
  const settings=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'));if(settings.intervalMinutes!==17||settings.enabled||settings.restartOnTimeout)throw Error('实际设置不符合验收结果');
  console.log(JSON.stringify({ok:true,platform:'win32',version,steps:result.steps.length,settingsPreserved:true}));
 }finally{await fs.rm(temp,{recursive:true,force:true});}
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});

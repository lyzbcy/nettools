'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{runProcess}=require('../src/platform/common.cjs');
async function run(){
 if(process.platform!=='darwin'||process.env.CI!=='true')throw Error('需要实际隔离 Mac CI');
 const pack=JSON.parse(await fs.readFile(path.resolve(__dirname,`../verification/packages/darwin-${process.arch}.json`),'utf8')),temp=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-install.noindex-')),install=path.join(temp,'捞鱼的网络工具.app'),data=path.join(temp,'data'),reportDir=path.resolve(__dirname,`../verification/macos-${process.arch}/desktop`);
 try{
  await runProcess('/usr/bin/ditto',[path.join(pack.verifiedDirectory,'捞鱼的网络工具.app'),install],{timeoutMs:60000});await runProcess('/usr/bin/codesign',['--verify','--deep','--strict',install]);
  process.env.NETTOOLS_ACCEPTANCE_DIR=reportDir;await runProcess(path.join(install,'Contents/MacOS/LaoyuNetTools'),['--nettools-data='+data],{timeoutMs:180000,maxOutput:1024*1024});delete process.env.NETTOOLS_ACCEPTANCE_DIR;
  const result=JSON.parse(await fs.readFile(path.join(reportDir,'desktop-report.json'),'utf8'));if(!result.ok||!result.visible||!result.packaged)throw Error('实际 Mac 安装版桌面验收失败');console.log(JSON.stringify({ok:true,platform:'darwin',arch:process.arch,version:result.version,steps:result.steps.length}));
 }finally{delete process.env.NETTOOLS_ACCEPTANCE_DIR;await fs.rm(temp,{recursive:true,force:true});}
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});

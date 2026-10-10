'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createDarwinPlatform}=require('../src/platform/darwin.cjs'),{runProcess}=require('../src/platform/common.cjs'),{sha}=require('./package.cjs');
async function run(){
 if(process.platform!=='darwin'||process.env.CI!=='true')throw Error('仅允许隔离 Mac CI');
 const report={platform:process.platform,arch:process.arch,scope:'Actual packaged engine and setuid helper; fixed CI sudo bootstrap, not production macOS authorization consent UI; DNS cache only, no adapter reconfiguration or reboot',steps:[],ok:false};
 const pack=JSON.parse(await fs.readFile(path.resolve(__dirname,`../verification/packages/darwin-${process.arch}.json`),'utf8')),native=path.join(pack.verifiedDirectory,'捞鱼的网络工具.app/Contents/Resources/native'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-ci-native-'));
 const installed='/Library/PrivilegedHelperTools/com.laoyu.nettools.helper',state='/Library/Application Support/com.laoyu.nettools',grant=path.join(state,'grant.json');
 const platform=createDarwinPlatform({enginePath:path.join(native,'NetRepair'),resourcesDir:native,configDir:temp});let created=false;
 async function call(action){const result=await platform.invoke(action);if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.data;}
 async function step(name,fn){const value=await fn();report.steps.push({name,ok:true});return value;}
 try{
  await step('packaged-get-status',()=>call('get-status'));await step('packaged-network-check',()=>call('network-check'));const diagnosis=await step('actual-eight-checks',()=>call('diagnose'));if(diagnosis.items.length!==8)throw Error('诊断项不完整');
  const before=await call('helper-status');if(before.installed)throw Error('CI 授权环境已有安装');for(const file of [installed,grant]){try{await fs.lstat(file);throw Error('CI 授权目标不是空环境');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const manifest=JSON.parse(await fs.readFile(path.join(native,'native-manifest.json'),'utf8'));await fs.writeFile(path.join(temp,'grant.json'),JSON.stringify({version:require('../package.json').version,installerUID:process.getuid(),engineHash:manifest.engineHash,helperHash:manifest.helperHash}));
  created=true;await runProcess('/usr/bin/sudo',['/bin/mkdir','-p','/Library/PrivilegedHelperTools',state]);await runProcess('/usr/bin/sudo',['/usr/sbin/chown','root:wheel',state]);await runProcess('/usr/bin/sudo',['/bin/chmod','700',state]);await runProcess('/usr/bin/sudo',['/usr/bin/install','-o','root','-g','wheel','-m','600',path.join(temp,'grant.json'),grant]);await runProcess('/usr/bin/sudo',['/usr/bin/install','-o','root','-g','wheel','-m','4755',path.join(native,'netrepair-helper'),installed]);
  const authorized=await step('actual-root-helper-authentication',()=>call('helper-status'));if(!authorized.installed)throw Error('实际 root 助手授权身份不匹配');await step('actual-dns-cache-flush',()=>call('flush-dns'));report.ok=true;
 }catch(error){report.error={code:error.code||'ACCEPTANCE_FAILED',message:error.message};throw error;}
 finally{
  if(created){const expected=await sha(path.join(native,'netrepair-helper'));if(await sha(installed).catch(()=>null)===expected){await runProcess('/usr/bin/sudo',['/bin/rm','-f',installed,grant]);report.cleanup=true;}else report.cleanup=false;}
  await fs.rm(temp,{recursive:true,force:true});report.finishedAt=new Date().toISOString();const dir=path.resolve(__dirname,`../verification/macos-${process.arch}`);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'native-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});

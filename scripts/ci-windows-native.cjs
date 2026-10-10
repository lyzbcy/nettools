'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createWindowsPlatform}=require('../src/platform/windows.cjs');
async function run(){
 if(process.platform!=='win32')throw Error('This acceptance requires actual Windows');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-验收-'));
 const report={platform:process.platform,version:require('../package.json').version,scope:'Actual Windows native RPC, private config round trip, SYSTEM grant install, DNS cache flush and grant removal; no reboot or adapter reconfiguration',steps:[],startedAt:new Date().toISOString()};
 const platform=createWindowsPlatform({configDir:root,resourcesDir:path.resolve(__dirname,'../src/platform')});
 let installed=false;
 async function step(name,fn,summary=v=>({ok:true})){const start=Date.now();const value=await fn();report.steps.push({name,durationMs:Date.now()-start,...summary(value)});return value;}
 try{
  await step('get-status',()=>platform.invoke('get-status'),v=>({ok:true,linkAvailable:v.linkAvailable,hasAddress:!!v.ip,dhcp:v.dhcp}));
  await step('network-check',()=>platform.invoke('network-check'),v=>({ok:typeof v.ok==='boolean',networkHealthy:v.ok,issue:v.issue}));
  await step('diagnose',()=>platform.invoke('diagnose'),v=>{if(!Array.isArray(v.items)||v.items.length!==8)throw Error('Expected all eight checks');return {ok:true,count:v.items.length};});
  const config={company:{name:'测试公司',intranetCIDR:'',intranetDNS:[],resolverDomain:'',internalHost:'',internalProbeIP:''},vpn:{enabled:false,configName:'',clientAppPath:'/Applications/Tunnelblick.app'},windows:{adapterName:''}};
  await step('unicode-config-save',()=>platform.invoke('save-config',{config}));
  await step('unicode-config-load',()=>platform.invoke('get-config'),v=>{if(v.config.company.name!=='测试公司')throw Error('Unicode round trip failed');return {ok:true};});
  const before=await step('authorization-before',()=>platform.invoke('helper-status'),v=>({ok:true,installed:v.installed}));
  if(before.installed)throw Error('CI runner is not clean: authorization already installed');
  await step('authorization-install',()=>platform.invoke('install-helper'));installed=true;
  await step('authorization-verified',()=>platform.invoke('helper-status'),v=>{if(!v.installed)throw Error('Authorization did not verify');return {ok:true,installed:v.installed};});
  await step('actual-system-dns-cache-flush',()=>platform.invoke('flush-dns'),v=>{if(v.ok!==true)throw Error('DNS cache flush did not succeed');return {ok:true};});
  await step('authorization-uninstall',()=>platform.invoke('uninstall-helper'));installed=false;
  await step('authorization-removed',()=>platform.invoke('helper-status'),v=>{if(v.installed)throw Error('Authorization remains');return {ok:true,installed:v.installed};});
  report.ok=true;
 }catch(e){report.ok=false;report.error={code:e.code||'ACCEPTANCE_FAILED',message:e.message};throw e;}
 finally{
  if(installed){try{await platform.invoke('uninstall-helper');report.cleanup=true;}catch(e){report.cleanup=false;report.cleanupError=e.code||e.message;}}
  await fs.rm(root,{recursive:true,force:true});report.finishedAt=new Date().toISOString();const output=path.resolve(__dirname,'../verification/windows');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'native-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}
run().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});

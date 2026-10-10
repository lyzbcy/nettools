'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let api;try{api=require('../src/platform/windows.cjs');}catch{}
function fixture(t,reply){assert.equal(typeof api?.createWindowsPlatform,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-win-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,runner:async(file,args,options)=>{calls.push({file,args,request:JSON.parse(options.input||'{}')});return {stdout:JSON.stringify(reply(calls.at(-1).request)),stderr:''};}});return {platform,calls};}
test('Windows read operation uses a fixed PowerShell file and JSON stdin',async t=>{
 const {platform,calls}=fixture(t,r=>({ok:true,data:{ok:true,issue:'ok',action:r.action}}));const d=await platform.invoke('network-check');assert.equal(d.ok,true);assert.equal(calls[0].request.action,'network-check');assert.ok(calls[0].args.includes('-File'));assert.ok(!calls[0].args.includes('-Command'));assert.ok(calls[0].file.endsWith('powershell.exe'));
 await assert.rejects(platform.invoke('execute',{command:'whoami'}));
});
test('missing unattended authorization returns permission error and never requests elevation',async t=>{
 const {platform,calls}=fixture(t,r=>({ok:true,data:{installed:false,version:'5.0.0'}}));await assert.rejects(platform.repair('dns',{}),e=>e.code==='PERMISSION_REQUIRED');assert.ok(calls.every(c=>c.request.action==='helper-status'));assert.ok(calls.every(c=>!c.args.some(a=>a.includes('RunAs'))));
});
test('a structured native error propagates code and does not become success',async t=>{
 const {platform}=fixture(t,r=>({ok:false,error:{code:'STATIC_IP',message:'保持静态 IP'}}));await assert.rejects(platform.invoke('get-status'),e=>e.code==='STATIC_IP');
});
test('nonzero native exit retains its structured error instead of losing permission classification',async t=>{
 assert.equal(typeof api?.createWindowsPlatform,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-win-error-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,runner:async()=>{throw Object.assign(Error('process failed'),{code:'PROCESS_EXIT',stdout:JSON.stringify({ok:false,error:{code:'PERMISSION_REQUIRED',message:'需要授权'}})});}});
 await assert.rejects(platform.invoke('get-status'),e=>e.code==='PERMISSION_REQUIRED');
});
test('result I/O failure keeps authorization lease until the actual task has stopped',async t=>{
 assert.equal(typeof api?.createWindowsPlatform,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-win-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let queries=0,ended=0;
 const sid='S-1-5-21-1-2-3-1001';
 const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,pollDelayMs:1,runner:async(file,args,options)=>{
  if(args.includes('/Run'))return {stdout:'',stderr:''};if(args.includes('/End')){ended++;return {stdout:'',stderr:''};}
  const r=JSON.parse(options.input);if(r.action==='helper-status')return {stdout:JSON.stringify({ok:true,data:{installed:true,sid,requestFile:path.join(dir,'request.json'),resultFiles:{'flush-dns':dir}}})};
  if(r.action==='task-status'){queries++;return {stdout:JSON.stringify({ok:true,data:{state:queries<3?'Running':'Ready'}})};}
  throw Error('unexpected action');
 }});
 await assert.rejects(platform.invoke('flush-dns'),e=>e.code==='EISDIR');assert.equal(queries,3);assert.equal(ended,1);
});
test('a failed Run command still verifies task termination before releasing the lease',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-win-run-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let queries=0;
 const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,pollDelayMs:1,stateIO:{writeFile:async()=>{},rename:async()=>{},readFile:async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});}},runner:async(file,args,options)=>{
  if(args.includes('/Run'))throw Object.assign(Error('Run timed out after dispatch'),{code:'PROCESS_TIMEOUT'});if(args.includes('/End'))return {stdout:''};const r=JSON.parse(options.input);
  if(r.action==='helper-status')return {stdout:JSON.stringify({ok:true,data:{installed:true,sid:'S-1-5-21-1-2-3-1001',requestFile:path.join(dir,'request.json'),resultFiles:{'flush-dns':path.join(dir,'result.json')}}})};
  queries++;return {stdout:JSON.stringify({ok:true,data:{state:queries<2?'Running':'Ready'}})};
 }});
 await assert.rejects(platform.invoke('flush-dns'),e=>e.code==='PROCESS_TIMEOUT');assert.equal(queries,2);
});
test('production PowerShell functions preserve static IP, original snapshots and truthful rollback',async t=>{
 const exe=process.platform==='win32'?path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):path.join(__dirname,'../.local-tools/powershell/pwsh');
 if(!fs.existsSync(exe)){t.skip('PowerShell runtime unavailable; Windows CI executes this test');return;}
 const {runProcess}=require('../src/platform/common.cjs');const result=await runProcess(exe,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'../scripts/test-windows-platform.ps1')],{timeoutMs:30000});
 const report=JSON.parse(result.stdout.trim());assert.equal(report.failed,0);assert.ok(report.passed>=20);assert.ok(report.scope.includes('no real network writes'));
});

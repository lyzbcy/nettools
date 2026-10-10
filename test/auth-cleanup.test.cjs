'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {runProcess}=require('../src/platform/common.cjs');
test('runner permits internal unlimited timeout and streams bounded stderr',async()=>{
 const chunks=[];const result=await runProcess(process.execPath,['-e','process.stderr.write("ack\\n");setTimeout(()=>process.exit(0),40)'],{timeoutMs:null,onStderr:c=>chunks.push(c.toString())});assert.equal(chunks.join(''),'ack\n');assert.equal(result.stderr,'ack\n');
});
test('stderr observer never receives output beyond the shared limit',async()=>{
 let size=0;await assert.rejects(runProcess(process.execPath,['-e','process.stderr.write("x".repeat(8192));setInterval(()=>{},1000)'],{maxOutput:10,onStderr:c=>size+=c.length}),{code:'OUTPUT_LIMIT'});assert.equal(size,0);
});
test('production authorization and exact-instance query use read-only fixtures without UAC',async t=>{
 const fs=require('node:fs'),path=require('node:path');const exe=process.platform==='win32'?path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):path.join(__dirname,'../.local-tools/powershell/pwsh');if(!fs.existsSync(exe))return t.skip('PowerShell fixture runtime unavailable');
 const result=await runProcess(exe,['-NoProfile','-NonInteractive','-File',path.join(__dirname,'auth-cleanup.ps1')],{timeoutMs:30000});const report=JSON.parse(result.stdout);assert.equal(report.failed,0);assert.ok(report.passed>=16);assert.match(report.scope,/no UAC/);const ack=JSON.parse(result.stderr.trim());assert.equal(ack.type,'nettools-auth-child');assert.equal(ack.nonce,'12345678-1234-1234-1234-123456789abc');assert.equal(ack.createdTicks,'638900000000000000');
});
test('authorization parent-only cancellation preserves a separately tracked child for read-only cleanup',async t=>{
 let childPid=0,ready,output='';const started=new Promise(r=>ready=r),controller=new AbortController();t.after(()=>{if(childPid){try{process.kill(childPid,'SIGTERM');}catch{}}});
 const script='const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(child.pid)+"\\n");setInterval(()=>{},1000);';
 const pending=runProcess(process.execPath,['-e',script],{signal:controller.signal,killDescendants:false,timeoutMs:null,onStdout:c=>{output+=c.toString();if(output.includes('\n')&&!childPid){childPid=Number(output.trim());ready();}}});await started;controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.ok(childPid>0);assert.doesNotThrow(()=>process.kill(childPid,0));
});

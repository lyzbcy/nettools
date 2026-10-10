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
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-auth-child-')),nonce=crypto.randomUUID(),settings={nonce,readyFile:path.join(dir,'ready.json'),heartbeatFile:path.join(dir,'heartbeat.json'),stopFile:path.join(dir,'stop.json')};
 let childPid=0,ready,output='',pending,startTimer;const started=new Promise(r=>ready=r),controller=new AbortController();
 const waitFor=async(check,timeout=5000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw Error('independent authorization fixture did not reach expected process state');};
 const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}};
 const alive=()=>{try{process.kill(childPid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
 t.after(async()=>{
  clearTimeout(startTimer);controller.abort();try{await pending;}catch{}
  // Request cooperative exit through the private nonce, then observe actual PID
  // disappearance. A detached fixture must never outlive its test directory.
  await fs.writeFile(settings.stopFile,JSON.stringify({nonce}));
  if(!childPid){const ack=await read(settings.readyFile);if(ack?.nonce===nonce&&Number.isInteger(ack.pid)&&ack.pid>0)childPid=ack.pid;}
  if(childPid)await waitFor(()=>!alive(),16000);
  await fs.rm(dir,{recursive:true,force:true});
 });
 const childScript=`const fs=require('node:fs'),s=JSON.parse(process.argv[1]);let beat=0;const write=(file,value)=>{const temporary=file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value));fs.renameSync(temporary,file);};write(s.readyFile,{nonce:s.nonce,pid:process.pid});setInterval(()=>{try{if(JSON.parse(fs.readFileSync(s.stopFile,'utf8')).nonce===s.nonce)process.exit(0);}catch{}write(s.heartbeatFile,{nonce:s.nonce,pid:process.pid,beat:++beat});},20);setTimeout(()=>process.exit(2),15000);`;
 // RunAs/ShellExecute creates an independent console/process group. Waiting for
 // the child's own ACK avoids cancelling its launcher during Node initialization.
 const parentScript=`const fs=require('node:fs'),s=JSON.parse(process.argv[1]),child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)},JSON.stringify(s)],{detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>process.exit(1));child.unref();let acknowledged=false;setInterval(()=>{if(acknowledged)return;try{const ack=JSON.parse(fs.readFileSync(s.readyFile,'utf8'));if(ack.nonce===s.nonce&&ack.pid===child.pid){acknowledged=true;process.stdout.write(JSON.stringify(ack)+'\\n');}}catch{}},20);`;
 pending=runProcess(process.execPath,['-e',parentScript,JSON.stringify(settings)],{signal:controller.signal,killDescendants:false,timeoutMs:null,onStdout:c=>{output+=c.toString();if(output.includes('\n')&&!childPid){const ack=JSON.parse(output.trim());if(ack.nonce===nonce&&Number.isInteger(ack.pid)&&ack.pid>0){childPid=ack.pid;ready();}}}});pending.catch(()=>{});
 await Promise.race([started,new Promise((_,reject)=>{startTimer=setTimeout(()=>reject(Error('independent child readiness ACK missing')),5000);})]);clearTimeout(startTimer);
 const before=await waitFor(async()=>{const beat=await read(settings.heartbeatFile);return beat?.nonce===nonce&&beat.pid===childPid?beat:null;});
 controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.ok(childPid>0);assert.doesNotThrow(()=>process.kill(childPid,0));const atClosed=await read(settings.heartbeatFile);assert.ok(atClosed?.nonce===nonce&&atClosed.pid===childPid&&atClosed.beat>=before.beat);
 const after=await waitFor(async()=>{const beat=await read(settings.heartbeatFile);return beat?.nonce===nonce&&beat.pid===childPid&&beat.beat>atClosed.beat?beat:null;});assert.ok(after.beat>atClosed.beat,'independent child keeps executing after parent cancellation');
});

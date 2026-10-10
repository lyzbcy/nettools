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
async function exerciseIndependentChild(t,{failResponse=false}={}){
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nettools-auth-child-'))),nonce=crypto.randomUUID(),settings={root:dir,nonce,failResponse};
 for(const [key,name] of Object.entries({readyFile:'ready.json',heartbeatFile:'heartbeat.json',stopFile:'stop.json',launchFile:'launch.json',requestFile:'challenge.json',responseFile:'response.json',exitFile:'child-exit.json',stderrFile:'child-stderr.log'}))settings[key]=path.join(dir,name);
 let childPid=0,ready,output='',pending,startTimer,phase='readiness';const started=new Promise(r=>ready=r),controller=new AbortController();
 const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
 const alive=()=>{if(!childPid)return null;try{process.kill(childPid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
 const waitFor=async(check,timeout=5000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw Error('independent authorization fixture did not reach expected process state');};
 const diagnostic=async()=>({phase,nonce,childPid,alive:alive(),lastHeartbeat:await read(settings.heartbeatFile),exit:await read(settings.exitFile),stderr:await fs.readFile(settings.stderrFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})});
 t.after(async()=>{
  phase='cleanup';try{
  clearTimeout(startTimer);controller.abort();try{await pending;}catch{}
  await fs.writeFile(settings.stopFile,JSON.stringify({nonce}),{flag:'wx',mode:0o600});
  const launch=await read(settings.launchFile),ack=await read(settings.readyFile);
  if(!childPid){const identity=ack?.nonce===nonce?ack:launch;if(identity?.nonce===nonce&&Number.isInteger(identity.pid)&&identity.pid>0)childPid=identity.pid;}
  if(childPid)await waitFor(()=>!alive(),16000);else if(launch?.nonce!==nonce||launch.spawned!==false)throw Error('Fixture child identity unknown; temporary directory retained: '+dir);
  await fs.rm(dir,{recursive:true,force:true});
  }catch(error){error.fixture=await diagnostic();t.diagnostic(JSON.stringify(error.fixture));throw error;}
 });
 try{
  pending=runProcess(process.execPath,[path.join(__dirname,'fixtures/auth-child.cjs'),'parent',JSON.stringify(settings)],{signal:controller.signal,killDescendants:false,timeoutMs:null,onStdout:c=>{output+=c.toString();if(output.includes('\n')&&!childPid){const ack=JSON.parse(output.trim());if(ack.nonce===nonce&&Number.isInteger(ack.pid)&&ack.pid>0){childPid=ack.pid;ready();}}}});pending.catch(()=>{});
  await Promise.race([started,new Promise((_,reject)=>{startTimer=setTimeout(()=>reject(Error('independent child readiness ACK missing')),5000);}),pending.then(()=>{throw Error('Fixture parent exited before readiness');},error=>{throw error;})]);clearTimeout(startTimer);
  phase='before-cancellation-heartbeat';const before=await waitFor(async()=>{const beat=await read(settings.heartbeatFile);return beat?.nonce===nonce&&beat.pid===childPid?beat:null;});
  phase='parent-cancellation';controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});assert.ok(childPid>0);assert.doesNotThrow(()=>process.kill(childPid,0));const atClosed=await read(settings.heartbeatFile);assert.ok(atClosed?.nonce===nonce&&atClosed.pid===childPid&&atClosed.beat>=before.beat);
  // This fresh challenge is created only after the original parent handle closed.
  // The independent child writes one exclusive response, never replacing a file
  // concurrently being read by the test on Windows.
  phase='after-cancellation-response';const challenge=crypto.randomUUID();await fs.writeFile(settings.requestFile,JSON.stringify({nonce,challenge}),{flag:'wx',mode:0o600});
  const after=await waitFor(async()=>{const response=await read(settings.responseFile);if(response?.nonce===nonce&&response.pid===childPid&&response.challenge===challenge&&response.beat>atClosed.beat)return response;const exit=await read(settings.exitFile);if(exit?.nonce===nonce&&exit.pid===childPid)throw Error('Independent fixture child exited: '+(exit.errorCode||exit.code));return null;});assert.ok(after.beat>atClosed.beat,'independent child executes the new challenge after parent cancellation');assert.doesNotThrow(()=>process.kill(childPid,0));return {challenge,after};
 }catch(error){error.fixture=await diagnostic();t.diagnostic(JSON.stringify(error.fixture));throw error;}
}
test('authorization parent-only cancellation preserves a separately tracked child for read-only cleanup',async t=>exerciseIndependentChild(t));
test('independent child response I/O failure reports its own exit instead of a cancellation diagnosis',async t=>{await assert.rejects(exerciseIndependentChild(t,{failResponse:true}),error=>error.fixture?.phase==='after-cancellation-response'&&error.fixture?.exit?.code===1&&error.fixture?.exit?.errorCode==='FIXTURE_RESPONSE_IO'&&error.fixture?.stderr.includes('FIXTURE_RESPONSE_IO'));});

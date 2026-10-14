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
function authFixture(t,authorization,query){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-win-auth-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[],sid='S-1-5-21-1-2-3-1001';
 const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,pollDelayMs:1,runner:async(file,args,options)=>{
  calls.push({file,args,options});if(args.includes('-Mode')){const nonce=args[args.indexOf('-Nonce')+1],mode=args[args.indexOf('-Mode')+1];return authorization({options,nonce,mode,sid});}
  const r=JSON.parse(options.input);if(r.action==='helper-status')return {stdout:JSON.stringify({ok:true,data:{sid}})};
  if(r.action==='authorization-process-status')return query(r,options);return {stdout:'{"ok":true,"data":{}}'};
 }});return {platform,calls};
}
function authAck({nonce,mode,sid},extra={}){return {type:'nettools-auth-child',nonce,mode,CallerSid:sid,pid:1234,createdTicks:'638900000000000000',...extra};}
function cancelled(){return Object.assign(Error('parent cancelled'),{code:'ABORT_ERR'});}
test('authorization has no dialog timeout and cancellation retains lease until the exact elevated instance exits',async t=>{
 let release,queries=0;const gate=new Promise(r=>release=r);const {platform,calls}=authFixture(t,async info=>{assert.equal(info.options.timeoutMs,null);assert.equal(info.options.killDescendants,false);info.options.onStderr(Buffer.from(JSON.stringify(authAck(info))+'\n'));throw cancelled();},async r=>{
  queries++;if(queries===1)await gate;return {stdout:JSON.stringify({ok:true,data:{...r.args,state:queries<2?'running':'exited'}})};
 });
 const pending=platform.invoke('install-helper');pending.catch(()=>{});const deadline=Date.now()+1000;while(!queries&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1));assert.ok(queries);assert.equal(platform.isCleanupPending(),true);await assert.rejects(platform.restart(),{code:'BUSY'});await assert.rejects(platform.invoke('get-status'),{code:'BUSY'});release();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(queries,2);assert.equal(platform.isCleanupPending(),false);assert.ok(calls.every(x=>!x.args.includes('/End')));
});
test('authorization query failure and missing/stale ACK leave a persistent barrier',async t=>{
 for(const ack of ['valid','missing','stale','conflicting']){
  let queries=0;const {platform}=authFixture(t,async info=>{if(ack!=='missing'){info.options.onStderr(Buffer.from(JSON.stringify(authAck(info,ack==='stale'?{nonce:'00000000-0000-0000-0000-000000000000'}:{}))+'\n'));if(ack==='conflicting')info.options.onStderr(Buffer.from(JSON.stringify(authAck(info,{pid:9999}))+'\n'));}throw cancelled();},async()=>{queries++;throw Object.assign(Error('query denied'),{code:'EACCES'});});
  await assert.rejects(platform.invoke('uninstall-helper'),{code:'ABORT_ERR'});assert.equal(platform.isCleanupPending(),true);await assert.rejects(platform.invoke('get-status'),{code:'BUSY'});await assert.rejects(platform.restart(),{code:'BUSY'});assert.equal(queries,ack==='valid'?1:0);
 }
});
test('exact-instance replacement releases a cancelled authorization without killing any process',async t=>{
 const {platform}=authFixture(t,async info=>{info.options.onStderr(Buffer.from(JSON.stringify(authAck(info))+'\n'));throw cancelled();},async r=>({stdout:JSON.stringify({ok:true,data:{...r.args,state:'replaced'}})}));
 await assert.rejects(platform.invoke('install-helper'),{code:'ABORT_ERR'});assert.equal(platform.isCleanupPending(),false);await platform.invoke('get-status');await assert.rejects(platform.invoke('authorization-process-status'));
});
test('bound closed direct-admin and cancelled-before-launch envelopes release the authorization lease',async t=>{
 for(const execution of ['direct','none']){
  const {platform}=authFixture(t,async info=>{throw Object.assign(Error('closed'),{code:'PROCESS_EXIT',stdout:JSON.stringify({ok:false,error:{code:execution==='none'?'AUTH_CANCELLED':'AUTH_FAILED',message:'refused'},authorization:{nonce:info.nonce,mode:info.mode,CallerSid:info.sid,execution,closed:true}})});},()=>{throw Error('must not query');});
  await assert.rejects(platform.invoke('install-helper'),{code:execution==='none'?'AUTH_CANCELLED':'AUTH_FAILED'});assert.equal(platform.isCleanupPending(),false);await platform.invoke('get-status');
 }
});
test('unbound completion and malformed process status cannot release an uncertain authorization',async t=>{
 const {platform}=authFixture(t,async info=>({stdout:JSON.stringify({ok:true,data:{installed:true},authorization:{nonce:'stale',mode:info.mode,CallerSid:info.sid,execution:'direct',closed:true}})}),()=>{throw Error('no ack');});
 await assert.rejects(platform.invoke('install-helper'));assert.equal(platform.isCleanupPending(),true);
 const other=authFixture(t,async info=>{info.options.onStderr(Buffer.from(JSON.stringify(authAck(info))+'\n'));throw cancelled();},async r=>({stdout:JSON.stringify({ok:true,data:{...r.args,createdTicks:'638900000000000001',state:'exited'}})})).platform;
 await assert.rejects(other.invoke('install-helper'),{code:'ABORT_ERR'});assert.equal(other.isCleanupPending(),true);
});
test('bound successful direct and elevated completions release without querying, with fragmented ACKs',async t=>{
 for(const execution of ['direct','child']){
  const nonces=[];const {platform}=authFixture(t,async info=>{nonces.push(info.nonce);const identity=authAck(info);if(execution==='child'){const line=JSON.stringify(identity)+'\n';info.options.onStderr(Buffer.from(line.slice(0,20)));info.options.onStderr(Buffer.from(line.slice(20)));}
   return {stdout:JSON.stringify({ok:true,data:{installed:true},authorization:{nonce:info.nonce,mode:info.mode,CallerSid:info.sid,execution,closed:true,...(execution==='child'?{pid:identity.pid,createdTicks:identity.createdTicks}:{})}})};
  },()=>{throw Error('closed completion must not query');});
  assert.equal((await platform.invoke('install-helper')).installed,true);assert.equal(platform.isCleanupPending(),false);await platform.invoke('install-helper');assert.notEqual(nonces[0],nonces[1]);
 }
});
test('task result published during terminal status query is read after exit and remains nonce-bound',async t=>{
 for(const scenario of ['success','native-error','foreign','missing','malformed','io-error','cancel']){
  let request,resultText,reads=0;const abort=new AbortController();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-late-result-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const platform=api.createWindowsPlatform({configDir:dir,resourcesDir:dir,pollDelayMs:1,stateIO:{writeFile:async(_file,text)=>{request=JSON.parse(text);},rename:async()=>{},readFile:async()=>{reads++;if(reads>1&&scenario==='io-error')throw Object.assign(Error('denied'),{code:'EACCES'});if(resultText===undefined)throw Object.assign(Error('missing'),{code:'ENOENT'});return resultText;}},runner:async(_file,args,options)=>{
   if(args.includes('/Run')||args.includes('/End'))return {stdout:''};const r=JSON.parse(options.input);
   if(r.action==='helper-status')return {stdout:JSON.stringify({ok:true,data:{installed:true,sid:'S-1-5-21-1-2-3-1001',requestFile:path.join(dir,'request.json'),resultFiles:{'flush-dns':path.join(dir,'result.json')}}})};
   assert.equal(r.action,'task-status');assert.equal(platform.isCleanupPending(),true);await assert.rejects(platform.invoke('get-status'),{code:'BUSY'});
   resultText=scenario==='missing'?undefined:scenario==='malformed'?'{':JSON.stringify({nonce:scenario==='foreign'?'stale':request.nonce,...(scenario==='native-error'?{ok:false,error:{code:'NATIVE_DENIED',message:'refused'}}:{ok:true,data:{completed:true}})});if(scenario==='cancel')abort.abort();return {stdout:JSON.stringify({ok:true,data:{state:'Ready'}})};
  }});
  const promise=platform.invoke('flush-dns',{}, {signal:abort.signal});if(scenario==='success')assert.deepEqual(await promise,{completed:true});else await assert.rejects(promise,{code:scenario==='native-error'?'NATIVE_DENIED':scenario==='io-error'?'EACCES':scenario==='cancel'?'ABORT_ERR':'TASK_NO_RESULT'});assert.equal(reads,2);assert.equal(platform.isCleanupPending(),false);
 }
});
test('CI failure snapshot is bounded, read-only, fixed to current SID and collected before uninstall',async t=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/ci-windows-native-snapshot.ps1'),'utf8'),runner=fs.readFileSync(path.join(__dirname,'../scripts/ci-windows-native.cjs'),'utf8');assert.match(source,/GITHUB_ACTIONS -ne 'true'/);assert.match(source,/GetCurrent\(\)\.User\.Value/);assert.match(source,/65536/);assert.match(source,/ReparsePoint/);assert.match(source,/flush-dns.result.json/);assert.doesNotMatch(source,/Set-Item|Remove-Item|Start-ScheduledTask|Stop-ScheduledTask|Set-Acl/);assert(runner.indexOf('if(installed&&!report.beforeUninstall)await captureNativeState()')<runner.indexOf("if(installed){try{await platform.invoke('uninstall-helper')"));
 const pwsh=[path.join(__dirname,'../.local-tools/powershell/pwsh'),'/usr/local/bin/pwsh','/opt/homebrew/bin/pwsh'].find(file=>fs.existsSync(file));if(process.platform!=='win32'&&!pwsh){t.diagnostic('PowerShell parser unavailable here; Windows CI parses using fixed Windows PowerShell');return;}const script=path.join(__dirname,'../scripts/ci-windows-native-snapshot.ps1'),escaped=script.replaceAll("'","''"),command="$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+escaped+"',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object ToString;exit 1}";
 const result=await require('../src/platform/common.cjs').runProcess(process.platform==='win32'?path.win32.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):pwsh,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]);assert.equal(result.stdout.trim(),'');
});

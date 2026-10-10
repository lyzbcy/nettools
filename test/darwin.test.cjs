'use strict';
const nodeTest=require('node:test'), test=(name,fn)=>nodeTest(name,{skip:process.platform!=='darwin'},fn), assert=require('node:assert/strict'), fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let api={}; try{api=require('../src/platform/darwin.cjs');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-darwin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('Darwin adapter validates before executing and never exposes old update or restart IPC',async t=>{
 assert.equal(typeof api.createDarwinPlatform,'function'); const dir=fixture(t);
 const platform=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir});
 for(const [action,args] of [['restart-system',{}],['apply-update',{}],['set-dns',{primary:'1.1.1.1; bad'}],['get-status',{command:'whoami'}]]) await assert.rejects(()=>platform.invoke(action,args));
});
test('Darwin adapter handles structured stdin response, background flag and cancellation',async t=>{
 assert.equal(typeof api.createDarwinPlatform,'function');const dir=fixture(t), engine=path.join(dir,'engine');
 fs.writeFileSync(engine,`#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const q=JSON.parse(s);console.log(JSON.stringify({ok:true,data:{action:q.action,args:q.args,background:q.background,argv:process.argv.slice(2)}}));});\n`,{mode:0o700});
 const p=api.createDarwinPlatform({enginePath:engine,configDir:dir,resourcesDir:dir});const result=await p.invoke('get-status',{}, {background:true});
 assert.equal(result.ok,true);assert.equal(result.data.background,true);assert.ok(result.data.argv.includes('--config-dir'));
 const controller=new AbortController();controller.abort(); await assert.rejects(()=>p.invoke('get-status',{}, {signal:controller.signal}),{code:'ABORT_ERR'});
});
test('repair chooses fixed action or returns unsupported without arbitrary execution',async t=>{
 assert.equal(typeof api.createDarwinPlatform,'function');const dir=fixture(t),engine=path.join(dir,'engine');
 fs.writeFileSync(engine,`#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({ok:true,data:{action:JSON.parse(s).action}})));\n`,{mode:0o700});
 const p=api.createDarwinPlatform({enginePath:engine,configDir:dir,resourcesDir:dir});
 assert.equal((await p.repair('dns')).data.action,'flush-dns');assert.equal((await p.repair('stale-proxy')).data.action,'clear-proxy');
 assert.equal((await p.repair('unknown')).error.code,'UNSUPPORTED_ISSUE');
});
test('adapter serializes operations until previous child actually exits',async t=>{
 assert.equal(typeof api.createDarwinPlatform,'function');const dir=fixture(t),engine=path.join(dir,'engine');
 fs.writeFileSync(engine,`#!${process.execPath}\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({ok:true,data:{pid:process.pid,started:Date.now()}}));setTimeout(()=>{},150);});\n`,{mode:0o700});
 const p=api.createDarwinPlatform({enginePath:engine,configDir:dir,resourcesDir:dir});const answers=await Promise.all([p.invoke('get-status'),p.invoke('get-status')]);
 assert.ok(answers[1].data.started-answers[0].data.started>=150);
});
test('restart preparation requests only readonly Automation access and never restarts',async t=>{
 const dir=fixture(t),calls=[];const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async(file,args)=>{calls.push({file,args});return {stdout:'System Events\n',stderr:''};}});
 assert.equal(typeof p.prepareRestart,'function');assert.equal((await p.prepareRestart()).ok,true);
 assert.deepEqual(calls,[{file:'/usr/bin/osascript',args:['-e','tell application "System Events" to get name']}]);
 assert.equal((await p.restart()).ok,true);assert.equal(calls[1].args[1],'tell application "System Events" to restart');
});
test('unconfirmed native cleanup blocks later commands including restart',async t=>{
 const dir=fixture(t);let calls=0;const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async()=>{calls++;if(calls===1)throw Object.assign(Error('native timeout'),{code:'PROCESS_TIMEOUT'});return {stdout:'System Events',stderr:''};}});
 assert.equal((await p.invoke('get-status')).error.code,'PROCESS_TIMEOUT');assert.equal((await p.invoke('get-status')).error.code,'CLEANUP_PENDING');assert.equal((await p.prepareRestart()).error.code,'CLEANUP_PENDING');assert.equal((await p.restart()).error.code,'CLEANUP_PENDING');assert.equal(calls,1);
});
test('cleanup acknowledgement allows the next call after native cancellation',async t=>{
 const dir=fixture(t);let calls=0;const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async(_f,_a,o)=>{calls++;if(calls===1){o.onStdout(Buffer.from('{"ok":false,"cleanupComplete":true}\n'));throw Object.assign(Error('cancelled'),{code:'ABORT_ERR'});}return {stdout:'{"ok":true,"data":{}}',stderr:''};}});
 await assert.rejects(()=>p.invoke('get-status'),{code:'ABORT_ERR'});assert.equal((await p.invoke('get-status')).ok,true);
});
test('a request cancelled before spawn cannot poison cleanup state',async t=>{
 const dir=fixture(t);let calls=0;const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async()=>{calls++;return {stdout:'{"ok":true,"data":{}}',stderr:''};}});const c=new AbortController();c.abort();
 await assert.rejects(()=>p.invoke('get-status',{}, {signal:c.signal}),{code:'ABORT_ERR'});assert.equal(calls,0);assert.equal((await p.invoke('get-status')).ok,true);
});
test('RPC error envelopes with uncertain cleanup block every following operation',async t=>{
 const dir=fixture(t);
 for(const envelope of [
  {ok:false,error:{code:'PROCESS_TIMEOUT',message:'native timeout'},cleanupComplete:false},
  ...['PROCESS_TIMEOUT','ABORT_ERR','ABORTED','OUTPUT_LIMIT'].map(code=>({ok:false,error:{code,message:'unconfirmed native failure'}})),
  {ok:false,error:{code:'PERMISSION_REQUIRED',message:'cleanup incomplete'},cleanupComplete:false},
 ]){
  let calls=0;const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async()=>{calls++;return {stdout:JSON.stringify(calls===1?envelope:{ok:true,data:{}}),stderr:''};}});
  assert.equal((await p.invoke('network-check')).error.code,envelope.error.code);
  assert.equal((await p.invoke('get-status')).error?.code,'CLEANUP_PENDING');assert.equal((await p.prepareRestart()).error?.code,'CLEANUP_PENDING');assert.equal((await p.restart()).error?.code,'CLEANUP_PENDING');assert.equal(calls,1);
 }
});
test('confirmed cleanup and ordinary permission failures keep the next invocation available',async t=>{
 const dir=fixture(t);
 for(const envelope of [
  {ok:false,error:{code:'PERMISSION_REQUIRED',message:'not authorized'},cleanupComplete:true},
  {ok:false,error:{code:'PERMISSION_REQUIRED',message:'not authorized'}},
  ...['PROCESS_TIMEOUT','ABORT_ERR','OUTPUT_LIMIT'].map(code=>({ok:false,error:{code,message:'cleaned'},cleanupComplete:true})),
 ]){
  let calls=0;const p=api.createDarwinPlatform({enginePath:'/missing/NetRepair',configDir:dir,resourcesDir:dir,runner:async()=>{calls++;return {stdout:JSON.stringify(calls===1?envelope:{ok:true,data:{}}),stderr:''};}});
  assert.equal((await p.invoke('network-check')).ok,false);assert.equal((await p.invoke('get-status')).ok,true);assert.equal(calls,2);
 }
});

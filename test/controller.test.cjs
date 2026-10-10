'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let api;try{api=require('../src/core/controller.cjs');}catch{}
function fixture(t,options={}){assert.equal(typeof api?.Controller,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-controller-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];const platform={invoke:async(action)=>{calls.push(action);if(action==='helper-status')return {installed:false};if(action==='get-status')return {linkAvailable:true,ip:'192.0.2.3',online:null};if(action==='network-check')return {ok:true,issue:'ok'};if(action==='get-config')return {config:{}};return {message:'completed'};},repair:async()=>{calls.push('repair');return {ok:true};},restart:async()=>{calls.push('restart');return {ok:true};},prepareRestart:async()=>{calls.push('prepareRestart');return {ok:true};},...options.platform};const c=new api.Controller({dataDir:dir,platform,version:'5.0.0',onState:()=>{},confirmRestart:options.confirmRestart||(async()=>false),...options.controller});t.after(()=>c.stop());return {c,dir,calls};}
test('controller boot displays real read-only status but never enables repair or restart by default',async t=>{
 const {c,calls}=fixture(t);await c.initialize();assert.equal(c.snapshot().settings.enabled,false);assert.equal(c.snapshot().settings.restartOnTimeout,false);assert.ok(calls.includes('network-check'));assert.ok(!calls.includes('repair'));assert.ok(!calls.includes('restart'));
});
test('native envelope is unwrapped so completed offline diagnostics never become healthy',async t=>{
 const {c}=fixture(t,{platform:{invoke:async action=>action==='network-check'?{ok:true,data:{ok:false,issue:'dns'}}:{ok:true,data:action==='helper-status'?{installed:false}:{}}}});await c.initialize();assert.equal(c.snapshot().network.ok,false);assert.equal(c.snapshot().network.issue,'dns');
});
test('custom guard interval is persisted and invalid values cannot change existing preferences',async t=>{
 const {c,dir}=fixture(t);await c.initialize();await c.updateSettings({intervalMinutes:17});assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).intervalMinutes,17);await assert.rejects(c.updateSettings({intervalMinutes:0}));assert.equal(c.snapshot().settings.intervalMinutes,17);
});
test('restart opt-in requires confirmation and readonly system authorization before it is saved',async t=>{
 const {c,calls,dir}=fixture(t);await c.initialize();await assert.rejects(c.updateSettings({restartOnTimeout:true}),e=>e.code==='CANCELLED');assert.equal(c.snapshot().settings.restartOnTimeout,false);assert.ok(!calls.includes('prepareRestart'));
 c.confirmRestart=async()=>true;await c.updateSettings({restartOnTimeout:true});assert.ok(calls.includes('prepareRestart'));assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8')).restartOnTimeout,true);assert.ok(!calls.includes('restart'));
});
test('a reboot marker safely disables the next boot restart policy while preserving other settings',async t=>{
 const {c,dir}=fixture(t);fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabled:true,intervalMinutes:60,restartOnTimeout:true,launchAtLogin:false}));fs.writeFileSync(path.join(dir,'reboot-guard.json'),JSON.stringify({createdAt:new Date().toISOString(),reason:'repair-timeout'}));await c.initialize();assert.equal(c.snapshot().settings.restartOnTimeout,false);assert.equal(c.snapshot().settings.enabled,true);assert.equal(c.snapshot().settings.intervalMinutes,60);assert.ok(!fs.existsSync(path.join(dir,'reboot-guard.json')));
});
test('unknown IPC sources, subframes, unsafe links and restart actions are rejected',()=>{
 assert.equal(typeof api?.validateSender,'function');const expected={senderId:3,url:'file:///app/ui/index.html'};
 assert.equal(api.validateSender({senderId:3,url:expected.url,isMainFrame:true},expected),true);
 for(const sender of [{senderId:4,url:expected.url,isMainFrame:true},{senderId:3,url:'https://example.org',isMainFrame:true},{senderId:3,url:expected.url,isMainFrame:false}])assert.throws(()=>api.validateSender(sender,expected));
 assert.throws(()=>api.validateLink('https://example.org'));assert.equal(api.validateLink('release'),'https://github.com/lyzbcy/nettools/releases');
});
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
test('failed automatic check clears old healthy UI state and cancelled late results never repaint it',async t=>{
 let mode='ok',resolveLate;const {c}=fixture(t,{platform:{invoke:async action=>{if(action==='helper-status')return {installed:false};if(action!=='network-check')return {};if(mode==='fail')throw Object.assign(Error('check failed'),{code:'CHECK_FAILED'});if(mode==='late')return new Promise(r=>resolveLate=r);return {ok:true,issue:'ok'};}}});
 await c.initialize();await c.updateSettings({enabled:true});await flush();assert.equal(c.snapshot().network.ok,true);mode='fail';await c.guard.checkNow();assert.equal(c.snapshot().network,null);
 mode='late';const pending=c.guard.checkNow();await flush();c.guard.suspend();resolveLate({ok:true,issue:'ok'});await pending;await flush();assert.equal(c.snapshot().network,null);
});
test('settings transactions serialize confirmation and keep persisted and guard states identical',async t=>{
 let approve;const {c,dir}=fixture(t,{confirmRestart:()=>new Promise(r=>approve=r)});await c.initialize();
 const first=c.updateSettings({restartOnTimeout:true});await flush();const second=c.updateSettings({enabled:true,intervalMinutes:17});approve(true);await Promise.all([first,second]);
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8'));assert.deepEqual(c.snapshot().settings,saved);assert.equal(c.guard.snapshot().enabled,true);assert.equal(saved.enabled,true);assert.equal(c.guard.snapshot().intervalMinutes,17);
});
test('login startup is verified before settings persist and failed OS change leaves preferences intact',async t=>{
 const changes=[];const {c,dir}=fixture(t,{controller:{applyLoginStartup:async enabled=>{changes.push(enabled);throw Error('OS denied');}}});await c.initialize();await assert.rejects(c.updateSettings({launchAtLogin:true}),/OS denied/);assert.equal(c.snapshot().settings.launchAtLogin,false);assert.equal(c.guard.snapshot().launchAtLogin,false);assert.ok(!fs.existsSync(path.join(dir,'settings.json'))||!JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))).launchAtLogin);assert.deepEqual(changes,[true]);
});
test('reboot marker is written only immediately before dispatch and is removed on failed restart',async t=>{
 const {c,dir}=fixture(t,{platform:{restart:async()=>({ok:false,error:{code:'RESTART_DENIED'}})}});await c.initialize();
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(c.guard.restart({signal:cancelled.signal}),e=>e.code==='ABORT_ERR');assert.ok(!fs.existsSync(path.join(dir,'reboot-guard.json')));
 const result=await c.guard.restart({signal:new AbortController().signal});assert.equal(result.ok,false);assert.ok(!fs.existsSync(path.join(dir,'reboot-guard.json')));
});
test('disabling guardian is not queued behind a slow initial repair',async t=>{
 let repairSignal,release;const {c}=fixture(t,{platform:{invoke:async a=>a==='helper-status'?{installed:true}:a==='network-check'?{ok:false,issue:'dns'}:{},repair:async(_,{signal})=>{repairSignal=signal;return new Promise(r=>release=r);}}});await c.initialize();
 let enabledDone=false;const on=c.updateSettings({enabled:true}).then(()=>enabledDone=true);await flush();assert.ok(repairSignal);const off=c.updateSettings({enabled:false});await flush();assert.equal(c.guard.snapshot().enabled,false);assert.equal(repairSignal.aborted,true);assert.equal(enabledDone,true);release({ok:true});await Promise.all([on,off]);
});
test('a settings-only event cannot replace a newer failed manual result with old guardian health',async t=>{
 let fail=false;const {c}=fixture(t,{platform:{invoke:async a=>a==='helper-status'?{installed:false}:a==='network-check'?fail?Promise.reject(Error('manual failed')):{ok:true,issue:'ok'}:{}}});await c.initialize();await c.updateSettings({enabled:true});await flush();await c.updateSettings({enabled:false});fail=true;await assert.rejects(c.invoke('network-check'));assert.equal(c.snapshot().network,null);await c.updateSettings({intervalMinutes:11});assert.equal(c.snapshot().network,null);
});
test('uncertain restart dispatch retains durable loop protection for the next launch',async t=>{
 const {c,dir}=fixture(t,{platform:{restart:async()=>{throw Object.assign(Error('launcher interrupted after request'),{code:'ABORT_ERR'});}}});await c.initialize();await assert.rejects(c.guard.restart({signal:new AbortController().signal}));assert.ok(fs.existsSync(path.join(dir,'reboot-guard.json')));
});
test('shutdown cancels a manual system action and waits for its actual cleanup before returning',async t=>{
 let started,release,signal;const begin=new Promise(r=>started=r);const {c}=fixture(t,{platform:{invoke:async(a,_args,opts)=>{if(a==='flush-dns'){signal=opts?.signal;started();return new Promise(r=>release=r);}return a==='helper-status'?{installed:true}:a==='network-check'?{ok:true,issue:'ok'}:{};}}});await c.initialize();const manual=c.invoke('flush-dns').catch(()=>{});await begin;let done=false;const closing=c.shutdown().then(()=>done=true);await flush();assert.equal(signal.aborted,true);assert.equal(done,false);await assert.rejects(c.invoke('get-status'),e=>e.code==='CLOSING');release({ok:true});await Promise.all([manual,closing]);assert.equal(done,true);assert.equal(c.guard.snapshot().running,false);
});
test('shutdown waits for cancelled guardian repair cleanup, not just its stopped state',async t=>{
 let release,signal;const {c}=fixture(t,{platform:{invoke:async a=>a==='helper-status'?{installed:true}:a==='network-check'?{ok:false,issue:'dns'}:{},repair:async(_,{signal:s})=>{signal=s;return new Promise(r=>release=r);}}});await c.initialize();await c.updateSettings({enabled:true});await flush();let done=false;const shutdown=c.shutdown().then(()=>done=true);await flush();assert.equal(signal.aborted,true);assert.equal(c.guard.snapshot().state,'stopped');assert.equal(done,false);release({ok:true});await shutdown;assert.equal(done,true);
});
test('an explicit authorization installation already in flight finishes before shutdown',async t=>{
 let release,signal;const {c}=fixture(t,{platform:{invoke:async(a,_args,opts)=>{if(a==='install-helper'){signal=opts.signal;return new Promise(r=>release=r);}return a==='helper-status'?{installed:false}:a==='network-check'?{ok:true,issue:'ok'}:{};}}});await c.initialize();const install=c.invoke('install-helper').catch(()=>{});await flush();let done=false;const closing=c.shutdown().then(()=>done=true);await flush();assert.equal(signal.aborted,false);assert.equal(done,false);release({installed:true});await Promise.all([install,closing]);assert.equal(done,true);
});
test('shutdown cancels initial status read and never starts a late guardian or further native calls',async t=>{
 let release,signal;const actions=[];const {c}=fixture(t,{platform:{invoke:async(a,_args,opts)=>{actions.push(a);signal=opts.signal;return new Promise(r=>release=r);}}});const init=c.initialize();await flush();const close=c.shutdown();await flush();assert.equal(signal.aborted,true);release({linkAvailable:true});await Promise.all([init,close]);assert.deepEqual(actions,['get-status']);assert.equal(c.guard.snapshot().running,false);
});
test('shutdown cancels pending restart confirmation and rejects queued setting changes',async t=>{
 const {c}=fixture(t,{confirmRestart:({signal})=>new Promise(r=>signal.addEventListener('abort',()=>r(false),{once:true}))});await c.initialize();const on=c.updateSettings({restartOnTimeout:true}).catch(e=>e.code);await flush();const queued=c.updateSettings({enabled:true}).catch(e=>e.code);await c.shutdown();assert.equal(await on,'CANCELLED');assert.equal(await queued,'CLOSING');assert.equal(c.settings.restartOnTimeout,false);assert.equal(c.guard.snapshot().running,false);
});
test('settled promises with unconfirmed native cleanup cannot authorize quit or restart the guardian',async t=>{const {c}=fixture(t,{platform:{isCleanupPending:()=>true}});await c.initialize();await assert.rejects(c.shutdown(),e=>e.code==='CLEANUP_PENDING');await assert.rejects(c.reopenAfterShutdown(),e=>e.code==='CLEANUP_PENDING');assert.equal(c.snapshot().shuttingDown,true);assert.equal(c.guard.snapshot().running,false);});
test('startup becomes ready before a saved enabled guardian finishes its first slow repair',async t=>{
 let release;const {c,dir}=fixture(t,{platform:{invoke:async a=>a==='network-check'?{ok:false,issue:'dns'}:a==='helper-status'?{installed:true}:{linkAvailable:true},repair:async()=>new Promise(r=>release=r)}});fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({enabled:true,intervalMinutes:30,restartOnTimeout:false,launchAtLogin:false}));let ready=false;const init=c.initialize().then(()=>ready=true);await flush();try{assert.equal(ready,true);assert.equal(c.snapshot().status.linkAvailable,true);assert.equal(c.guard.snapshot().state,'repairing');}finally{release?.({ok:true});await init;}
});

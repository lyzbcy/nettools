'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
let api;try{api=require('../src/core/updater.cjs');}catch{}
const digest=crypto.createHash('sha256').update('valid package').digest('hex');
function release(version='5.1.0',extra={}){return {tag_name:'v'+version,draft:false,prerelease:false,html_url:'https://github.com/lyzbcy/nettools/releases/tag/v'+version,assets:[{name:`nettools-${version}-mac-arm64.zip`,browser_download_url:`https://github.com/lyzbcy/nettools/releases/download/v${version}/nettools-${version}-mac-arm64.zip`,digest:'sha256:'+digest,size:13}],...extra};}
test('numeric versions compare and reject malformed or preview strings',()=>{
 assert.equal(typeof api?.compareVersions,'function');assert.equal(api.compareVersions('5.10.0','5.9.9'),1);assert.equal(api.compareVersions('5.0.0','5.0.0'),0);assert.equal(api.compareVersions('4.4.1','5.0.0'),-1);assert.throws(()=>api.compareVersions('5.0.0-beta','5.0.0'));
});
test('selects only exact trusted platform architecture asset with real digest',()=>{
 assert.equal(typeof api?.selectRelease,'function');const selected=api.selectRelease(release(),'5.0.0','darwin','arm64');assert.equal(selected.version,'5.1.0');assert.equal(selected.sha256,digest);
 assert.equal(api.selectRelease(release('5.0.0'),'5.0.0','darwin','arm64').hasUpdate,false);
 assert.equal(api.selectRelease(release('4.4.1'),'5.0.0','darwin','arm64').hasUpdate,false);
 assert.throws(()=>api.selectRelease(release('5.1.0',{prerelease:true}),'5.0.0','darwin','arm64'));
 assert.throws(()=>api.selectRelease(release(),'5.0.0','win32','x64'));
 const r=release();r.assets[0].browser_download_url='https://example.org/package.zip';assert.throws(()=>api.selectRelease(r,'5.0.0','darwin','arm64'));
 const missing=release();delete missing.assets[0].digest;assert.throws(()=>api.selectRelease(missing,'5.0.0','darwin','arm64'));
 const ambiguous=release();ambiguous.assets.push({...ambiguous.assets[0]});assert.throws(()=>api.selectRelease(ambiguous,'5.0.0','darwin','arm64'));
});
function context(t,options={}){
 assert.equal(typeof api?.Updater,'function');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-update-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return new api.Updater({version:'5.0.0',platform:'darwin',arch:'arm64',historyFile:path.join(dir,'history.json'),downloadDir:path.join(dir,'downloads'),now:()=>new Date('2026-10-10T15:59:00Z'),getRelease:async()=>release(),download:async(record,file)=>fs.writeFileSync(file,'valid package'),prepare:async()=>({ready:true}),...options});
}
test('automatic check is once per Shanghai day; failures do not become success and manual retries work',async t=>{
 let calls=0;const u=context(t,{getRelease:async()=>{calls++;throw Error('offline');}});
 await assert.rejects(u.check());assert.equal(u.snapshot().lastAttemptDay,'2026-10-10');assert.equal(u.snapshot().lastSuccessDay,null);
 await u.check();assert.equal(calls,1);await assert.rejects(u.check({manual:true}));assert.equal(calls,2);
 u.getRelease=async()=>release();await u.check({manual:true});assert.equal(u.snapshot().lastSuccessDay,'2026-10-10');
 u.now=()=>new Date('2026-10-10T16:01:00Z');await u.check();assert.equal(u.snapshot().lastAttemptDay,'2026-10-11');
});
test('verified package alone reaches prepare and returns readiness without claiming installed',async t=>{
 let prepared=0;const u=context(t,{prepare:async(record)=>{prepared++;assert.equal(record.sha256,digest);assert.equal(fs.readFileSync(record.file,'utf8'),'valid package');return {ready:true};}});
 const result=await u.stage();assert.equal(prepared,1);assert.equal(result.ready,true);assert.equal(u.snapshot().state,'ready');assert.ok(!u.snapshot().installed);
});
test('cancelled readiness cannot install, duplicate handoff is refused, and handoff failures can be retried',async t=>{
 const u=context(t);assert.throws(()=>u.beginInstall());await u.stage();await u.cancel();assert.equal(u.snapshot().state,'available');assert.throws(()=>u.beginInstall());await u.stage();u.beginInstall();assert.equal(u.snapshot().state,'installing');assert.throws(()=>u.beginInstall());u.failInstall(Error('helper readiness failed'));assert.equal(u.snapshot().state,'error');assert.equal(u.snapshot().error,'helper readiness failed');await u.stage();assert.equal(u.snapshot().state,'ready');
});
test('checking the same release preserves readiness while a changed release explicitly invalidates preparation',async t=>{
 const invalidated=[];const u=context(t,{onReadyInvalidated:async ready=>invalidated.push(ready.version)});await u.stage();await u.check({manual:true});assert.equal(u.snapshot().state,'ready');assert.deepEqual(invalidated,[]);u.getRelease=async()=>release('5.2.0');await u.check({manual:true});assert.equal(u.snapshot().state,'available');assert.deepEqual(invalidated,['5.1.0']);assert.throws(()=>u.beginInstall());await u.stage();u.beginInstall();await assert.rejects(u.check({manual:true}),/交接/);
});
test('cancelling while rechecking cannot revive an aborted ready package',async t=>{
 const u=context(t);await u.stage();let finish;u.getRelease=()=>new Promise(r=>finish=r);const check=u.check({manual:true});await new Promise(r=>setImmediate(r));await u.cancel();finish(release());await check;assert.equal(u.readyRecord,null);assert.equal(u.snapshot().state,'available');assert.throws(()=>u.beginInstall());u.getRelease=async()=>release();await u.stage();assert.equal(u.snapshot().state,'ready');
});
test('a failed recheck aborts old readiness and permits the visible retry action',async t=>{
 const aborted=[];const u=context(t,{onReadyInvalidated:async ready=>aborted.push(ready.version)});await u.stage();u.getRelease=async()=>{throw Error('offline');};await assert.rejects(u.check({manual:true}),/offline/);assert.equal(u.readyRecord,null);assert.equal(u.snapshot().state,'error');assert.deepEqual(aborted,['5.1.0']);u.getRelease=async()=>release();await u.stage();assert.equal(u.snapshot().state,'ready');
});
test('wrong hash deletes partial package and never prepares',async t=>{
 let prepared=0;const u=context(t,{download:async(r,file)=>fs.writeFileSync(file,'tampered'),prepare:async()=>{prepared++;}});
 await assert.rejects(u.stage(),/校验/);assert.equal(prepared,0);assert.equal(u.snapshot().state,'error');assert.ok(!fs.readdirSync(u.downloadDir).some(n=>n.endsWith('.part')));
});
test('duplicate update is rejected and cancellation never prepares',{timeout:10000},async t=>{
 let began,prepared=0;const started=new Promise(resolve=>{began=resolve;});
 const u=context(t,{download:async(r,file,{signal})=>new Promise((res,rej)=>{began();signal.addEventListener('abort',()=>rej(Object.assign(Error('cancelled'),{code:'ABORT_ERR'})),{once:true});}),prepare:async()=>{prepared++;}});
 const pending=u.stage();await Promise.race([started,pending.then(()=>{throw Error('stage ended before download');})]);await assert.rejects(u.stage(),/正在/);await u.cancel();await assert.rejects(pending);assert.equal(prepared,0);
});
test('fresh staging checks latest rather than reusing old cached record',async t=>{
 let version='5.1.0';const u=context(t,{getRelease:async()=>release(version)});await u.check();version='5.2.0';const r=await u.stage();assert.equal(r.version,'5.2.0');
});
test('original downloads are removed after successful and failed prepare',async t=>{
 for(const fail of [false,true]){let downloaded;const u=context(t,{prepare:async r=>{downloaded=r.file;if(fail)throw Error('prepare failed');return {ready:true};}});if(fail)await assert.rejects(u.stage(),/prepare failed/);else await u.stage();assert.equal(fs.existsSync(downloaded),false);assert.deepEqual(fs.readdirSync(u.downloadDir),[]);}
});
test('late preparation after cancellation is invalidated instead of abandoned',async t=>{
 let finish,entered;const started=new Promise(r=>entered=r),invalidated=[];const ready={ready:true,token:'private-token'};const u=context(t,{prepare:()=>{entered();return new Promise(r=>finish=r);},onReadyInvalidated:async value=>invalidated.push(value)});const pending=u.stage();await started;await u.cancel();finish(ready);await assert.rejects(pending,/取消/);assert.equal(invalidated.length,1);assert.equal(invalidated[0].token,ready.token);assert.equal(u.readyRecord,null);assert.deepEqual(fs.readdirSync(u.downloadDir),[]);
});
test('failed cancellation retains readiness privately and blocks new stages until retry succeeds',async t=>{
 let fail=true;const u=context(t,{onReadyInvalidated:async()=>{if(fail)throw Error('cleanup denied');}});const ready=await u.stage();await assert.rejects(u.cancel(),/cleanup denied/);assert.equal(u.snapshot().cleanupPending,true);assert.equal(u.readyRecord,ready);assert.throws(()=>u.beginInstall());await assert.rejects(u.stage());fail=false;await u.cancel();assert.equal(u.readyRecord,null);assert.equal(u.snapshot().cleanupPending,false);await u.stage();
});

test('late cancellation cleanup failure remains retryable after prepare settles',async t=>{
 let finish,enter,fail=true;const start=new Promise(r=>enter=r);const u=context(t,{prepare:()=>{enter();return new Promise(r=>finish=r);},onReadyInvalidated:async()=>{if(fail)throw Error('late cleanup denied');}});const pending=u.stage();await start;await u.cancel();finish({ready:true,token:'late-private'});await assert.rejects(pending,/late cleanup denied/);assert.equal(u.snapshot().cleanupPending,true);assert.equal(u.readyRecord.token,'late-private');assert.deepEqual(fs.readdirSync(u.downloadDir),[]);fail=false;await u.cancel();assert.equal(u.snapshot().cleanupPending,false);
});
test('failed release invalidation retains private cleanup authority until explicit retry',async t=>{
 let fail=true;const u=context(t,{onReadyInvalidated:async()=>{if(fail)throw Error('release cleanup denied');}});const ready=await u.stage();u.getRelease=async()=>release('5.2.0');await assert.rejects(u.check({manual:true}),/release cleanup denied/);assert.equal(u.readyRecord,ready);assert.equal(u.snapshot().cleanupPending,true);fail=false;await u.cancel();await u.stage();assert.equal(u.snapshot().state,'ready');
});
test('download cleanup rejects a replaced file and preserves its bytes for recovery',async t=>{
 let original;const u=context(t,{prepare:async r=>{original=r.file;fs.renameSync(original,original+'.owned');fs.writeFileSync(original,'unrelated replacement');return {ready:true};}});await assert.rejects(u.stage(),/身份已变化/);assert.equal(fs.readFileSync(original,'utf8'),'unrelated replacement');assert.equal(u.snapshot().cleanupPending,true);await assert.rejects(u.cancel(),/身份已变化/);assert.equal(fs.readFileSync(original,'utf8'),'unrelated replacement');fs.unlinkSync(original);fs.renameSync(original+'.owned',original);await u.cancel();assert.equal(fs.existsSync(original),false);
});

test('quit can await late preparation cleanup before ending the process',async t=>{
 let finish,enter;const started=new Promise(r=>enter=r),u=context(t,{prepare:()=>{enter();return new Promise(r=>finish=r);},onReadyInvalidated:async()=>{}});const staging=u.stage();await started;await u.cancel();let settled=false;const waiting=u.waitForStage().then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);finish({ready:true});await assert.rejects(staging,/取消/);await waiting;assert.equal(settled,true);assert.equal(u.snapshot().cleanupPending,false);assert.deepEqual(fs.readdirSync(u.downloadDir),[]);
});

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
test('wrong hash deletes partial package and never prepares',async t=>{
 let prepared=0;const u=context(t,{download:async(r,file)=>fs.writeFileSync(file,'tampered'),prepare:async()=>{prepared++;}});
 await assert.rejects(u.stage(),/校验/);assert.equal(prepared,0);assert.equal(u.snapshot().state,'error');assert.ok(!fs.readdirSync(u.downloadDir).some(n=>n.endsWith('.part')));
});
test('duplicate update is rejected and cancellation never prepares',{timeout:10000},async t=>{
 let began,prepared=0;const started=new Promise(resolve=>{began=resolve;});
 const u=context(t,{download:async(r,file,{signal})=>new Promise((res,rej)=>{began();signal.addEventListener('abort',()=>rej(Object.assign(Error('cancelled'),{code:'ABORT_ERR'})),{once:true});}),prepare:async()=>{prepared++;}});
 const pending=u.stage();await Promise.race([started,pending.then(()=>{throw Error('stage ended before download');})]);await assert.rejects(u.stage(),/正在/);u.cancel();await assert.rejects(pending);assert.equal(prepared,0);
});
test('fresh staging checks latest rather than reusing old cached record',async t=>{
 let version='5.1.0';const u=context(t,{getRelease:async()=>release(version)});await u.check();version='5.2.0';const r=await u.stage();assert.equal(r.version,'5.2.0');
});

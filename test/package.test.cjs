'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {target,verifyDirectory,sha}=require('../scripts/package.cjs');
test('delivery targets distinguish Windows and each Mac CPU without ambiguous defaults',()=>{assert.match(target('darwin','arm64').name,/mac-arm64$/);assert.match(target('darwin','x64').name,/mac-x64$/);assert.match(target('win32','x64').name,/win-x64$/);for(const [p,a]of [['win32','arm64'],['linux','x64'],['darwin','ia32']])assert.throws(()=>target(p,a));});
test('Windows package verification requires the complete x64 application and matching version',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-package-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const source=path.join(dir,'resources/app');for(const f of ['src/main.cjs','src/preload.cjs','src/core/update-install.cjs','ui/index.html','ui/assets/icon.png']){await fs.mkdir(path.dirname(path.join(source,f)),{recursive:true});await fs.writeFile(path.join(source,f),'fixture');}
 await fs.writeFile(path.join(source,'package.json'),JSON.stringify({version:require('../package.json').version}));await fs.writeFile(path.join(dir,'LaoyuNetTools.exe'),'not a PE');await assert.rejects(verifyDirectory(dir,'win32','x64'),/x64 PE/);
 const exe=Buffer.alloc(256);exe.write('MZ');exe.writeUInt32LE(128,0x3c);exe.write('PE\0\0',128);exe.writeUInt16LE(0x8664,132);await fs.writeFile(path.join(dir,'LaoyuNetTools.exe'),exe);assert.equal((await verifyDirectory(dir,'win32','x64')).version,require('../package.json').version);
 await fs.rm(path.join(source,'src/core/update-install.cjs'));await assert.rejects(verifyDirectory(dir,'win32','x64'),/ENOENT/);
});
test('package SHA measures completed raw bytes',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-hash-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'archive.zip');await fs.writeFile(file,'abc');assert.equal(await sha(file),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');});
test('real fixed builder normalizes each packaging pass without mutating shared production configuration',async t=>{
 const api=require('../scripts/package.cjs');assert.equal(typeof api.createBuildConfig,'function');assert.equal(typeof api.cloneBuildConfig,'function');
 const builderDir=path.dirname(require.resolve('electron-builder')),{getConfig}=require(require.resolve('app-builder-lib/out/util/config/config',{paths:[builderDir]})),dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-builder-config-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'nettools-builder-fixture',version:'5.0.0'}));
 const config=api.createBuildConfig({output:path.join(dir,'output'),runtime:path.join(dir,'runtime'),extraResources:[{from:path.join(dir,'feedback.json'),to:'private/feedback-channel.json'}],artifactName:'nettools-fixture-setup.exe'}),original=structuredClone(config);
 const first=await getConfig(dir,undefined,api.cloneBuildConfig(config));const second=await getConfig(dir,undefined,api.cloneBuildConfig(config));
 assert.deepEqual(config,original,'builder mutations must never reach the shared configuration');assert.deepEqual(second.files,first.files);assert.deepEqual(first.files.flatMap(entry=>entry.filter),original.files);assert.deepEqual(second.extraResources,original.extraResources);assert.equal(second.nsis.artifactName,'nettools-fixture-setup.exe');
});

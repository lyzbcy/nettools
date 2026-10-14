'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile);
const source=()=>fs.readFile(path.join(__dirname,'../src/NetRepair.swift'),'utf8');
test('actual macOS stat retirement format retains regular file type and setuid bits',{skip:process.platform!=='darwin'},async()=>{
 const swift=await source(),retirement=swift.slice(swift.indexOf('func legacyRetirement('),swift.indexOf('final class Engine'));
 const format=retirement.match(/stat -f '([^']+)'/)[1],dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-legacy-mode-')),file=path.join(dir,'owned-inert-fixture');
 try{
  await fs.writeFile(file,'owned inert data; never execute\n');await fs.chmod(file,0o4755);
  const observed=(await run('/usr/bin/stat',['-f',format,file])).stdout.trim();
  assert.equal(observed,`${process.getuid()}:104755`,'retirement stat must include full regular/SUID mode');
  for(const mode of [0o755,0o4555,0o6755]){await fs.chmod(file,mode);assert.notEqual((await run('/usr/bin/stat',['-f',format,file])).stdout.trim(),`${process.getuid()}:104755`);}
  await fs.mkdir(path.join(dir,'directory'));await fs.chmod(path.join(dir,'directory'),0o4755);assert.notEqual((await run('/usr/bin/stat',['-f',format,path.join(dir,'directory')])).stdout.trim(),`${process.getuid()}:104755`);
  await fs.symlink(file,path.join(dir,'link'));assert.notEqual((await run('/usr/bin/stat',['-f',format,path.join(dir,'link')])).stdout.trim(),`${process.getuid()}:104755`);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('fixed legacy identity gates remain strict and retirement precedes new grant/helper commit',async()=>{
 const swift=await source();assert.match(swift,/let legacyHelper = "\/usr\/local\/bin\/netrepair-helper"/);assert.match(swift,/9466607886a478331cd53669c799e7e02975840acedcc388c8657e5dd84df7a1/);
 const retirement=swift.slice(swift.indexOf('func legacyRetirement('),swift.indexOf('final class Engine'));
 assert.match(retirement,/lstat\(legacyHelper/);assert.match(retirement,/st.st_uid == 0/);assert.match(retirement,/st.st_mode & S_IFMT == S_IFREG/);assert.match(retirement,/st.st_mode & 0o7777 == 0o4755/);assert.match(retirement,/test ! -L/);assert.match(retirement,/sha256\(legacyHelper\) == legacyHelperHash/);assert.match(retirement,/shasum -a 256/);assert.match(retirement,/'0:104755'/);
 const install=swift.slice(swift.indexOf('let script = ['),swift.indexOf('try admin(script)'));
 assert(install.indexOf('retirement,')<install.indexOf('/bin/mv -f'),'legacy failure must precede new grant/helper commit');
});
test('installation stages old helper and restores it on failure instead of deleting it before commit',async()=>{
 const swift=await source();assert.match(swift,/func installationStageCleanup\(\)/);assert.match(swift,/legacyRetirement\(staged: true\)/);
 assert.match(swift,/LEGACY_RESTORE_FAILED/);assert.match(swift,/LEGACY_RECOVERY_REQUIRED/);assert.match(swift,/legacy-helper/);assert.match(swift,/trap installation_cleanup EXIT/);assert.match(swift,/\/bin\/link/);
});
test('compiled production retirement shell commits or restores only owned inert fixture',{skip:process.platform!=='darwin'},async()=>{
 const {compileEmitter,script,quote}=require('../scripts/legacy-retirement-harness.cjs'),crypto=require('node:crypto'),dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-legacy-shell-')),file=path.join(dir,'legacy'),bytes=Buffer.from('inert owned legacy fixture\n'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 try{
  const binary=await compileEmitter(dir,{file,uid:process.getuid(),sha256:hash});
  const prepare=async()=>{await fs.writeFile(file,bytes);await fs.chmod(file,0o4755);return JSON.parse((await run(binary,[])).stdout);};
  let emission=await prepare(),stage=await fs.mkdtemp(path.join(dir,'stage-'));
  await assert.rejects(run('/bin/sh',['-c',script(stage,emission,'exit 19')]),e=>e.code===19);
  assert.deepEqual(await fs.readFile(file),bytes);assert.equal((await fs.stat(file)).mode&0o7777,0o4755);await assert.rejects(fs.lstat(stage),{code:'ENOENT'});
  emission=await prepare();stage=await fs.mkdtemp(path.join(dir,'stage-'));await run('/bin/sh',['-c',script(stage,emission)]);await assert.rejects(fs.lstat(file),{code:'ENOENT'});await assert.rejects(fs.lstat(stage),{code:'ENOENT'});
  emission=await prepare();stage=await fs.mkdtemp(path.join(dir,'stage-'));
  await assert.rejects(run('/bin/sh',['-c',script(stage,emission,`printf replacement > ${quote(file)}; exit 19`)]),e=>e.code===1&&e.stderr.includes('LEGACY_RESTORE_FAILED'));
  assert.equal(await fs.readFile(file,'utf8'),'replacement');assert.deepEqual(await fs.readFile(path.join(stage,'legacy-helper')),bytes);
  await assert.rejects(run(binary,[]),e=>e.stderr.includes('LEGACY_HELPER_UNVERIFIED'));
  emission=await prepare();stage=await fs.mkdtemp(path.join(dir,'stage-'));await fs.writeFile(file,'changed-after-preflight');await fs.chmod(file,0o4755);
  await assert.rejects(run('/bin/sh',['-c',script(stage,emission)]));assert.equal(await fs.readFile(file,'utf8'),'changed-after-preflight');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('historical helper CI is isolated, fixed-source/hash, and never executes the legacy target',async()=>{
 const saved=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;try{await assert.rejects(require('../scripts/ci-macos-legacy.cjs').main(),/ISOLATED_GITHUB_MAC_ONLY/);}finally{if(saved!==undefined)process.env.GITHUB_ACTIONS=saved;}
 const ci=await fs.readFile(path.join(__dirname,'../scripts/ci-macos-legacy.cjs'),'utf8');assert.match(ci,/413a5f3d5c78adf10154907487a025ac858eba8b/);assert.match(ci,/SIZE=164704/);assert.match(ci,/HISTORICAL_BINARY_IDENTITY/);assert.doesNotMatch(ci,/run\(TARGET|execFile\(TARGET|spawn\(TARGET/);
 const workflow=await fs.readFile(path.join(__dirname,'../.github/workflows/validation.yml'),'utf8');assert(workflow.indexOf('node scripts/ci-macos-legacy.cjs')<workflow.indexOf('node scripts/ci-macos-native.cjs'));
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {verifyWindowsPath,validateWindowsProof}=require('../src/core/update-private-path.cjs');
test('private Windows ownership accepts only own SID or explicitly enabled current admin TokenOwner',()=>{
 const user='S-1-5-21-11-22-33-1001',proof={reparse:false,user,owner:user,tokenOwner:user,adminEnabled:false,allow:[user,'S-1-5-18','S-1-5-32-544']},options={privateRequired:true};assert.equal(validateWindowsProof(proof,options),proof);
 assert.doesNotThrow(()=>validateWindowsProof({...proof,owner:'S-1-5-32-544',tokenOwner:'S-1-5-32-544',adminEnabled:true},options));
 for(const bad of [{owner:'S-1-5-32-544',tokenOwner:'S-1-5-32-544',adminEnabled:false},{owner:'S-1-5-32-544',adminEnabled:true},{owner:'S-1-5-32-545',tokenOwner:'S-1-5-32-545',adminEnabled:true},{allow:[...proof.allow,'S-1-1-0']},{reparse:true}])assert.throws(()=>validateWindowsProof({...proof,...bad},options));
});
test('actual Windows token and owned temporary directory ACL produce read-only proof',{skip:process.platform!=='win32'},async t=>{
 const inherited=process.env.PSModulePath,poisoned=path.join(os.tmpdir(),'deliberately-unavailable-pwsh7-modules');process.env.PSModulePath=poisoned;t.after(()=>{if(inherited===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=inherited;});
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-private-proof-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const before=await fs.lstat(dir,{bigint:true}),proof=await verifyWindowsPath(dir,{privateRequired:true}),after=await fs.lstat(dir,{bigint:true});assert.equal(process.env.PSModulePath,poisoned,'child reset must not change parent or system module paths');assert.equal(before.ino,after.ino);assert.equal(before.dev,after.dev);assert.ok(proof.owner===proof.user||(proof.owner==='S-1-5-32-544'&&proof.tokenOwner==='S-1-5-32-544'&&proof.adminEnabled));
 const target=path.join(dir,'target'),link=path.join(dir,'link');await fs.mkdir(target);await fs.symlink(target,link,'junction');await assert.rejects(verifyWindowsPath(link,{privateRequired:true}),/重解析/);
});
test('Windows proof resets inherited PowerShell module search only in its child script',()=>{
 const {buildWindowsProofScript}=require('../src/core/update-private-path.cjs');assert.equal(typeof buildWindowsProofScript,'function');const script=buildWindowsProofScript("C:\\private\\owned's directory",true);const reset="$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine');";assert.ok(script.indexOf(reset)>=0);assert.ok(script.indexOf(reset)<script.indexOf('Get-Acl'));assert.ok(script.includes("owned''s directory"));
});

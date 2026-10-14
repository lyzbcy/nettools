'use strict';
const path=require('node:path'),fs=require('./raw-fs.cjs').promises,{runProcess}=require('../platform/common.cjs');
function failure(message,proof,options){const error=Error(message);error.pathProof={path:options.file||null,privateRequired:options.privateRequired??false,...proof};return error;}
function validateWindowsProof(proof,{privateRequired=false,file}={}){
 const reject=message=>{throw failure(message,proof,{privateRequired,file});};
 if(!proof||proof.reparse!==false)reject('更新暂存路径包含重解析点');
 if(!privateRequired)return proof;
 if(proof.directory!==true)reject('更新暂存路径不是目录');
 if(![true,'write'].includes(privateRequired))reject('更新目录权限要求无效');
 const elevatedOwner=proof.owner==='S-1-5-32-544'&&proof.tokenOwner==='S-1-5-32-544'&&proof.adminEnabled===true;
 if(typeof proof.user!=='string'||!/^S-1-(?:\d+-)+\d+$/.test(proof.user)||(proof.owner!==proof.user&&!elevatedOwner))reject('更新暂存目录不属于当前用户或当前已提升令牌');
 if(proof.daclPresent!==true||!Array.isArray(proof.aces)||proof.aces.length>512||(privateRequired===true&&proof.protected!==true))reject('更新暂存目录DACL不是可验证的私有目录');
 const trusted=new Set([proof.user,'S-1-5-18','S-1-5-32-544']),readMask=0xA01200A9;
 for(const ace of proof.aces){
  if(ace.unsupported!==false||!['AccessAllowed','AccessDenied'].includes(ace.qualifier)||!Number.isInteger(ace.flags)||ace.flags<0||ace.flags>255||(ace.flags&~31)!==0||!Number.isInteger(ace.rights)||ace.rights<0||ace.rights>0xffffffff||typeof ace.sid!=='string'||!/^S-1-(?:\d+-)+\d+$/.test(ace.sid))reject('更新暂存目录包含无法核实的ACE');
  if(ace.qualifier==='AccessDenied'||trusted.has(ace.sid))continue;
  if(privateRequired===true)reject('更新暂存目录不是私有目录');
  if(ace.flags&8){if(!(ace.flags&3))reject('更新目录继承ACE格式无效');continue;}
  if(((ace.rights>>>0)&(~readMask>>>0))!==0)reject('更新暂存目录允许其他身份写入或替换');
 }
 return proof;
}
function buildWindowsProofScript(file,privateRequired,createdIdentity){
 if(createdIdentity&&(!/^\d+$/.test(createdIdentity.dev)||!/^\d+$/.test(createdIdentity.ino)))throw Error('新目录身份格式无效');
 const literal="'"+file.replaceAll("'","''")+"'",native=require('./update-windows-path-native.cjs');
 const method=createdIdentity?`[UpdatePathProof]::ProtectNew($p,'${createdIdentity.dev}','${createdIdentity.ino}')`:'[UpdatePathProof]::Inspect($p)';
 return `$ErrorActionPreference='Stop';$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine');[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$p=${literal};\nAdd-Type -TypeDefinition @'\n${native}\n'@\n${method}|ConvertTo-Json -Depth 8 -Compress`;
}
async function query(file,privateRequired,createdIdentity){
 if(process.platform!=='win32')throw Error('Windows path proof requires Windows');
 if(createdIdentity&&(!/^\d+$/.test(createdIdentity.dev)||!/^\d+$/.test(createdIdentity.ino)))throw Error('新目录身份格式无效');
 const script=buildWindowsProofScript(file,privateRequired,createdIdentity),powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 try{const result=await runProcess(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeoutMs:15000,maxOutput:256*1024});return validateWindowsProof(JSON.parse(result.stdout),{privateRequired,file});}
 catch(error){if(!error.pathProof)error.pathProof={path:file,privateRequired,error:error.message,stderr:String(error.stderr||'').slice(0,4096)};if(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true')console.error('WINDOWS_UPDATE_PATH_PROOF '+JSON.stringify(error.pathProof));throw error;}
}
async function verifyWindowsPath(file,{privateRequired=false}={}){return query(file,privateRequired);}
async function identity(file){const stat=await fs.lstat(file,{bigint:true});if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('新目录类型或链接无效');return {dev:String(stat.dev),ino:String(stat.ino)};}
async function protectCreatedWindowsDirectory(file,createdIdentity){
 if(JSON.stringify(await identity(file))!==JSON.stringify(createdIdentity))throw Error('新目录身份发生变化');
 await query(file,true,createdIdentity);
 if(JSON.stringify(await identity(file))!==JSON.stringify(createdIdentity))throw Error('新目录身份发生变化');
 return verifyWindowsPath(file,{privateRequired:true});
}
async function ensureWindowsPrivateDirectory(file,{privateRequired='write'}={}){
 if(process.platform!=='win32'||typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||/[\x00-\x1f]/.test(file))throw Error('Windows新目录路径无效');
 const parent=path.dirname(file);if(parent!==file){try{await identity(parent);}catch(error){if(error.code!=='ENOENT')throw error;await ensureWindowsPrivateDirectory(parent);}await verifyWindowsPath(parent,{privateRequired:false});}
 let created=false;try{await fs.mkdir(file,{mode:0o700});created=true;}catch(error){if(error.code==='ENOENT'){await ensureWindowsPrivateDirectory(path.dirname(file));return ensureWindowsPrivateDirectory(file,{privateRequired});}if(error.code!=='EEXIST')throw error;}
 if(created){const own=await identity(file);await protectCreatedWindowsDirectory(file,own);}else await verifyWindowsPath(file,{privateRequired});
 return fs.realpath(file);
}
async function createWindowsPrivateAttempt(parent){if(process.platform!=='win32'||typeof parent!=='string'||!path.isAbsolute(parent)||path.resolve(parent)!==parent)throw Error('Windows新目录路径无效');await verifyWindowsPath(parent,{privateRequired:'write'});const file=await fs.mkdtemp(path.join(parent,'install-'));await protectCreatedWindowsDirectory(file,await identity(file));return file;}
module.exports={verifyWindowsPath,validateWindowsProof,buildWindowsProofScript,ensureWindowsPrivateDirectory,createWindowsPrivateAttempt};

'use strict';
const path=require('node:path'),{runProcess}=require('../platform/common.cjs');
function validateWindowsProof(proof,{privateRequired=false}={}){
 if(!proof||proof.reparse!==false)throw Error('更新暂存路径包含重解析点');
 if(!privateRequired)return proof;
 const elevatedOwner=proof.owner==='S-1-5-32-544'&&proof.tokenOwner==='S-1-5-32-544'&&proof.adminEnabled===true;
 if(typeof proof.user!=='string'||!/^S-1-(?:\d+-)+\d+$/.test(proof.user)||(proof.owner!==proof.user&&!elevatedOwner))throw Error('更新暂存目录不属于当前用户或当前已提升令牌');
 if(!Array.isArray(proof.allow)||proof.allow.some(sid=>![proof.user,'S-1-5-18','S-1-5-32-544'].includes(sid)))throw Error('更新暂存目录不是私有目录');
 return proof;
}
// Read-only ACL/reparse proof. This never changes directory permissions.
async function verifyWindowsPath(file,{privateRequired=false}={}){
 if(process.platform!=='win32')throw Error('Windows path proof requires Windows');
 const literal="'"+file.replaceAll("'","''")+"'";
 const script=`$ErrorActionPreference='Stop';$p=${literal};$item=Get-Item -LiteralPath $p -Force;$proof=@{reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)};${privateRequired?`$acl=Get-Acl -LiteralPath $p;$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$proof.user=$identity.User.Value;$proof.owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$proof.tokenOwner=$identity.Owner.Value;$proof.adminEnabled=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);$proof.allow=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.AccessControlType -eq 'Allow'}|ForEach-Object {$_.IdentityReference.Value});`:''}$proof|ConvertTo-Json -Depth 4 -Compress`;
 const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const result=await runProcess(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeoutMs:15000,maxOutput:4096});
 return validateWindowsProof(JSON.parse(result.stdout),{privateRequired});
}
module.exports={verifyWindowsPath,validateWindowsProof};

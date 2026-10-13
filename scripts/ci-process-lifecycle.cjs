'use strict';
// Verification only: never signal a PID or alter a running update attempt.
const {setTimeout:delay}=require('node:timers/promises');
function decodedCommand(identity){const match=identity?.command?.match(/-EncodedCommand\s+([a-z\d+/=]+)/i);return match?Buffer.from(match[1],'base64').toString('utf16le'):identity?.command||'';}
const creation=identity=>typeof identity?.created==='string'&&identity.created.trim().length>0;
function classifyInstance(expected,observed,{commandIncludes,queryError}={}){
 if(queryError||observed?.queryError||observed?.queryUnavailable)return 'query-failed';
 if(expected?.exists!==true||!creation(expected))return 'expected-creation-unavailable';
 if(observed?.exists===false)return 'disappeared';
 if(observed?.exists!==true)return 'query-failed';
 if(!creation(observed))return 'current-creation-unavailable';
 if(observed.created!==expected.created)return 'replaced';
 if(observed.state?.startsWith('Z'))return 'zombie';
 const command=decodedCommand(observed),bound=decodedCommand(expected);
 if(!bound||!command||(commandIncludes?(!bound.includes(commandIncludes)||!command.includes(commandIncludes)):command!==bound))return 'command-mismatch';
 return 'live';
}
function lifecycleError(sample,timeout=false){return Object.assign(Error(timeout?'CI 已绑定进程退出等待超时':'CI 进程生命周期身份无法确认：'+sample.relation),{code:timeout?'CI_PROCESS_TIMEOUT':'CI_PROCESS_IDENTITY',lifecycle:sample});}
function bindReadyIdentity(identity,attempt){const sample={expected:identity,observed:identity,relation:typeof attempt==='string'&&attempt.length?classifyInstance(identity,identity,{commandIncludes:attempt}):'command-mismatch'};if(sample.relation!=='live')throw lifecycleError(sample);return identity;}
function parseMacProcessIdentity(output){const row=output.trim();if(!row)return {exists:false};const match=row.match(/^(.{24})\s+(\S+)(?:\s+(.*))?$/);if(!match)throw Error('CI Mac 进程创建身份无法读取');return {exists:true,created:match[1],state:match[2],command:match[3]||''};}
async function waitBoundInstanceExit({pid,expected,commandIncludes,query,pause=delay,timeout=180000,now=Date.now,onSample=()=>{}}){
 if(!Number.isInteger(pid)||pid<2||pid>2147483647)throw Error('CI 进程号无效');
 const end=now()+timeout;
 while(true){
  let observed=null,queryError=null;try{observed=await query(pid);}catch(error){queryError=error.message;}
  const sample={pid,expected,observed,relation:classifyInstance(expected,observed,{commandIncludes,queryError}),queryError,captureAt:new Date().toISOString()};
  await onSample(sample);
  if(['disappeared','zombie','replaced'].includes(sample.relation))return sample;
  if(sample.relation!=='live')throw lifecycleError(sample);
  if(now()>=end)throw lifecycleError(sample,true);
  await pause(100);
 }
}
module.exports={decodedCommand,classifyInstance,bindReadyIdentity,parseMacProcessIdentity,waitBoundInstanceExit};

'use strict';
// Passive copies of fixed CI control files. Never write into an update attempt.
const raw=require('../src/core/raw-fs.cjs'),fs=raw.promises,path=require('node:path'),crypto=require('node:crypto'),{setTimeout:delay}=require('node:timers/promises'),ci=require('../src/core/update-desktop-acceptance.cjs');
const {classifyInstance,decodedCommand,bindReadyIdentity}=require('./ci-process-lifecycle.cjs');
const fields={readyFile:'ready.json',commitFile:'commit.json',abortFile:'abort.json',resultFile:'result.json',confirmRequestFile:'confirm-request.json',confirmFile:'confirmed.json'};
const limits={'payload.json':16*1024*1024,...Object.fromEntries(Object.values(fields).map(name=>[name,256*1024])),'handoff.lock':1024,'worker.log':2*1024*1024,'task.log':2*1024*1024,'worker-error.log':2*1024*1024};
async function physicalBytes(root,file,max){
 ci.privatePath(root,file,{kind:'file'});const before=await fs.lstat(file);if(before.nlink!==1||before.size>max)throw Error('证据文件大小或硬链接无效');
 const handle=await fs.open(file,raw.constants.O_RDONLY|(raw.constants.O_NOFOLLOW||0));try{const opened=await handle.stat();if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>max)throw Error('证据文件身份改变');const chunks=[];let total=0;while(total<=max){const buffer=Buffer.alloc(Math.min(65536,max+1-total)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>max)throw Error('证据文件大小改变');chunks.push(buffer.subarray(0,bytesRead));}const after=await fs.lstat(file);if(after.isSymbolicLink()||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==total||after.mtimeMs!==before.mtimeMs)throw Error('证据文件读取期间改变');return Buffer.concat(chunks,total);}finally{await handle.close();}
}
const json=bytes=>JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
async function readActorFailure({plan,driverPid}){
 const file=path.join(plan.caseRoot,'error.json');let report;try{report=json(await physicalBytes(plan.caseRoot,file,256*1024));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
 if(report.nonce!==plan.nonce||report.ok!==false||!Number.isInteger(report.pid)||report.pid<2||typeof report.error!=='string'||!['drive','confirmed','rollback'].includes(report.role))throw Error('CI actor 错误报告身份不匹配');
 if(driverPid!==undefined){if(report.role!=='drive')return null;if(report.pid!==driverPid)throw Error('CI actor 原进程身份不匹配');}
 return Object.assign(Error('实际 Electron actor 失败：'+report.error),{code:'CI_ACTOR_FAILED',actor:report});
}
async function waitOriginalClose({application,plan,driverPid}){
 const abort=new AbortController();const polling=(async()=>{while(true){const failure=await readActorFailure({plan,driverPid});if(failure)throw failure;await delay(100,undefined,{signal:abort.signal});}})();polling.catch(()=>{});
 try{const closed=await Promise.race([application.closed,polling]);const failure=await readActorFailure({plan,driverPid});if(failure)throw failure;return closed;}catch(error){const failure=await readActorFailure({plan,driverPid});if(failure)throw failure;throw error;}finally{abort.abort();await polling.catch(()=>{});}
}
async function waitHelperReady({plan,driver,queryProcess,timeout=120000,now=Date.now,pause=delay,onSample=()=>{}}){
 if(driver?.nonce!==plan.nonce||driver.role!=='drive'||driver.ok!==true||!Number.isInteger(driver.pid)||driver.pid<2||!/^[a-f0-9]{64}$/.test(driver.ready?.token||'')||driver.ready.version!==plan.targetVersion)throw Error('CI driver 准备身份不匹配');
 const attempt=ci.privatePath(plan.dataDir,driver.ready.attempt,{kind:'directory'});
 if(path.dirname(attempt)!==path.join(plan.dataDir,'updates')||!/^install-[a-z0-9]+$/i.test(path.basename(attempt))||driver.ready.payloadFile!==path.join(attempt,'payload.json'))throw Error('CI 更新尝试路径不匹配');
 async function payload(){const value=json(await physicalBytes(attempt,driver.ready.payloadFile,limits['payload.json']));if(value.protocol!==1||value.token!==driver.ready.token||value.attempt!==attempt||value.dataDir!==plan.dataDir||value.target!==plan.installPath||value.platform!==plan.platform||value.arch!==plan.arch||value.version!==plan.targetVersion||value.oldVersion!==plan.driveVersion||Object.entries(fields).some(([field,name])=>value[field]!==path.join(attempt,name)))throw Error('CI payload 身份或固定路径不匹配');return value;}
 // driver.json describes preparation; oldPid and ready.json arrive only after handoff starts.
 const prepared=await payload(),end=now()+timeout;
 while(true){
  const failure=await readActorFailure({plan,driverPid:driver.pid});if(failure)throw failure;
  let ready,readyPresent=false;try{ready=json(await physicalBytes(attempt,prepared.readyFile,limits['ready.json']));readyPresent=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(readyPresent){
   if(!ready||ready.token!==prepared.token||ready.version!==prepared.version||ready.status!=='ready'||!Number.isInteger(ready.pid)||ready.pid<2||ready.pid>2147483647)throw Object.assign(Error('CI 助手就绪握手身份不匹配'),{code:'CI_HELPER_READY_IDENTITY'});
   const handed=await payload();if(handed.oldPid!==driver.pid)throw Object.assign(Error('CI 助手交接旧PID不匹配'),{code:'CI_HELPER_READY_IDENTITY'});
   const actorFailure=await readActorFailure({plan,driverPid:driver.pid});if(actorFailure)throw actorFailure;
   let identity;try{identity=await queryProcess(ready.pid);}catch(error){identity={queryError:error.message};}
   const sample={pid:ready.pid,expected:identity,observed:identity,relation:classifyInstance(identity,identity,{commandIncludes:attempt}),queryError:identity?.queryError||null,captureAt:new Date().toISOString()};
   await onSample(sample);bindReadyIdentity(identity,attempt);return {payload:handed,ready,identity};
  }
  if(now()>=end)throw Object.assign(Error('CI 助手就绪握手等待超时'),{code:'CI_HELPER_READY_TIMEOUT'});
  await pause(100);
 }
}
async function exportUpdateEvidence({env=process.env,plan,driver,reportDir,phase,snapshot,queryProcess=async()=>({queryUnavailable:true}),expectedProcesses={},lifecycleSamples=[]}){
 if(env.CI!=='true'||!path.isAbsolute(env.RUNNER_TEMP||'')||!/^[a-f0-9]{64}$/.test(plan.nonce||'')||plan.platform!==process.platform||plan.arch!==process.arch||!['success','rollback'].includes(plan.scenario)||!['before-cleanup','after-process-exit'].includes(snapshot))throw Error('仅允许真实私有 CI 证据');
 const runner=await fs.realpath(env.RUNNER_TEMP),suite=ci.privatePath(runner,plan.suiteRoot,{kind:'directory'}),data=ci.privatePath(suite,plan.dataDir,{kind:'directory'});ci.privatePath(suite,plan.caseRoot,{kind:'directory'});ci.privatePath(suite,plan.installPath,{kind:'directory',missing:true});const overlap=(a,b)=>a===b||ci.inside(a,b)||ci.inside(b,a);if(overlap(plan.caseRoot,data)||overlap(plan.caseRoot,plan.installPath)||overlap(data,plan.installPath))throw Error('CI 安装、数据与证据目录重叠');
 if(driver?.nonce!==plan.nonce||driver.role!=='drive'||driver.ok!==true||!Number.isInteger(driver.pid)||driver.pid<2||!/^[a-f0-9]{64}$/.test(driver.ready?.token||'')||driver.ready.version!==plan.targetVersion)throw Error('CI driver 准备身份不匹配');
 const attempt=ci.privatePath(data,driver.ready.attempt,{kind:'directory'});if(path.dirname(attempt)!==path.join(data,'updates')||!/^install-[a-z0-9]+$/i.test(path.basename(attempt))||driver.ready.payloadFile!==path.join(attempt,'payload.json'))throw Error('CI 更新尝试路径不匹配');
 const payloadBytes=await physicalBytes(attempt,driver.ready.payloadFile,limits['payload.json']),payload=json(payloadBytes);
 if(payload.protocol!==1||payload.token!==driver.ready.token||payload.attempt!==attempt||payload.dataDir!==data||payload.target!==plan.installPath||payload.platform!==plan.platform||payload.arch!==plan.arch||payload.version!==plan.targetVersion||payload.oldVersion!==plan.driveVersion||Object.entries(fields).some(([field,name])=>payload[field]!==path.join(attempt,name)))throw Error('CI payload 身份或固定路径不匹配');
 const root=path.resolve(reportDir);raw.lstatSync(root);if(raw.realpathSync(root)!==root||raw.lstatSync(root).isSymbolicLink()||!raw.lstatSync(root).isDirectory()||root===suite||ci.inside(suite,root)||ci.inside(root,suite))throw Error('CI 证据输出不得与临时现场重叠');
 const destination=ci.privatePath(root,path.join(root,plan.scenario,'helper',snapshot),{kind:'directory',missing:true});await fs.mkdir(destination,{recursive:true,mode:0o700});
 const report={protocol:1,nonce:plan.nonce,token:payload.token,bound:true,phase,snapshot,captureAt:new Date().toISOString(),attempt,destination,files:[],processes:[]},parsed={};
 for(const [name,max] of Object.entries(limits)){
  const file=path.join(attempt,name),entry={name,exists:null,size:null,sha256:null,captureAt:new Date().toISOString(),captured:false,readError:null};try{const stat=await fs.lstat(file);entry.exists=true;entry.size=stat.size;const bytes=name==='payload.json'?payloadBytes:await physicalBytes(attempt,file,max);entry.size=bytes.length;entry.sha256=crypto.createHash('sha256').update(bytes).digest('hex');const target=ci.privatePath(destination,path.join(destination,name),{kind:'file',missing:true});await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});entry.captured=true;if(name.endsWith('.json'))try{parsed[name]=json(bytes);}catch(error){entry.parseError=error.message;}}catch(error){if(error.code==='ENOENT')entry.exists=false;else entry.readError=error.message;}report.files.push(entry);
 }
 const pids=[['original',driver.pid]],bound=record=>record?.token===payload.token&&record.version===payload.version;
 if(bound(parsed['ready.json']))pids.push(['helper-ready',parsed['ready.json'].pid]);if(bound(parsed['result.json'])){pids.push(['updated',parsed['result.json'].newPid],['reopened',parsed['result.json'].reopenPid]);}if(bound(parsed['confirmed.json']))pids.push(['confirmed',parsed['confirmed.json'].pid]);
 const options=role=>role==='helper-ready'?{commandIncludes:attempt}:{};
 for(const [role,pid] of pids){if(!Number.isInteger(pid)||pid<2||pid>2147483647)continue;const expected=expectedProcesses[role]||null,entry={role,pid,expected,observed:null,relation:'unknown',queryError:null};try{entry.observed=await queryProcess(pid);}catch(error){entry.queryError=error.message;}entry.relation=expected?classifyInstance(expected,entry.observed,{...options(role),queryError:entry.queryError}):entry.queryError||entry.observed?.queryUnavailable?'query-failed':entry.observed?.exists===false?'not-running':'unbound';report.processes.push(entry);}
 report.lifecycleSamples=[];
 for(const sample of lifecycleSamples){const expected=expectedProcesses[sample.role];if(!pids.some(([role,pid])=>role===sample.role&&pid===sample.pid)||!expected||sample.expected?.created!==expected.created||sample.expected?.command!==expected.command||sample.role==='helper-ready'&&!decodedCommand(expected).includes(attempt))throw Error('CI 生命周期样本源身份不匹配');const relation=classifyInstance(expected,sample.observed,{...options(sample.role),queryError:sample.queryError});report.lifecycleSamples.push({...sample,expected,relation});}
 await ci.atomic(path.join(destination,'evidence-manifest.json'),report);return report;
}
module.exports={physicalBytes,readActorFailure,waitOriginalClose,waitHelperReady,exportUpdateEvidence};

'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),run=promisify(execFile);
const {compileEmitter,script,quote}=require('./legacy-retirement-harness.cjs');
const COMMIT='413a5f3d5c78adf10154907487a025ac858eba8b',OBJECT='捞鱼的网络工具.app/Contents/Resources/netrepair-helper',HASH='9466607886a478331cd53669c799e7e02975840acedcc388c8657e5dd84df7a1',SIZE=164704,TARGET='/usr/local/bin/netrepair-helper';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function absent(file){try{await fs.lstat(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
async function exact(file){const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o7777)!==0o4755||st.size!==SIZE||hash(await fs.readFile(file))!==HASH)throw Error('LEGACY_FIXTURE_IDENTITY');}
async function main(){
 if(process.platform!=='darwin'||process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true')throw Error('ISOLATED_GITHUB_MAC_ONLY');
 const root=path.resolve(__dirname,'..'),report={ok:false,scope:'CI owned historical legacy-helper retirement only; never execute historical binary; not user consent or full installer acceptance',arch:process.arch,source:COMMIT,legacySha256:HASH,steps:[]},stages=[];
 let temp,created=false;
 try{
  if(!await absent(TARGET))throw Error('LEGACY_TARGET_ALREADY_EXISTS');
  for(const parent of ['/usr/local','/usr/local/bin']){const st=await fs.lstat(parent);if(!st.isDirectory()||st.isSymbolicLink())throw Error('LEGACY_PARENT_UNSAFE');}
  temp=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-legacy-ci-'));
  try{await run('/usr/bin/git',['cat-file','-e',`${COMMIT}:${OBJECT}`],{cwd:root});}catch{await run('/usr/bin/git',['fetch','--no-tags','--depth=1','origin',COMMIT],{cwd:root});}
  const {stdout:bytes}=await run('/usr/bin/git',['show',`${COMMIT}:${OBJECT}`],{cwd:root,encoding:'buffer',maxBuffer:1024*1024});
  if(bytes.length!==SIZE||hash(bytes)!==HASH)throw Error('HISTORICAL_BINARY_IDENTITY');
  const fixture=path.join(temp,'historical-helper');await fs.writeFile(fixture,bytes,{mode:0o600});
  const emitter=await compileEmitter(temp);
  created=true;await run('/usr/bin/sudo',['/usr/bin/install','-o','root','-g','wheel','-m','4755',fixture,TARGET]);await exact(TARGET);
  const stat=(await run('/usr/bin/stat',['-f','%u:%Op',TARGET])).stdout.trim();if(stat!=='0:104755')throw Error('FULL_MODE_MISMATCH');report.fullStat=stat;
  const emission=JSON.parse((await run(emitter,[])).stdout);
  for(const failure of [true,false]){
   const stage=(await run('/usr/bin/sudo',['/usr/bin/mktemp','-d','/private/tmp/nettools-legacy-ci-stage.XXXXXX'])).stdout.trim();stages.push(stage);
   if(!/^\/private\/tmp\/nettools-legacy-ci-stage\.[A-Za-z0-9]+$/.test(stage))throw Error('INVALID_STAGE');
   let exit=0;try{await run('/usr/bin/sudo',['/bin/sh','-c',script(stage,emission,failure?'exit 19':':')]);}catch(e){exit=e.code;}
   if(failure){if(exit!==19)throw Error('LEGACY_FAILURE_NOT_PROPAGATED');await exact(TARGET);report.steps.push({name:'actual-root-original-restored-after-post-retirement-failure',ok:true});}
   else{if(exit!==0||!await absent(TARGET))throw Error('LEGACY_RETIREMENT_NOT_COMMITTED');report.steps.push({name:'actual-root-original-retired-after-commit',ok:true});}
   await run('/usr/bin/sudo',['/bin/sh','-c',`test ! -e ${quote(stage)}`]);
  }
  report.ok=true;
 }catch(error){report.error={code:error.code||'LEGACY_CI_FAILED',message:String(error.message).slice(0,2048)};throw error;}
 finally{
  try{
   if(created&&!await absent(TARGET)){await exact(TARGET);await run('/usr/bin/sudo',['/bin/rm','-f',TARGET]);}
   for(const stage of stages){
    if(await absent(stage))continue;
    // Do not recursively remove a stage whose contents could no longer be proven.
    const saved=path.join(stage,'legacy-helper');
    await run('/usr/bin/sudo',['/bin/sh','-c',`test ! -L ${quote(stage)} && test "$(/usr/bin/stat -f '%u:%Op' ${quote(stage)})" = '0:40700' && if test -e ${quote(saved)}; then test ! -L ${quote(saved)} && test "$(/usr/bin/stat -f '%u:%Op' ${quote(saved)})" = '0:104755' && test "$(/usr/bin/shasum -a 256 ${quote(saved)} | /usr/bin/cut -d ' ' -f 1)" = '${HASH}' && /bin/rm ${quote(saved)}; fi && /bin/rmdir ${quote(stage)}`]);
   }
   report.cleanup=true;
  }catch(error){report.ok=false;report.cleanup=false;report.cleanupError=String(error.message).slice(0,2048);process.exitCode=1;}
  if(temp)await fs.rm(temp,{recursive:true,force:true});const out=path.join(root,`verification/macos-${process.arch}`);await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'legacy-retirement-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}
module.exports={main};if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});

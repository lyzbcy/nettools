'use strict';
// Read-only system fixture. All writes belong to one private temporary test root.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const role=process.argv[2],s=JSON.parse(process.argv[3]),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
if(!['parent','child'].includes(role)||!uuid.test(s.nonce)||!path.isAbsolute(s.root)||fs.realpathSync(s.root)!==s.root||typeof s.failResponse!=='boolean')throw Error('Invalid private fixture settings');
for(const key of ['readyFile','heartbeatFile','stopFile','launchFile','requestFile','responseFile','exitFile','stderrFile'])if(path.dirname(s[key])!==s.root)throw Error('Fixture path escaped its private root');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
if(role==='parent'){
 const log=fs.openSync(s.stderrFile,'wx',0o600);let child;try{child=spawn(process.execPath,[__filename,'child',JSON.stringify(s)],{detached:true,windowsHide:true,stdio:['ignore','ignore',log]});}finally{fs.closeSync(log);}
 const spawned=Number.isInteger(child.pid)&&child.pid>0;write(s.launchFile,{nonce:s.nonce,pid:spawned?child.pid:null,spawned});child.on('error',error=>{console.error(error.stack);process.exit(1);});child.unref();let acknowledged=false;
 setInterval(()=>{if(acknowledged)return;const ack=read(s.readyFile);if(ack?.nonce===s.nonce&&ack.pid===child.pid){acknowledged=true;process.stdout.write(JSON.stringify(ack)+'\n');}},20);
}else{
 let beat=0,initialized=false,responded=false,failure=null;
 process.on('uncaughtExceptionMonitor',error=>{failure={errorCode:error.code||null,message:error.message};});
 process.on('exit',code=>{try{write(s.exitFile,{nonce:s.nonce,pid:process.pid,code,beat,...failure});}catch(error){fs.writeSync(2,'Fixture exit record failed: '+error.message+'\n');}});
 setInterval(()=>{
  if(read(s.stopFile)?.nonce===s.nonce)process.exit(0);beat++;
  if(!initialized){write(s.heartbeatFile,{nonce:s.nonce,pid:process.pid,beat});write(s.readyFile,{nonce:s.nonce,pid:process.pid});initialized=true;}
  const request=read(s.requestFile);
  if(!responded&&request?.nonce===s.nonce&&uuid.test(request.challenge)){
   if(s.failResponse)throw Object.assign(Error('FIXTURE_RESPONSE_IO: private response write failed'),{code:'FIXTURE_RESPONSE_IO'});
   write(s.responseFile,{nonce:s.nonce,pid:process.pid,challenge:request.challenge,beat});responded=true;
  }
 },20);
 setTimeout(()=>process.exit(2),15000);
}

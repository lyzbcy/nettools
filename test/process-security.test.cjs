'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let api;try{api=require('../src/platform/common.cjs');}catch{}
test('typed actions reject unknown commands, invalid IP/CIDR/domain and unexpected fields',()=>{
 assert.equal(typeof api?.validateRequest,'function');
 assert.deepEqual(api.validateRequest('set-dns',{primary:'223.5.5.5',secondary:'223.6.6.6'}),{primary:'223.5.5.5',secondary:'223.6.6.6'});
 for(const bad of [{primary:'256.1.1.1'},{primary:'1.1.1.1;id'},{primary:'1.1.1.1',path:'/etc/passwd'}])assert.throws(()=>api.validateRequest('set-dns',bad));
 assert.throws(()=>api.validateRequest('execute',{command:'id'}));
 assert.throws(()=>api.validateRequest('save-config',{config:{company:{intranetCIDR:'10.0.0.0/99'}}}));
 assert.throws(()=>api.validateRequest('save-config',{config:{company:{resolverDomain:'../outside'}}}));
 assert.throws(()=>api.validateRequest('save-config',{config:{company:{internalHost:'x;id'}}}));
 assert.throws(()=>api.validateRequest('save-config',{config:{vpn:{configName:'/disconnect'}}}));
 assert.throws(()=>api.validateRequest('restart-system',{}));
});
test('runner executes argv literally, accepts stdin JSON, and checks exit status',async()=>{
 assert.equal(typeof api?.runProcess,'function');
 const r=await api.runProcess(process.execPath,['-e','process.stdin.on("data",d=>process.stdout.write(d));','literal;$(id)'],{input:'{"action":"read"}',timeoutMs:2000});
 assert.equal(r.stdout,'{"action":"read"}');
 await assert.rejects(api.runProcess(process.execPath,['-e','process.exit(7)'],{timeoutMs:2000}),e=>e.code==='PROCESS_EXIT'&&e.exitCode===7);
});
test('output cap terminates the process rather than growing memory',async()=>{
 assert.equal(typeof api?.runProcess,'function');
 await assert.rejects(api.runProcess(process.execPath,['-e','setInterval(()=>process.stdout.write("x".repeat(8192)),1)'],{maxOutput:1024,timeoutMs:2000}),e=>e.code==='OUTPUT_LIMIT');
});
test('abort waits for delayed child cleanup before returning',{skip:process.platform==='win32'},async()=>{
 assert.equal(typeof api?.runProcess,'function');const controller=new AbortController();let ready;
 const started=new Promise(r=>ready=r),begin=Date.now();
 const p=api.runProcess(process.execPath,['-e','process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),180));process.stdout.write("ready");setInterval(()=>{},1000);'],{signal:controller.signal,timeoutMs:5000,onStdout:b=>{if(b.toString().includes('ready'))ready();}});
 await started;controller.abort();await assert.rejects(p,e=>e.code==='ABORT_ERR');assert.ok(Date.now()-begin>=170);
});
test('timeout kills descendants holding output open and reaps ignored TERM',async t=>{
 assert.equal(typeof api?.runProcess,'function');
 if(process.platform==='win32'){t.skip('POSIX fixture; Windows uses taskkill tree');return;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-process-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const pidFile=path.join(dir,'child.pid'),nonce=require('node:crypto').randomUUID();
 const timeoutMs=5000,cleanupBudgetMs=2500-200;let acknowledge,output='',readyPid=0;const started=new Promise(resolve=>acknowledge=resolve);
 // Cold Intel CI can take longer than the old 200ms to start two Node processes.
 // The descendant itself confirms its TERM handler and inherited output are ready.
 const child='process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({nonce:'+JSON.stringify(nonce)+',pid:process.pid})+"\\n");setInterval(()=>{},1000);setTimeout(()=>process.exit(2),15000);';
 const script='const fs=require("fs"),cp=require("child_process");process.on("SIGTERM",()=>{});const p=cp.spawn(process.execPath,["-e",'+JSON.stringify(child)+'],{stdio:["ignore",process.stdout,process.stderr]});fs.writeFileSync('+JSON.stringify(pidFile)+',String(p.pid));setInterval(()=>{},1000);setTimeout(()=>process.exit(2),15000);';
 const begin=performance.now(),pending=api.runProcess(process.execPath,['-e',script],{timeoutMs,onStdout:chunk=>{output+=chunk.toString();if(output.includes('\n')&&!readyPid){const ack=JSON.parse(output.trim());if(ack.nonce===nonce&&Number.isInteger(ack.pid)&&ack.pid>1){readyPid=ack.pid;acknowledge();}}}});pending.catch(()=>{});
 await Promise.race([started,pending.then(()=>{throw Error('fixture exited before descendant readiness');},error=>{throw Object.assign(Error('fixture timed out before descendant readiness'),{cause:error});})]);assert.equal(Number(fs.readFileSync(pidFile,'utf8')),readyPid);
 await assert.rejects(pending,e=>e.code==='PROCESS_TIMEOUT');const elapsed=performance.now()-begin;assert.ok(elapsed>=timeoutMs-25,'production timeout must not fire early');assert.ok(elapsed-timeoutMs<cleanupBudgetMs,'cleanup keeps the original post-timeout budget');
 const pid=Number(fs.readFileSync(pidFile,'utf8'));let gone=false;for(let i=0;i<20;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){gone=true;break;}}await new Promise(r=>setTimeout(r,50));}assert.ok(gone,'descendant must be reaped');
});

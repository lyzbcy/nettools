'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {Cdp,launchConfig,cleanupConfirmed,suiteProcessScript,terminationScript}=require('../scripts/ci-frozen-windows-native.cjs');
async function endpoint(t,respond){
 const server=http.createServer();const sockets=new Set();
 server.on('upgrade',(req,socket)=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');let buffered=Buffer.alloc(0);const send=value=>{const payload=Buffer.from(JSON.stringify(value));assert.ok(payload.length<126);socket.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]));};socket.on('data',data=>{buffered=Buffer.concat([buffered,data]);while(buffered.length>=6){const size=buffered[1]&127;if(size>=126)throw Error('Test frame unexpectedly large');if(buffered.length<6+size)return;const mask=buffered.subarray(2,6),payload=Buffer.from(buffered.subarray(6,6+size));buffered=buffered.subarray(6+size);for(let i=0;i<size;i++)payload[i]^=mask[i%4];if(payload.length)respond(JSON.parse(payload),send,socket);}});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});return `ws://127.0.0.1:${server.address().port}/devtools/page/private`;
}
test('CDP rejects a remote endpoint before connecting',async()=>{await assert.rejects(()=>Cdp.connect('ws://example.com:9222/devtools/page/x'),/loopback/);});
test('CDP matches actual WebSocket replies and ignores events',async t=>{const url=await endpoint(t,(msg,send)=>{send({method:'Runtime.event',params:{}});send({id:msg.id,result:{method:msg.method}});});const client=await Cdp.connect(url);t.after(()=>client.close());assert.deepEqual(await client.send('Page.enable'),{method:'Page.enable'});});
test('CDP surfaces protocol errors',async t=>{const url=await endpoint(t,(msg,send)=>send({id:msg.id,error:{message:'not supported'}}));const client=await Cdp.connect(url);t.after(()=>client.close());await assert.rejects(()=>client.send('Page.enable'),/not supported/);});
test('CDP bounds unanswered calls',async t=>{const url=await endpoint(t,()=>{});const client=await Cdp.connect(url);t.after(()=>client.close());await assert.rejects(()=>client.send('Page.enable',{},30),/timeout/);});
test('CDP rejects pending calls when connection closes',async t=>{const url=await endpoint(t,(_msg,_send,socket)=>socket.destroy());const client=await Cdp.connect(url);await assert.rejects(()=>client.send('Page.enable'),/closed/);});
test('normal launch has only private data and loopback debugging flags',()=>{const value=launchConfig('C:\\private\\data',4567,{NETTOOLS_ACCEPTANCE_DIR:'x',NETTOOLS_UPDATE_ACCEPTANCE_PLAN:'x',NETTOOLS_UPDATE_ACCEPTANCE_NONCE:'x',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'bad',CI:'true'});assert.deepEqual(value.args,['--nettools-data=C:\\private\\data','--remote-debugging-address=127.0.0.1','--remote-debugging-port=4567']);assert.deepEqual(value.env,{CI:'true'});assert.throws(()=>launchConfig('data',0,{}),/port/);});
test('cleanup cannot confirm while final query fails or any owned process remains',()=>{const state={uninstalled:true,grantRemoved:true,appHandleClosed:true,remainingProcesses:[],processQuerySucceeded:true};assert.equal(cleanupConfirmed(state),true);for(const key of ['uninstalled','grantRemoved','appHandleClosed','processQuerySucceeded'])assert.equal(cleanupConfirmed({...state,[key]:false}),false);assert.equal(cleanupConfirmed({...state,remainingProcesses:[{pid:12}]}),false);});

test('CDP binds out-of-order replies and preserves request parameters',async t=>{const requests=[];const url=await endpoint(t,(msg,send)=>{requests.push(msg);if(requests.length===2){send({id:requests[1].id,result:{token:requests[1].params.token}});send({id:requests[0].id,result:{token:requests[0].params.token}});}});const client=await Cdp.connect(url);t.after(()=>client.close());assert.deepEqual(await Promise.all([client.send('Runtime.one',{token:'first'}),client.send('Runtime.two',{token:'second'})]),[{token:'first'},{token:'second'}]);});

// Parse the actual harness commands without executing any Windows operations.
test('actual process-query and identity-bound cleanup commands parse as PowerShell',t=>{
 const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const exe=process.platform==='win32'?path.win32.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):path.join(__dirname,'../.local-tools/powershell/pwsh');
 if(!fs.existsSync(exe)){t.skip('PowerShell parser unavailable here; Windows workflow checks it');return;}
 for(const script of [suiteProcessScript(["C:\\runner\\suite with a 'quote",'C:\\ProgramData\\LaoyuNetTools\\Grants\\sid']),terminationScript({pid:124,created:'638000000000000000'})]){
  const parse="$script=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"+Buffer.from(script,'utf16le').toString('base64')+"'));$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}";
  execFileSync(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parse,'utf16le').toString('base64')],{timeout:15000});
 }
 assert.throws(()=>terminationScript({pid:1,created:'638000000000000000'}),/identity/);
 assert.throws(()=>terminationScript({pid:124,created:"'; exit 0; '"}),/identity/);
});

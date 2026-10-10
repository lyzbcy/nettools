'use strict';
const nodeTest=require('node:test'),test=(name,fn)=>nodeTest(name,{skip:process.platform!=='darwin'},fn),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');let compiled;
function binaries(){if(compiled)return compiled;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-native-'));const helper=path.join(dir,'helper'),engine=path.join(dir,'engine');
 for(const [files,out,define]of [[['src/NetRepairHelper.swift'],helper,'HELPER'],[['src/NetRepairHelper.swift','src/NetRepair.swift'],engine,'ENGINE']]){
  const r=spawnSync('/usr/bin/xcrun',['swiftc','-parse-as-library','-D','TESTING','-D',define,...files.map(f=>path.join(root,f)),'-o',out],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }compiled={dir,helper,engine};process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));return compiled;
}
function rpc(binary,request,argv=[]){const r=spawnSync(binary,argv,{input:JSON.stringify(request),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
test('compiled native validation is pure and rejects unsafe actions and all untrusted fields',()=>{
 const {helper,engine,dir}=binaries();for(const action of ['restart','restart-system','apply-update'])assert.equal(rpc(engine,{action,args:{}},['--validate-only']).ok,false);
 for(const args of [{primary:'1.1.1.1; bad'},{primary:'999.1.1.1'},{primary:'empty',secondary:'1.1.1.1'}])assert.equal(rpc(helper,{action:'set-dns',args},['--validate-only']).ok,false);
 assert.equal(rpc(helper,{action:'set-dns',args:{primary:'2001:4860:4860::8888'}},['--validate-only']).ok,true);
 assert.equal(rpc(engine,{action:'get-status',args:{path:'/etc/passwd'}},['--validate-only']).ok,false);
 assert.deepEqual(fs.readdirSync(dir).sort(),['engine','helper']);
});
test('compiled helper refuses unauthenticated actions before any network command',()=>{
 const {helper}=binaries();const r=rpc(helper,{action:'flush-dns',args:{}},['--rpc']);assert.equal(r.ok,false);assert.equal(r.error.code,'PERMISSION_REQUIRED');
});
test('DNS refresh targets only the system daemon owners despite retaining the installing real UID',()=>{
 const {helper,dir}=binaries();const result=rpc(helper,{action:'flush-dns',args:{},fixture:{stateDir:path.join(dir,'flush')}},['--fixture']);assert.equal(result.ok,true);const hup=result.commands.find(c=>c.path==='/usr/bin/pkill');assert.deepEqual(hup?.args,['-HUP','-U','root,_mdnsresponder','-x','mDNSResponder']);assert.ok(!result.commands.some(c=>c.path==='/usr/bin/killall'));
});
test('fixture static IP refuses DHCP and step failure cannot become success',()=>{
 const {helper,dir}=binaries();const r=rpc(helper,{action:'renew-dhcp',args:{},fixture:{stateDir:path.join(dir,'static'),method:'Manual'}},['--fixture']);
 assert.equal(r.ok,false);assert.equal(r.error.code,'STATIC_IP');assert.ok(!r.commands.some(c=>c.args[0]==='set'));
 const failed=rpc(helper,{action:'set-dns',args:{primary:'1.1.1.1'},fixture:{stateDir:path.join(dir,'failure'),failFlags:['-setdnsservers']}},['--fixture']);assert.equal(failed.ok,false);assert.equal(failed.error.code,'ROLLBACK_FAILED');
 assert.equal(fs.existsSync(path.join(dir,'failure','dns-backup.json')),true);
});
test('DNS restore preserves original IPv6 list across repeated writes and restore errors remain visible',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'dns');
 for(const primary of ['1.1.1.1','8.8.8.8'])assert.equal(rpc(helper,{action:'set-dns',args:{primary},fixture:{stateDir,dns:['2001:db8::1','9.9.9.9']}},['--fixture']).ok,true);
 const restored=rpc(helper,{action:'restore-dns',args:{},fixture:{stateDir}},['--fixture']);assert.equal(restored.ok,true);
 assert.ok(restored.commands.some(c=>c.args[0]==='-setdnsservers'&&c.args.slice(2).join(',')==='2001:db8::1,9.9.9.9'));
 assert.equal(fs.existsSync(path.join(stateDir,'dns-backup.json')),false);
});
test('empty disabled proxies restore without endpoint validation errors',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'proxy');
 const first=rpc(helper,{action:'clear-proxy',args:{},fixture:{stateDir}},['--fixture']);assert.equal(first.ok,true);
 const restored=rpc(helper,{action:'restore-proxy',args:{},fixture:{stateDir}},['--fixture']);assert.equal(restored.ok,true);
});
test('read failure cannot overwrite a snapshot or change DNS',()=>{
 const {helper,dir}=binaries();const r=rpc(helper,{action:'set-dns',args:{primary:'1.1.1.1'},fixture:{stateDir:path.join(dir,'read-failure'),failFlags:['-getdnsservers']}},['--fixture']);
 assert.equal(r.ok,false);assert.ok(!r.commands.some(c=>c.args[0]==='-setdnsservers'));assert.equal(fs.existsSync(path.join(dir,'read-failure','dns-backup.json')),false);
});
test('failed DNS resolver verification rolls back and reports exact restore result',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'bad-resolver');
 const r=rpc(helper,{action:'set-dns',args:{primary:'1.1.1.1'},fixture:{stateDir,dns:['2001:db8::1'],dnsResolves:false}},['--fixture']);
 assert.equal(r.ok,false);assert.equal(r.error.code,'DNS_UNREACHABLE');assert.ok(r.commands.some(c=>c.args[0]==='-setdnsservers'&&c.args[2]==='2001:db8::1'));
});
test('proxy restoration preserves active endpoint and excludes live and remote endpoints from auto clear',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'active-proxy');
 const proxies={web:{Enabled:'Yes',Server:'127.0.0.1',Port:'7890'},secure:{Enabled:'Yes',Server:'proxy.example.com',Port:'8080'}};
 const first=rpc(helper,{action:'clear-proxy',args:{},fixture:{stateDir,proxies}},['--fixture']);assert.equal(first.ok,true);
 assert.ok(first.commands.some(c=>c.args[0]==='-setwebproxystate'));assert.ok(!first.commands.some(c=>c.args[0]==='-setsecurewebproxystate'));
 const restored=rpc(helper,{action:'restore-proxy',args:{},fixture:{stateDir}},['--fixture']);assert.equal(restored.ok,true);
 assert.ok(restored.commands.some(c=>c.args[0]==='-setwebproxy'&&c.args[2]==='127.0.0.1'&&c.args[3]==='7890'));
 const live=rpc(helper,{action:'clear-proxy',args:{},fixture:{stateDir:path.join(dir,'live-proxy'),proxies,liveProxy:true}},['--fixture']);assert.equal(live.ok,true);assert.ok(!live.commands.some(c=>c.args[0]==='-setwebproxystate'));
});
test('VPN reset restores prior resolver contents and original service, including empty bypass',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'vpn');fs.mkdirSync(stateDir,{mode:0o700});
 const domain='corp.example.com',resolver=path.join(stateDir,'resolver-'+domain);fs.writeFileSync(resolver,'nameserver 192.0.2.53\n',{mode:0o644});
 const config={company:{intranetCIDR:'10.0.0.0/8',intranetDNS:['10.8.0.53'],resolverDomain:domain,internalHost:'git.corp.example.com',internalProbeIP:'10.8.0.7'},vpn:{enabled:true,configName:'corp'}};
 const first=rpc(helper,{action:'vpn-coexist',args:{config},fixture:{stateDir,vpn:true}},['--fixture']);assert.equal(first.ok,true,JSON.stringify(first.error));
 assert.ok(fs.readFileSync(resolver,'utf8').includes('10.8.0.53'));
 const second=rpc(helper,{action:'vpn-coexist',args:{config},fixture:{stateDir,vpn:true}},['--fixture']);assert.equal(second.ok,true);
 const reset=rpc(helper,{action:'vpn-coexist-reset',args:{},fixture:{stateDir,vpn:true}},['--fixture']);assert.equal(reset.ok,true,JSON.stringify(reset.error));
 assert.equal(fs.readFileSync(resolver,'utf8'),'nameserver 192.0.2.53\n');assert.ok(reset.commands.some(c=>c.args[0]==='-setproxybypassdomains'&&c.args[1]==='Wi-Fi'&&c.args[2]==='Empty'));
 assert.equal(fs.existsSync(path.join(stateDir,'coexist-backup.json')),false);
});
test('snapshot symlink is rejected before privileged writes',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'symlink');fs.mkdirSync(stateDir,{mode:0o700});const target=path.join(dir,'target.json');fs.writeFileSync(target,'{}');fs.symlinkSync(target,path.join(stateDir,'dns-backup.json'));
 const r=rpc(helper,{action:'set-dns',args:{primary:'1.1.1.1'},fixture:{stateDir}},['--fixture']);assert.equal(r.ok,false);assert.ok(!r.commands.some(c=>c.args[0]==='-setdnsservers'));assert.equal(fs.readFileSync(target,'utf8'),'{}');
});
test('failed restore retains original snapshot and never claims success',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'failed-restore');assert.equal(rpc(helper,{action:'clear-proxy',args:{},fixture:{stateDir}},['--fixture']).ok,true);
 const failed=rpc(helper,{action:'restore-proxy',args:{},fixture:{stateDir,failFlags:['-setsecurewebproxystate']}},['--fixture']);assert.equal(failed.ok,false);assert.equal(failed.error.code,'COMMAND_FAILED');assert.equal(fs.existsSync(path.join(stateDir,'proxy-backup.json')),true);
});
test('Swift command runner drains large output, caps it and reaps the child promptly',()=>{
 const {dir}=binaries(),source=path.join(dir,'runner.swift'),binary=path.join(dir,'runner');
 fs.writeFileSync(source,'import Foundation\n@main struct RunnerTest {static func main(){do{_ = try SystemRunner().run("/usr/bin/yes",["fixed-output"],timeout:3);reply([:])}catch{reply(error:error)}}}\n');
 const c=spawnSync('/usr/bin/xcrun',['swiftc','-parse-as-library',path.join(root,'src/NetRepairHelper.swift'),source,'-o',binary],{encoding:'utf8'});assert.equal(c.status,0,c.stderr);
 const started=Date.now(),r=spawnSync(binary,[],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).error.code,'OUTPUT_LIMIT');assert.ok(Date.now()-started<2500);
});
test('Mac actual read-only diagnose preserves all eight diagnostic checks',()=>{
 const {engine,dir}=binaries(),configDir=path.join(dir,'readonly-config');fs.mkdirSync(configDir,{mode:0o700});
 const r=spawnSync(engine,['--rpc','--config-dir',configDir,'--resources-dir',dir],{input:JSON.stringify({action:'diagnose',args:{},background:true}),encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
 const answer=JSON.parse(r.stdout);assert.equal(answer.ok,true,JSON.stringify(answer.error));assert.equal(answer.data.items.length,8);assert.deepEqual(fs.readdirSync(configDir),[]);
});
function harness(name,body,testing=false){const {dir}=binaries(),source=path.join(dir,name+'.swift'),binary=path.join(dir,name);fs.writeFileSync(source,body);const r=spawnSync('/usr/bin/xcrun',['swiftc','-parse-as-library',...(testing?['-D','TESTING']:[]),path.join(root,'src/NetRepairHelper.swift'),source,'-o',binary],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return binary;}
test('dead system secure proxy is unhealthy even when direct HTTPS succeeds',()=>{
 const binary=harness('dead-proxy',`import Foundation
final class ReviewRunner: Running {let base=FixtureRunner(["proxies":["secure":["Enabled":"Yes","Server":"127.0.0.1","Port":"7890"]]]);func run(_ p:String,_ a:[String],timeout:TimeInterval)throws->Command{if p == "/usr/bin/curl" {return Command(status:0,output:"200")};return try base.run(p,a,timeout:timeout)}}
final class WebMock: WebFetching {func fetch(_ u:URL,direct:Bool,timeout:TimeInterval,download:Bool)throws->[String:Any]{["ok":true,"code":200]}}
@main struct Review {static func main(){do{reply(try Network(ReviewRunner(),web:WebMock()).check())}catch{reply(error:error)}}}`,true);
 const r=rpc(binary,{},[]);assert.equal(r.ok,true);assert.equal(r.data.ok,false);assert.equal(r.data.issue,'stale-proxy');
});
test('PAC URL setter success with unchanged URL is a restore verification failure',()=>{
 const binary=harness('pac-restore',`import Foundation
import Darwin
final class ReviewRunner: Running {let base=FixtureRunner([:]);var url="https://original.example.com/proxy.pac";func run(_ p:String,_ a:[String],timeout:TimeInterval)throws->Command{if a.first == "-getautoproxyurl" {return Command(status:0,output:"Enabled: Yes\\nURL: " + url)};return try base.run(p,a,timeout:timeout)}}
@main struct Review {static func main(){do{let r=ReviewRunner(),n=Network(r),saved=try n.proxy("Wi-Fi");r.url="https://replacement.example.com/proxy.pac";try Repairs(network:n,state:"/tmp/unused-review",uid:getuid()).restoreProxy("Wi-Fi",saved);reply([:])}catch{reply(error:error)}}}`,true);
 const r=rpc(binary,{},[]);assert.equal(r.ok,false);assert.equal(r.error.code,'VERIFY_FAILED');
});
test('PAC URL readback failure retains the protected recovery snapshot',()=>{
 const {helper,dir}=binaries(),stateDir=path.join(dir,'pac-snapshot');assert.equal(rpc(helper,{action:'clear-proxy',args:{},fixture:{stateDir}},['--fixture']).ok,true);
 const file=path.join(stateDir,'proxy-backup.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.proxy.auto.url='https://original.example.com/proxy.pac';fs.writeFileSync(file,JSON.stringify(saved),{mode:0o600});
 const r=rpc(helper,{action:'restore-proxy',args:{},fixture:{stateDir}},['--fixture']);assert.equal(r.ok,false);assert.equal(r.error.code,'VERIFY_FAILED');assert.equal(fs.existsSync(file),true);
});
test('Swift timeout terminates an ignored-TERM descendant before returning',()=>{
 const {dir}=binaries(),pidFile=path.join(dir,'child.pid'),parent=path.join(dir,'parent.cjs');
 fs.writeFileSync(parent,`const fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
 const binary=harness('descendant',`import Foundation\n@main struct Review {static func main(){do{_ = try SystemRunner().run(${JSON.stringify(process.execPath)},[${JSON.stringify(parent)}],timeout:1);reply([:])}catch{reply(error:error)}}}`);
 let pid;try{const r=spawnSync(binary,[],{encoding:'utf8',timeout:7000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).error.code,'PROCESS_TIMEOUT');pid=Number(fs.readFileSync(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}finally{if(pid){try{process.kill(pid,'SIGKILL');}catch{}}}
});
test('Swift VPN config rejects leading command options consistently with JS',()=>{
 const {engine}=binaries();assert.equal(rpc(engine,{action:'save-config',args:{config:{vpn:{configName:'/disconnect'}}}},['--validate-only']).ok,false);
});
test('PAC failure is not hidden by a successful informational direct probe',()=>{
 const binary=harness('pac-check',`import Foundation
final class ReviewRunner: Running {let base=FixtureRunner([:]);func run(_ p:String,_ a:[String],timeout:TimeInterval)throws->Command{if a.first == "-getautoproxyurl" {return Command(status:0,output:"Enabled: Yes\\nURL: https://corp.example.com/proxy.pac")};return try base.run(p,a,timeout:timeout)}}
final class WebMock: WebFetching {func fetch(_ u:URL,direct:Bool,timeout:TimeInterval,download:Bool)throws->[String:Any]{["ok":direct,"code":direct ? 200:0]}}
@main struct Review {static func main(){do{reply(try Network(ReviewRunner(),web:WebMock()).check())}catch{reply(error:error)}}}`,true);
 const r=rpc(binary,{},[]);assert.equal(r.data.ok,false);assert.equal(r.data.directHttpOk,true);assert.equal(r.data.proxyPath,'system');
});
test('CFNetwork URLSession actually routes through an isolated PAC proxy without changing system settings',async()=>{
 const http=require('node:http'),{spawn}=require('node:child_process');let hits=0;
 const target=http.createServer((_q,s)=>s.end('direct health'));
 const proxy=http.createServer((_q,s)=>{hits++;s.writeHead(502);s.end('proxy failed');});
 const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));await listen(target);await listen(proxy);
 const pac=http.createServer((_q,s)=>{s.writeHead(200,{'content-type':'application/x-ns-proxy-autoconfig'});s.end(`function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${proxy.address().port}"; }`);});await listen(pac);
 try{const binary=harness('real-pac',`import Foundation\n@main struct Review {static func main(){do{let client=SystemWebClient(settingsProvider:{["ProxyAutoConfigEnable":1,"ProxyAutoConfigURLString":"http://127.0.0.1:${pac.address().port}/proxy.pac"]});reply(try client.fetch(URL(string:"http://127.0.0.1:${target.address().port}/health")!,direct:false,timeout:4,download:false))}catch{reply(error:error)}}}`);
 const output=await new Promise((resolve,reject)=>{const child=spawn(binary,[],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('close',code=>code===0?resolve(out):reject(Error(err)));child.on('error',reject);});const r=JSON.parse(output);assert.equal(r.ok,true,JSON.stringify(r.error));assert.equal(r.data.ok,false);assert.equal(r.data.code,502);assert.ok(hits>0);
 }finally{await Promise.all([target,proxy,pac].map(s=>new Promise(r=>s.close(r))));}
});
test('native signal cancellation confirms descendant cleanup before engine exits',async()=>{
 const {dir}=binaries(),pidFile=path.join(dir,'abort-child.pid'),parent=path.join(dir,'abort-parent.cjs');
 fs.writeFileSync(parent,`const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`);
 const binary=harness('native-abort',`import Foundation\n@main struct Review {static func main(){NativeRegistry.shared.installSignals();do{_ = try nativeProcess(${JSON.stringify(process.execPath)},[${JSON.stringify(parent)}],timeout:30,grace:0.5);reply([:])}catch{reply(error:error)}}}`);
 const child=require('node:child_process').spawn(binary,[],{stdio:'ignore'});let pid;
 try{for(let i=0;i<200&&!fs.existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync(pidFile));pid=Number(fs.readFileSync(pidFile,'utf8'));
 const closed=new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('native cancellation did not finish')),3000);child.once('close',()=>{clearTimeout(timer);r();});});child.kill('SIGTERM');await closed;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{try{child.kill('SIGKILL');}catch{}if(pid){try{process.kill(pid,'SIGKILL');}catch{}}}
});
test('unknown proxy listener state cannot trigger automatic clearing',()=>{
 const binary=harness('proxy-unknown',`import Foundation\nimport Darwin
final class ReviewRunner: Running {let base=FixtureRunner(["proxies":["web":["Enabled":"Yes","Server":"127.0.0.1","Port":"7890"]]]);func run(_ p:String,_ a:[String],timeout:TimeInterval)throws->Command{if a.first == "-z" {throw fail("PROCESS_TIMEOUT","listener probe unavailable")};return try base.run(p,a,timeout:timeout)}}
@main struct Review {static func main(){do{_ = try Network(ReviewRunner()).proxy("Wi-Fi");reply([:])}catch{reply(error:error)}}}`,true);
 const r=rpc(binary,{},[]);assert.equal(r.ok,false);assert.equal(r.error.code,'PROCESS_TIMEOUT');
});

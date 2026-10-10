'use strict';
const fs=require('./raw-fs.cjs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),{spawn}=require('node:child_process');
const {compareVersions,hashFile}=require('./updater.cjs');
const {runProcess}=require('../platform/common.cjs');
const APP_NAME='捞鱼的网络工具.app',PRODUCT='laoyu-nettools',IDENTIFIER='com.laoyu.nettools';
const LIMITS={files:20000,total:2*1024**3,file:512*1024**2,archive:1024**3,ratio:500};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const cancelled=signal=>{if(signal?.aborted)throw Object.assign(Error('更新已取消'),{code:'ABORT_ERR'});};
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
function absolute(value){if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f]/.test(value))throw Error('更新路径必须是完整且合法的本机路径');return path.resolve(value);}
async function noLink(file,kind){const s=await fsp.lstat(file);if(s.isSymbolicLink()||(kind==='file'&&!s.isFile())||(kind==='dir'&&!s.isDirectory()))throw Error('更新路径类型无效或包含链接');return s;}
async function privateDir(dir){await fsp.mkdir(dir,{recursive:true,mode:0o700});const s=await noLink(dir,'dir');if(process.platform!=='win32'&&((s.mode&0o022)!==0||s.uid!==process.getuid()))throw Error('更新暂存目录必须由当前用户独占写入');return fsp.realpath(dir);}
async function atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fsp.writeFile(temp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await fsp.rename(temp,file);}finally{await fsp.rm(temp,{force:true});}}
async function readAt(fd,offset,size){const b=Buffer.alloc(size);const {bytesRead}=await fd.read(b,0,size,offset);if(bytesRead!==size)throw Error('ZIP 数据被截断');return b;}
const crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;});
const crcAdd=(crc,b)=>{for(const x of b)crc=(crc>>>8)^crcTable[(crc^x)&255];return crc>>>0;};
function zipName(raw,platform){let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw Error('ZIP 文件名编码无效');}
 if(!name||name.length>2048||/[\\\x00-\x1f:]/.test(name)||name.startsWith('/')||name.includes('//'))throw Error('ZIP 路径不安全');
 const directory=name.endsWith('/');name=name.replace(/\/$/,'').normalize('NFC');const parts=name.split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||(platform==='win32'&&(/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))))throw Error('ZIP 路径不安全');return {name,directory};
}
async function inspectZip(file,{platform,signal,limits=LIMITS}={}){
 cancelled(signal);const stat=await noLink(file,'file');if(stat.size>limits.archive||stat.size<22)throw Error('ZIP 大小无效');const fd=await fsp.open(file,'r');
 try{const tail=await readAt(fd,Math.max(0,stat.size-65557),Math.min(stat.size,65557));let eocd=-1;
 for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){eocd=i;break;}
 if(eocd<0)throw Error('ZIP 结束记录无效');const count=tail.readUInt16LE(eocd+10),cdSize=tail.readUInt32LE(eocd+12),cdOffset=tail.readUInt32LE(eocd+16);
 if(tail.readUInt16LE(eocd+4)||tail.readUInt16LE(eocd+6)||tail.readUInt16LE(eocd+8)!==count||!count||count===65535||count>limits.files||cdSize>16*1024**2||cdOffset+cdSize!==stat.size-tail.length+eocd)throw Error('不支持多卷、ZIP64 或超出限制的 ZIP');
 const cd=await readAt(fd,cdOffset,cdSize),entries=[],names=new Map(),spellings=new Map();let cursor=0,total=0;
 for(let index=0;index<count;index++){cancelled(signal);if(cursor+46>cd.length||cd.readUInt32LE(cursor)!==0x02014b50)throw Error('ZIP 目录无效');const flags=cd.readUInt16LE(cursor+8),method=cd.readUInt16LE(cursor+10),crc=cd.readUInt32LE(cursor+16),compressed=cd.readUInt32LE(cursor+20),size=cd.readUInt32LE(cursor+24),n=cd.readUInt16LE(cursor+28),extra=cd.readUInt16LE(cursor+30),comment=cd.readUInt16LE(cursor+32),mode=cd.readUInt32LE(cursor+38)>>>16,offset=cd.readUInt32LE(cursor+42);
 if(cursor+46+n+extra+comment>cd.length||flags&1||![0,8].includes(method)||[size,compressed,offset].includes(0xffffffff)||size>limits.file||size>Math.max(compressed,1)*limits.ratio)throw Error('ZIP 压缩、加密或解压大小不安全');
 const named=zipName(cd.subarray(cursor+46,cursor+46+n),platform);const type=mode&0o170000,kind=type===0o120000?'link':named.directory||type===0o040000?'dir':'file';
 if(type&&!([0o100000,0o040000,0o120000].includes(type)))throw Error('ZIP 包含特殊文件');if(platform==='win32'&&kind==='link')throw Error('Windows 更新包不接受链接');if(kind==='link'&&size>4096)throw Error('ZIP 链接过长');
 const key=named.name.toLocaleLowerCase('en-US');if(names.has(key))throw Error('ZIP 包含重名或大小写冲突');names.set(key,kind);const segments=named.name.split('/');for(let depth=1;depth<=segments.length;depth++){const spelling=segments.slice(0,depth).join('/'),folded=spelling.toLocaleLowerCase('en-US');if(spellings.has(folded)&&spellings.get(folded)!==spelling)throw Error('ZIP 目录大小写不一致');spellings.set(folded,spelling);}total+=size;if(total>limits.total)throw Error('ZIP 解压总大小超出限制');
 const h=await readAt(fd,offset,30);if(h.readUInt32LE(0)!==0x04034b50||h.readUInt16LE(6)!==flags||h.readUInt16LE(8)!==method)throw Error('ZIP 本地记录与目录不一致');const localName=await readAt(fd,offset+30,h.readUInt16LE(26));if(!localName.equals(cd.subarray(cursor+46,cursor+46+n)))throw Error('ZIP 本地文件名不一致');
 const start=offset+30+h.readUInt16LE(26)+h.readUInt16LE(28),end=start+compressed;if(end>cdOffset||offset>=cdOffset||(kind==='dir'&&size!==0))throw Error('ZIP 数据范围无效');
 entries.push({name:named.name,kind,mode,flags,method,crc,compressed,size,offset,start,end});cursor+=46+n+extra+comment;
 }
 if(cursor!==cd.length)throw Error('ZIP 目录含未识别内容');const sorted=[...entries].sort((a,b)=>a.offset-b.offset);for(let i=1;i<sorted.length;i++)if(sorted[i].offset<sorted[i-1].end)throw Error('ZIP 文件数据重叠');
 for(const entry of entries){const parts=entry.name.split('/');for(let i=1;i<parts.length;i++){const type=names.get(parts.slice(0,i).join('/').toLocaleLowerCase('en-US'));if(type&&type!=='dir')throw Error('ZIP 文件或链接被当作目录');}
 if(platform==='darwin'&&entry.name!==APP_NAME&&!entry.name.startsWith(APP_NAME+'/')&&entry.name!=='__MACOSX'&&!entry.name.startsWith('__MACOSX/'))throw Error('Mac ZIP 必须包含完整外层应用');}
 return entries;
 }finally{await fd.close();}
}
async function entryData(file,e,{signal,onChunk}={}){
 if(e.compressed===0){if(e.size!==0||e.crc!==0)throw Error('ZIP 空文件大小或 CRC 错误');return;}
 let input=fs.createReadStream(file,{start:e.start,end:e.end-1,signal}),stream=input,inflate;
 if(e.method===8){inflate=zlib.createInflateRaw();input.on('error',err=>inflate.destroy(err));stream=input.pipe(inflate);}
 let size=0,crc=0xffffffff;try{for await(const chunk of stream){cancelled(signal);size+=chunk.length;if(size>e.size)throw Error('ZIP 文件解压超出声明大小');crc=crcAdd(crc,chunk);await onChunk?.(chunk);}if(size!==e.size||((crc^0xffffffff)>>>0)!==e.crc)throw Error('ZIP 文件大小或 CRC 校验失败');}finally{input.destroy();inflate?.destroy();}
}
async function extractZip(file,dest,entries,{signal,platform}={}){
 const links=[],kinds=new Map();for(const e of entries){if(e.name==='__MACOSX'||e.name.startsWith('__MACOSX/'))continue;cancelled(signal);const target=path.join(dest,...e.name.split('/'));kinds.set(e.name,e.kind);await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o755});
 if(e.kind==='dir'){await fsp.mkdir(target,{recursive:true,mode:0o755});continue;}
 if(e.kind==='link'){const chunks=[];await entryData(file,e,{signal,onChunk:async c=>chunks.push(c)});const value=Buffer.concat(chunks).toString('utf8');if(!value||value.includes('\\')||/[\x00-\x1f:]/.test(value)||path.posix.isAbsolute(value))throw Error('ZIP 链接目标不安全');const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(e.name),value));if(!resolved.startsWith(APP_NAME+'/'))throw Error('ZIP 链接逃出应用');links.push({...e,target,value,resolved});continue;}
 if(platform==='darwin'&&path.posix.basename(e.name).startsWith('._')&&e.size<=1024*1024){const chunks=[];await entryData(file,e,{signal,onChunk:async c=>chunks.push(c)});const bytes=Buffer.concat(chunks);if(bytes.length>=26&&bytes.readUInt32BE(0)===0x00051607)continue;await fsp.writeFile(target,bytes,{flag:'wx',mode:e.mode&0o111?0o755:0o644});continue;}
 const handle=await fsp.open(target,'wx',e.mode&0o111?0o755:0o644);try{await entryData(file,e,{signal,onChunk:async c=>{await handle.write(c);}});}finally{await handle.close();}}
 const byName=new Map(links.map(l=>[l.name,l]));function resolveLink(rel,seen=[]){const parts=rel.split('/');for(let i=1;i<=parts.length;i++){const name=parts.slice(0,i).join('/'),link=byName.get(name);if(link){if(seen.includes(name)||seen.length>=40)throw Error('ZIP 链接形成循环');return resolveLink(path.posix.join(link.resolved,...parts.slice(i)),[...seen,name]);}}return rel;}
 for(const link of links){const final=resolveLink(link.resolved,[link.name]);if(!final.startsWith(APP_NAME+'/'))throw Error('ZIP 链接逃出应用');const target=path.join(dest,...final.split('/'));await fsp.lstat(target).catch(()=>{throw Error('ZIP 链接目标不存在');});}
 for(const link of links)await fsp.symlink(link.value,link.target);
}
async function binaryArch(file,platform){const fd=await fsp.open(file,'r');try{const s=await fd.stat(),b=await readAt(fd,0,Math.min(s.size,4096));if(platform==='win32'){if(b.length<64||b.toString('ascii',0,2)!=='MZ')throw Error('Windows 主程序不是 PE');const off=b.readUInt32LE(60);if(off>s.size-24||off>1024*1024)throw Error('PE 头无效');const h=await readAt(fd,off,24);if(h.readUInt32LE(0)!==0x4550||(h.readUInt16LE(22)&2)===0)throw Error('PE 可执行标记无效');return h.readUInt16LE(4)===0x8664?['x64']:[];}
 if(b.length<8)throw Error('Mac 主程序不是 Mach-O');const magic=b.readUInt32BE(0);if(magic===0xcffaedfe||magic===0xcefaedfe){const cpu=b.readUInt32LE(4);return cpu===0x100000c?['arm64']:cpu===0x1000007?['x64']:[];}
 if(magic===0xcafebabe||magic===0xcafebabf){const count=b.readUInt32BE(4),stride=magic===0xcafebabf?32:20;if(!count||count>20||8+count*stride>b.length)throw Error('Mach-O FAT 头无效');return Array.from({length:count},(_,i)=>b.readUInt32BE(8+i*stride)).map(c=>c===0x100000c?'arm64':c===0x1000007?'x64':'unknown');}throw Error('Mac 主程序格式无效');}finally{await fd.close();}}
async function identity(appPath,{platform,arch,version,signature=true,signal}={}){
 const resources=platform==='darwin'?path.join(appPath,'Contents/Resources/app'):path.join(appPath,'resources/app');const packageFile=path.join(resources,'package.json');await noLink(packageFile,'file');const pkg=JSON.parse(await fsp.readFile(packageFile,'utf8'));
 if(pkg.name!==PRODUCT||pkg.main!=='src/main.cjs'||(version&&pkg.version!==version))throw Error('更新软件标识或版本不匹配');compareVersions(pkg.version,pkg.version);
 const exe=platform==='darwin'?path.join(appPath,'Contents/MacOS/LaoyuNetTools'):path.join(appPath,'LaoyuNetTools.exe');await noLink(exe,'file');if(!(await binaryArch(exe,platform)).includes(arch))throw Error('更新包芯片架构不匹配');
 if(version)for(const relative of ['src/main.cjs','scripts/update-mac.sh','scripts/update-win.ps1'])await noLink(path.join(resources,relative),'file');
 if(platform==='darwin'){const plist=await runProcess('/usr/bin/plutil',['-convert','json','-o','-',path.join(appPath,'Contents/Info.plist')],{signal,timeoutMs:10000});const info=JSON.parse(plist.stdout);if(info.CFBundleIdentifier!==IDENTIFIER||info.CFBundleExecutable!=='LaoyuNetTools'||info.CFBundleShortVersionString!==pkg.version)throw Error('Mac 应用标识或版本不匹配');if(signature)await runProcess('/usr/bin/codesign',['--verify','--deep','--strict',appPath],{signal,timeoutMs:30000});}
 return {version:pkg.version,exe,resources};
}
async function treeManifest(root,{signal}={}){const rows=[];async function visit(relative){cancelled(signal);const file=path.join(root,relative),s=await fsp.lstat(file);if(s.isSymbolicLink())rows.push({path:relative.split(path.sep).join('/'),kind:'link',target:await fsp.readlink(file)});else if(s.isDirectory()){if(relative)rows.push({path:relative.split(path.sep).join('/'),kind:'dir'});for(const name of(await fsp.readdir(file)).sort())await visit(path.join(relative,name));}else if(s.isFile())rows.push({path:relative.split(path.sep).join('/'),kind:'file',size:s.size,sha256:await hashFile(file)});else throw Error('暂存应用包含特殊文件');}await visit('');return rows;}
async function prepareUpdate(record,{signal,appPath,dataDir,platform=process.platform,arch=process.arch}={}){
 cancelled(signal);if(!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch)||(platform==='win32'&&arch!=='x64'))throw Error('平台或架构不支持更新');
 appPath=absolute(appPath);dataDir=absolute(dataDir);await noLink(appPath,'dir');const parent=await fsp.realpath(path.dirname(appPath));appPath=path.join(parent,path.basename(appPath));dataDir=await privateDir(dataDir);
 if(appPath===path.parse(appPath).root||inside(appPath,dataDir)||inside(dataDir,appPath)||appPath===dataDir)throw Error('配置目录与安装目录不能重叠');
 const current=await identity(appPath,{platform,arch,signature:false,signal});if(!record||compareVersions(record.version,current.version)<=0)throw Error('拒绝同版或降级更新');
 if(record.name!==`nettools-${record.version}-${platform==='darwin'?'mac':'win'}-${arch}.zip`||!Number.isSafeInteger(record.size)||record.size<1||record.size>LIMITS.archive||!/^[a-f0-9]{64}$/i.test(record.sha256))throw Error('更新记录无效');
 const source=absolute(record.file),s=await noLink(source,'file');if(s.size!==record.size||await hashFile(source)!==record.sha256.toLowerCase())throw Error('原始更新包 SHA-256 或大小校验失败');cancelled(signal);
 const staging=await privateDir(path.join(dataDir,'updates')),attempt=await fsp.mkdtemp(path.join(staging,'install-')),token=crypto.randomBytes(32).toString('hex');
 try{const archive=path.join(attempt,'source.zip');await fsp.copyFile(source,archive,fs.constants.COPYFILE_EXCL);await fsp.chmod(archive,0o600);if(await hashFile(archive)!==record.sha256.toLowerCase())throw Error('复制的更新包 SHA-256 不匹配');
 const entries=await inspectZip(archive,{platform,signal}),extracted=path.join(attempt,'extract');await fsp.mkdir(extracted,{mode:0o700});await extractZip(archive,extracted,entries,{platform,signal});const stage=platform==='darwin'?path.join(extracted,APP_NAME):extracted;
 await identity(stage,{platform,arch,version:record.version,signal});const manifest=await treeManifest(stage,{signal});cancelled(signal);
 const scriptFile=path.join(attempt,platform==='darwin'?'worker.sh':'worker.ps1'),template=path.join(__dirname,'../../scripts',platform==='darwin'?'update-mac.sh':'update-win.ps1');let script=await fsp.readFile(template,'utf8');if(platform==='win32')script='\uFEFF'+script.replace(/^\uFEFF/,'');await fsp.writeFile(scriptFile,script,{mode:0o700,flag:'wx'});
 const payload={protocol:1,token,version:record.version,oldVersion:current.version,platform,arch,target:appPath,dataDir,attempt,stage,archive,sha256:record.sha256.toLowerCase(),size:record.size,manifest,scriptFile,oldExe:current.exe,backup:path.join(parent,'.nettools-backup-'+token),incoming:path.join(parent,'.nettools-incoming-'+token),readyFile:path.join(attempt,'ready.json'),commitFile:path.join(attempt,'commit.json'),abortFile:path.join(attempt,'abort.json'),resultFile:path.join(attempt,'result.json'),confirmFile:path.join(attempt,'confirmed.json'),confirmRequestFile:path.join(attempt,'confirm-request.json'),confirmationTimeoutMs:90000,oldExitTimeoutMs:30000};
 const payloadFile=path.join(attempt,'payload.json');await atomic(payloadFile,payload);await atomic(payload.confirmRequestFile,{protocol:1,token,version:record.version,target:appPath,dataDir,confirmFile:payload.confirmFile});return {ready:true,attempt,payloadFile,token,version:record.version,appPath,dataDir,file:archive};
 }catch(error){await fsp.rm(attempt,{recursive:true,force:true});throw error;}
}
async function readyPayload(ready){if(!ready?.ready||!/^[a-f0-9]{64}$/.test(ready.token||''))throw Error('更新尚未准备就绪');const file=absolute(ready.payloadFile);await noLink(file,'file');const p=JSON.parse(await fsp.readFile(file,'utf8'));if(p.protocol!==1||p.token!==ready.token||p.attempt!==path.dirname(file)||p.target!==ready.appPath||p.version!==ready.version)throw Error('更新交接身份不匹配');for(const field of ['readyFile','commitFile','abortFile','resultFile','confirmFile','confirmRequestFile','archive','scriptFile'])if(path.dirname(p[field])!==p.attempt)throw Error('更新交接文件越界');await noLink(p.attempt,'dir');return p;}
async function abortUpdate(ready){const p=await readyPayload(ready);await atomic(p.abortFile,{token:p.token,status:'abort'});return {aborted:true};}
const psQuote=s=>"'"+s.replaceAll("'","''")+"'";
async function handoffUpdate(ready,{oldPid,signal,spawnFn=spawn,timeoutMs=60000}={}){
 cancelled(signal);if(!Number.isInteger(oldPid)||oldPid<1||oldPid>2147483647)throw Error('旧进程标识无效');const p=await readyPayload(ready);if(fs.existsSync(p.abortFile)||fs.existsSync(p.commitFile))throw Error('此更新尝试已结束或已经交接');
 const lock=await fsp.open(path.join(p.attempt,'handoff.lock'),'wx',0o600).catch(()=>{throw Error('此更新尝试已经启动交接');});await lock.close();
 await noLink(p.stage,'dir');if((await noLink(p.archive,'file')).size!==p.size||await hashFile(p.archive)!==p.sha256)throw Error('交接前更新包校验失败');await atomic(ready.payloadFile,{...p,oldPid});
 let child,exited=null,launchError=null;try{
 if(p.platform==='darwin'){const log=fs.openSync(path.join(p.attempt,'worker.log'),'wx',0o600);try{child=spawnFn('/bin/sh',[p.scriptFile,ready.payloadFile],{detached:true,stdio:['ignore',log,log]});child.unref?.();}finally{fs.closeSync(log);}}
 else{const errorFile=path.join(p.attempt,'worker-error.log'),entry=`$ErrorActionPreference='Stop';try { & ${psQuote(p.scriptFile)} -PayloadFile ${psQuote(ready.payloadFile)} } catch { [IO.File]::WriteAllText(${psQuote(errorFile)},$_.ToString());exit 1 }`,args='-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+Buffer.from(entry,'utf16le').toString('base64'),bootstrap=`$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+[Environment]::GetEnvironmentVariable('PSModulePath','Machine');$ErrorActionPreference='Stop';$c=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList ${psQuote(args)} -WindowStyle Hidden -PassThru;$c.Id`,powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');child=spawnFn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],{detached:false,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout?.resume();child.stderr?.resume();}
 child.once('error',e=>launchError=e);child.once('close',code=>exited=code);const end=Date.now()+timeoutMs;
 while(Date.now()<end){cancelled(signal);if(launchError)throw launchError;if(exited!==null&&(p.platform==='darwin'||exited!==0)){let detail='';try{detail=JSON.parse(await fsp.readFile(p.resultFile,'utf8')).message||'';}catch{detail=await fsp.readFile(path.join(p.attempt,p.platform==='darwin'?'worker.log':'worker-error.log'),'utf8').catch(()=>'');}throw Error('独立更新助手未能启动：'+detail.slice(-2000));}
 let ack;try{ack=JSON.parse((await fsp.readFile(p.readyFile,'utf8')).replace(/^\uFEFF/,''));}catch{}if(ack?.token===p.token&&ack.version===p.version&&ack.status==='ready'&&Number.isInteger(ack.pid)&&ack.pid>0&&(p.platform==='darwin'?ack.pid===child.pid:exited===0)){cancelled(signal);await atomic(p.commitFile,{token:p.token,status:'commit'});cancelled(signal);return {handoff:true,attempt:p.attempt,helperPid:ack.pid,resultFile:p.resultFile};}
 let result;try{result=JSON.parse((await fsp.readFile(p.resultFile,'utf8')).replace(/^\uFEFF/,''));}catch{}if(result?.token===p.token&&result.status==='failed')throw Error(result.message||'更新助手准备失败');await delay(50);}
 throw Error('更新助手就绪超时，已保留原程序');
 }catch(error){await atomic(p.abortFile,{token:p.token,status:'abort'}).catch(()=>{});throw error;}
}
async function confirmUpdateStartup({version,appPath,dataDir,argv=process.argv,visible=false}={}){
 const arg=argv.find(a=>typeof a==='string'&&a.startsWith('--nettools-update-confirm='));if(!arg)return null;if(visible!==true)throw Error('新版主窗口尚未可见，不能确认更新');const file=absolute(arg.slice('--nettools-update-confirm='.length));await noLink(file,'file');const p=JSON.parse(await fsp.readFile(file,'utf8'));
 const target=await fsp.realpath(absolute(appPath)),data=await fsp.realpath(absolute(dataDir));if(p.protocol!==1||p.version!==version||p.target!==target||p.dataDir!==data||!/^[a-f0-9]{64}$/.test(p.token||'')||!inside(path.join(data,'updates'),file)||path.dirname(p.confirmFile)!==path.dirname(file))throw Error('启动确认身份、版本或路径不匹配');
 await atomic(p.confirmFile,{token:p.token,version,pid:process.pid,appPath:target,visible:true,status:'confirmed'});return {confirmed:true,version};
}
async function readUpdateStartupResult({version,appPath,dataDir,argv=process.argv}={}){
 const arg=argv.find(a=>typeof a==='string'&&a.startsWith('--nettools-update-result='));if(!arg)return null;
 const file=absolute(arg.slice('--nettools-update-result='.length)),data=await fsp.realpath(absolute(dataDir)),target=await fsp.realpath(absolute(appPath));
 if(!inside(path.join(data,'updates'),file)||path.basename(file)!=='result.json')throw Error('更新结果路径不受信任');await noLink(file,'file');const result=JSON.parse(await fsp.readFile(file,'utf8')),p=JSON.parse(await fsp.readFile(path.join(path.dirname(file),'payload.json'),'utf8'));
 if(p.protocol!==1||!/^[a-f0-9]{64}$/.test(p.token||'')||p.token!==result.token||p.version!==result.version||p.target!==target||p.dataDir!==data||p.oldVersion!==version||result.status!=='failed')throw Error('更新结果身份或版本不匹配');
 return {failed:true,rolledBack:result.rolledBack===true,message:result.message||'更新未完成，已保留恢复记录',rollbackError:result.rollbackError||null};
}
module.exports={prepareUpdate,handoffUpdate,abortUpdate,confirmUpdateStartup,readUpdateStartupResult,inspectZip,extractZip,binaryArch,LIMITS};

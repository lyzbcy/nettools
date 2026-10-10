#!/bin/sh
set -eu
# Paths and values come only from the private JSON payload. No shell expansion of
# payload fields, no privileged installation, no re-signing or quarantine changes.
exec /usr/bin/osascript -l JavaScript - "$1" <<'JXA'
ObjC.import('Foundation');ObjC.import('AppKit');
function run(argv){
 const fm=$.NSFileManager.defaultManager;let p=null,moved=false,installed=false,newPid=null,transactionConfirmed=false;
 const exists=f=>Boolean(fm.fileExistsAtPath(f));
 const read=f=>{const d=$.NSData.dataWithContentsOfFile(f);if(!d)throw Error('无法读取更新交接文件');return JSON.parse($.NSString.alloc.initWithDataEncoding(d,$.NSUTF8StringEncoding).js);};
 const write=(f,o)=>{if(!$(JSON.stringify(o)).writeToFileAtomicallyEncodingError(f,true,$.NSUTF8StringEncoding,null))throw Error('更新状态写入失败');};
 const attrs=f=>{const a=fm.attributesOfItemAtPathError(f,null);if(!a)throw Error('更新文件不存在');return a;};
 const type=f=>ObjC.unwrap(attrs(f).objectForKey($.NSFileType));
 const unlink=f=>{if(exists(f)&&!fm.removeItemAtPathError(f,null))throw Error('无法清理更新暂存项');};
 const move=(a,b)=>{if(exists(b)||!fm.moveItemAtPathToPathError(a,b,null))throw Error('无法原子替换应用；原始应用保留');};
 const pause=ms=>$.NSThread.sleepForTimeInterval(ms/1000);
 function task(file,args,timeout){const log=p.attempt+'/task.log';fm.createFileAtPathContentsAttributes(log,$.NSData.data,$.NSDictionary.dictionary);const output=$.NSFileHandle.fileHandleForWritingAtPath(log),t=$.NSTask.alloc.init;t.launchPath=file;t.arguments=args;t.standardOutput=output;t.standardError=output;t.launch;const end=Date.now()+(timeout||30000);while(t.isRunning){if(Date.now()>end){t.terminate;output.closeFile;throw Error('更新验证命令超时');}pause(20);}output.closeFile;const text=$.NSString.alloc.initWithDataEncoding($.NSData.dataWithContentsOfFile(log),$.NSUTF8StringEncoding).js;if(t.terminationStatus!==0)throw Error('更新验证命令失败');return text;}
 const alive=pid=>{try{task('/bin/kill',['-0',String(pid)],2000);return true;}catch{return false;}};
 const aborted=()=>{if(!exists(p.abortFile))return false;try{return read(p.abortFile).token===p.token;}catch{return true;}};
 function identity(root,version){const pkg=read(root+'/Contents/Resources/app/package.json'),info=JSON.parse(task('/usr/bin/plutil',['-convert','json','-o','-',root+'/Contents/Info.plist']));if(pkg.name!=='laoyu-nettools'||pkg.main!=='src/main.cjs'||pkg.version!==version||info.CFBundleIdentifier!=='com.laoyu.nettools'||info.CFBundleExecutable!=='LaoyuNetTools'||info.CFBundleShortVersionString!==version)throw Error('应用身份或版本不匹配');task('/usr/bin/codesign',['--verify','--deep','--strict',root],30000);}
 function tree(root){const items=fm.enumeratorAtPath(root).allObjects.js.map(x=>ObjC.unwrap(x));if(items.length!==p.manifest.length)throw Error('暂存应用内容数量改变');const actual=Object.create(null);items.forEach(x=>actual[x]=true);const files=[];
  for(const e of p.manifest){if(!actual[e.path])throw Error('暂存应用路径改变');const f=root+'/'+e.path,t=type(f);if(e.kind==='dir'&&t!=='NSFileTypeDirectory')throw Error('目录类型改变');if(e.kind==='link'){if(t!=='NSFileTypeSymbolicLink'||ObjC.unwrap(fm.destinationOfSymbolicLinkAtPathError(f,null))!==e.target)throw Error('链接内容改变');}if(e.kind==='file'){if(t!=='NSFileTypeRegular'||Number(ObjC.unwrap(attrs(f).objectForKey($.NSFileSize)))!==e.size)throw Error('文件类型或大小改变');files.push(e);}}
  for(let i=0;i<files.length;i+=32){if(aborted())throw Error('更新已取消');const batch=files.slice(i,i+32),lines=task('/usr/bin/shasum',['-a','256'].concat(batch.map(e=>root+'/'+e.path)),60000).trim().split('\n');if(lines.length!==batch.length||lines.some((line,j)=>line.slice(0,64)!==batch[j].sha256))throw Error('暂存应用 SHA-256 不匹配');}
 }
 function launch(target,confirm,report){const args=['-n'],environment=$.NSProcessInfo.processInfo.environment;
  const ci=ObjC.unwrap(environment.objectForKey('CI')),plan=ObjC.unwrap(environment.objectForKey('NETTOOLS_UPDATE_ACCEPTANCE_PLAN')),nonce=ObjC.unwrap(environment.objectForKey('NETTOOLS_UPDATE_ACCEPTANCE_NONCE'));
  if(ci==='true'&&plan&&/^[a-f0-9]{64}$/.test(nonce||'')){for(const key of ['CI','RUNNER_TEMP','NETTOOLS_UPDATE_ACCEPTANCE_PLAN','NETTOOLS_UPDATE_ACCEPTANCE_NONCE']){const value=ObjC.unwrap(environment.objectForKey(key));if(typeof value!=='string'||/[\x00-\x1f]/.test(value))throw Error('CI 固定环境无效');args.push('--env',key+'='+value);}}
  args.push(target,'--args','--nettools-data='+p.dataDir);if(confirm)args.push('--nettools-update-confirm='+p.confirmRequestFile);else if(report)args.push('--nettools-update-result='+p.resultFile);task('/usr/bin/open',args,10000);const end=Date.now()+10000;while(Date.now()<end){const apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.laoyu.nettools').js;for(const app of apps){if(ObjC.unwrap(app.bundleURL.URLByResolvingSymlinksInPath.path)===$(target).stringByResolvingSymlinksInPath.js&&Number(app.processIdentifier)!==p.oldPid)return Number(app.processIdentifier);}pause(100);}throw Error('新版应用没有可确认的启动进程');}
 function stopNew(pid){const rows=task('/bin/ps',['-axo','pid=,ppid='],3000).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),owned=new Set([pid]);let changed=true;while(changed){changed=false;for(const row of rows){if(owned.has(row[1])&&!owned.has(row[0])){owned.add(row[0]);changed=true;}}}const ids=Array.from(owned).reverse();if(ids.some(id=>id<=1||id===p.oldPid||id===Number($.NSProcessInfo.processInfo.processIdentifier)))throw Error('无法确认新版进程范围');for(const id of ids){if(alive(id)){try{task('/bin/kill',['-TERM',String(id)],2000);}catch{}}}pause(300);for(const id of ids){if(alive(id)){try{task('/bin/kill',['-KILL',String(id)],2000);}catch{}}}let end=Date.now()+5000;while(ids.some(alive)&&Date.now()<end)pause(50);if(ids.some(alive))throw Error('新版后代进程尚未结束，旧版备份保留');}
 try{
  p=read(argv[0]);if(p.protocol!==1||p.platform!=='darwin'||!/^[a-f0-9]{64}$/.test(p.token)||!Number.isInteger(p.oldPid)||p.oldPid<1)throw Error('更新交接参数无效');
  for(const f of [p.attempt,p.stage,p.target])if(type(f)!=='NSFileTypeDirectory')throw Error('更新目录不能是链接');
  if(exists(p.backup)||exists(p.incoming)||aborted())throw Error('更新尝试已取消或目标暂存项已存在');
  const archiveHash=task('/usr/bin/shasum',['-a','256',p.archive],60000).slice(0,64);if(archiveHash!==p.sha256||Number(ObjC.unwrap(attrs(p.archive).objectForKey($.NSFileSize)))!==p.size)throw Error('原始更新包 SHA-256 或大小改变');
  identity(p.target,p.oldVersion);identity(p.stage,p.version);tree(p.stage);
  if(!fm.copyItemAtPathToPathError(p.stage,p.incoming,null))throw Error('无法在安装目录准备新版；原应用保留');identity(p.incoming,p.version);tree(p.incoming);
  write(p.readyFile,{status:'ready',token:p.token,version:p.version,pid:Number($.NSProcessInfo.processInfo.processIdentifier)});
  let end=Date.now()+30000;while(!exists(p.commitFile)){if(aborted()||Date.now()>end)throw Error('更新交接未提交');pause(50);}if(aborted()||read(p.commitFile).token!==p.token)throw Error('更新交接已撤销');
  end=Date.now()+p.oldExitTimeoutMs;while(alive(p.oldPid)){if(aborted()||Date.now()>end)throw Error('旧版未退出，未替换应用');pause(100);}if(aborted())throw Error('更新已取消');
  identity(p.target,p.oldVersion);identity(p.incoming,p.version);tree(p.incoming);move(p.target,p.backup);moved=true;move(p.incoming,p.target);installed=true;identity(p.target,p.version);newPid=launch(p.target,true);
  write(p.resultFile,{status:'installed',token:p.token,version:p.version,newPid:newPid});end=Date.now()+p.confirmationTimeoutMs;
  let confirmed=false;while(Date.now()<end){if(aborted())throw Error('更新已取消');if(exists(p.confirmFile)){const c=read(p.confirmFile);if(c.token===p.token&&c.version===p.version&&c.appPath===p.target&&c.visible===true&&c.pid===newPid&&alive(newPid)){confirmed=true;break;}}if(!alive(newPid))throw Error('新版启动后退出，准备恢复旧版');pause(100);}
  if(!confirmed)throw Error('新版未确认可见启动，准备恢复旧版');transactionConfirmed=true;write(p.resultFile,{status:'confirmed',token:p.token,version:p.version,newPid:newPid});try{unlink(p.backup);}catch(e){write(p.resultFile,{status:'confirmed',token:p.token,version:p.version,newPid:newPid,backupRetained:true,backup:p.backup,cleanupError:String(e)});}return 'confirmed';
 }catch(error){
  // Startup acknowledgement is the irreversible commit point. A failed log or
  // partially deleted backup must never cause deletion of a running new app.
  if(transactionConfirmed){try{write(p.resultFile,{status:'confirmed',token:p.token,version:p.version,newPid:newPid,backupRetained:exists(p.backup),backup:p.backup,cleanupError:String(error)});}catch{}return 'confirmed';}
  let rollbackError=null;
  if(p){try{if(newPid&&alive(newPid))stopNew(newPid);if(moved){if(installed&&exists(p.target))unlink(p.target);if(exists(p.backup))move(p.backup,p.target);}if(exists(p.incoming))unlink(p.incoming);}catch(e){rollbackError=String(e);}
   // Restoring the application and reopening it must not depend on a writable
   // result file. Only pass its startup flag after a bound failure record exists.
   let reportWritten=false;try{write(p.resultFile,{status:'failed',token:p.token,version:p.version,message:String(error),rolledBack:moved&&!rollbackError,rollbackError:rollbackError,backup:p.backup});reportWritten=true;}catch{}
   if(moved&&!rollbackError){let reopened=null,reopenError=null;try{reopened=launch(p.target,false,reportWritten);}catch(e){reopenError=String(e);}try{write(p.resultFile,{status:'failed',token:p.token,version:p.version,message:String(error),rolledBack:true,reopened:reopened!==null,reopenPid:reopened,reopenError:reopenError,backup:p.backup});}catch{}}
  }
  return 'failed';
 }
}
JXA

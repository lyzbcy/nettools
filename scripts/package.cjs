'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execute=promisify(execFile),root=path.resolve(__dirname,'..'),pkg=require('../package.json');
function target(platform,arch){if(!['darwin','win32'].includes(platform)||!['arm64','x64'].includes(arch)||(platform==='win32'&&arch!=='x64'))throw Error('只接受 Mac arm64 / x64 或 Windows x64');return {platform,arch,name:`nettools-${pkg.version}-${platform==='darwin'?'mac':'win'}-${arch}`};}
async function sha(file){const hash=crypto.createHash('sha256');for await(const data of require('node:fs').createReadStream(file))hash.update(data);return hash.digest('hex');}
async function patchWindows(file){
 const ResEdit=await require('resedit/cjs').load(),PE=ResEdit;
 const exe=PE.NtExecutable.from(await fs.readFile(file),{ignoreCert:true}),res=PE.NtExecutableResource.from(exe);
 const icons=ResEdit.Data.IconFile.from(await fs.readFile(path.join(root,'build/assets/icon.ico')));
 const groups=ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);for(const group of groups)ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries,group.id,group.lang,icons.icons.map(item=>item.data));
 const versions=ResEdit.Resource.VersionInfo.fromEntries(res.entries);if(!versions.length)throw Error('Windows 主程序缺少版本资源');
 for(const version of versions){version.setFileVersion(...pkg.version.split('.').map(Number),0,1033);version.setProductVersion(...pkg.version.split('.').map(Number),0,1033);version.setStringValues({lang:1033,codepage:1200},{FileDescription:'捞鱼的网络工具',ProductName:'捞鱼的网络工具',CompanyName:'捞鱼工作室',OriginalFilename:'LaoyuNetTools.exe',LegalCopyright:'Copyright © 2026 捞鱼工作室'});version.outputToResourceEntries(res.entries);}
 res.outputResource(exe);await fs.writeFile(file,Buffer.from(exe.generate()));
}
async function verifyDirectory(dir,platform,arch){
 const app=platform==='darwin'?path.join(dir,'捞鱼的网络工具.app'):dir;
 const resources=platform==='darwin'?path.join(app,'Contents/Resources'):path.join(app,'resources');
 const source=path.join(resources,'app');
 const version=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version;if(version!==pkg.version)throw Error('打包版本与源码不一致');
 for(const relative of ['src/main.cjs','src/preload.cjs','src/core/update-install.cjs','ui/index.html','ui/assets/icon.png'])await fs.access(path.join(source,relative));
 if(platform==='win32'){const bytes=await fs.readFile(path.join(dir,'LaoyuNetTools.exe'));if(bytes.toString('ascii',0,2)!=='MZ'||bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4)!==0x8664)throw Error('Windows 主程序不是 x64 PE');}
 else{for(const name of ['NetRepair','netrepair-helper']){const file=path.join(resources,'native',name);const out=await execute('/usr/bin/lipo',['-archs',file]);if(out.stdout.trim()!==(arch==='x64'?'x86_64':'arm64'))throw Error('原生执行层架构不匹配');}const manifest=JSON.parse(await fs.readFile(path.join(resources,'native/native-manifest.json'),'utf8'));if(manifest.engineHash!==await sha(path.join(resources,'native/NetRepair'))||manifest.helperHash!==await sha(path.join(resources,'native/netrepair-helper')))throw Error('原生清单哈希不匹配');}
 return {app,resources,version};
}
async function pack(platform=process.platform,arch=process.arch){
 const {build,Platform,Arch}=require('electron-builder');
 const t=target(platform,arch),output=path.join(root,'release',`.work-${t.name}.noindex`),runtime=path.join(root,'.local-tools',`electron-${platform}-${arch}`);
 await fs.mkdir(path.join(root,'build/assets'),{recursive:true});
 const python=process.env.NETTOOLS_PYTHON||(process.platform==='win32'?'python':'/Users/zeen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
 await execute(python,[path.join(__dirname,'package-assets.py')],{cwd:root});
 if(platform==='darwin'){if(process.platform!=='darwin')throw Error('Mac 安装包必须在 Mac 构建');await execute('/bin/zsh',[path.join(root,'build.sh'),arch==='x64'?'x86_64':'arm64'],{maxBuffer:5*1024*1024});}
 await fs.rm(output,{recursive:true,force:true});await fs.mkdir(runtime,{recursive:true});
 const zip=await require('./fetch-runtime.cjs').fetchRuntime(platform,arch);
 if(process.platform==='darwin')await execute('/usr/bin/ditto',['-x','-k',zip,runtime]);else{const quote=value=>"'"+value.replaceAll("'","''")+"'";const script=`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(runtime)} -Force`;await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);}
 const endpoint=process.env.NETTOOLS_FEEDBACK_WEBHOOK;
 const feedback=path.join(root,'.local-tools/feedback-channel.json');if(endpoint){await fs.mkdir(path.dirname(feedback),{recursive:true});await fs.writeFile(feedback,JSON.stringify({endpoint}),{mode:0o600});}await fs.access(feedback);
 const extraResources=[{from:feedback,to:'private/feedback-channel.json'}];if(platform==='darwin')extraResources.push({from:path.join(root,'build/native'),to:'native'});
 const config={appId:'com.laoyu.nettools',productName:'捞鱼的网络工具',executableName:'LaoyuNetTools',electronVersion:pkg.devDependencies.electron,electronDist:runtime,asar:false,npmRebuild:false,buildDependenciesFromSource:false,directories:{output,buildResources:path.join(root,'build/assets')},files:['src/**/*','ui/**/*','scripts/update-mac.sh','scripts/update-win.ps1','package.json','LICENSE','!src/NetRepair*.swift'],extraResources,mac:{identity:null,icon:path.join(root,'ui/assets/icon.icns'),category:'public.app-category.utilities',minimumSystemVersion:'13.0'},win:{icon:path.join(root,'build/assets/icon.ico'),signAndEditExecutable:false},nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,runAfterFinish:true,include:path.join(__dirname,'installer.nsh'),installerHeader:path.join(root,'build/assets/installer-header.bmp'),installerSidebar:path.join(root,'build/assets/installer-sidebar.bmp'),uninstallerSidebar:path.join(root,'build/assets/installer-sidebar.bmp'),license:path.join(root,'LICENSE'),artifactName:`${t.name}-setup.exe`}};
 const buildPlatform=platform==='darwin'?Platform.MAC:Platform.WINDOWS;await build({projectDir:root,targets:buildPlatform.createTarget(['dir'],arch==='arm64'?Arch.arm64:Arch.x64),config});
 const unpacked=path.join(output,platform==='darwin'?(arch==='arm64'?'mac-arm64':'mac'):'win-unpacked');
 if(platform==='win32')await patchWindows(path.join(unpacked,'LaoyuNetTools.exe'));
 else{
  const app=path.join(unpacked,'捞鱼的网络工具.app');await fs.rename(path.join(unpacked,'LaoyuNetTools.app'),app);const native=path.join(app,'Contents/Resources/native');
  for(const name of ['NetRepair','netrepair-helper'])await execute('/usr/bin/codesign',['--force','--sign','-',path.join(native,name)]);
  await fs.writeFile(path.join(native,'native-manifest.json'),JSON.stringify({version:pkg.version,engineHash:await sha(path.join(native,'NetRepair')),helperHash:await sha(path.join(native,'netrepair-helper'))})+'\n');
  await execute('/usr/bin/codesign',['--force','--deep','--sign','-',app],{maxBuffer:5*1024*1024});
  // Deep signing may touch nested native files: regenerate before signing the outer resource seal.
  await fs.writeFile(path.join(native,'native-manifest.json'),JSON.stringify({version:pkg.version,engineHash:await sha(path.join(native,'NetRepair')),helperHash:await sha(path.join(native,'netrepair-helper'))})+'\n');
  await execute('/usr/bin/codesign',['--force','--sign','-',app]);await execute('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 }
 const verified=await verifyDirectory(unpacked,platform,arch),archive=path.join(root,'release',t.name+'.zip');await fs.rm(archive,{force:true});
 if(platform==='darwin')await execute('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',verified.app,archive]);
 else{const builderDir=path.dirname(require.resolve('electron-builder')),seven=require(require.resolve('7zip-bin',{paths:[builderDir]}));await execute(seven.path7za,['a','-tzip',archive,'.'],{cwd:unpacked,maxBuffer:5*1024*1024});}
 let installer;
 if(platform==='win32'){
  let payloadBytes=0;async function total(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await total(file);else if(item.isFile())payloadBytes+=(await fs.stat(file)).size;}}await total(unpacked);
  await fs.writeFile(path.join(root,'build/assets/installer-payload.nsh'),`!define NETTOOLS_PAYLOAD_BYTES ${payloadBytes}\n`);
  const template=await fs.readFile(path.join(__dirname,'installer-ui.ps1'),'utf8');await fs.writeFile(path.join(root,'build/assets/installer-ui.ps1'),'\uFEFF'+template.replace(/^\uFEFF/,''));await fs.copyFile(path.join(root,'ui/assets/icon.png'),path.join(root,'build/assets/installer-logo.png'));
  await build({projectDir:root,prepackaged:unpacked,targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),config});installer=path.join(output,t.name+'-setup.exe');
 }
 else{installer=path.join(root,'release',t.name+'.dmg');await fs.rm(installer,{force:true});const staging=path.join(output,'dmg');await fs.mkdir(staging);await fs.symlink('/Applications',path.join(staging,'Applications'));await execute('/usr/bin/ditto',[verified.app,path.join(staging,path.basename(verified.app))]);await execute('/usr/bin/hdiutil',['create','-volname','捞鱼的网络工具','-srcfolder',staging,'-format','UDZO',installer],{maxBuffer:5*1024*1024});}
 const report={candidate:true,version:pkg.version,platform,arch,verifiedDirectory:unpacked,assets:[]};for(const file of [archive,installer])report.assets.push({name:path.basename(file),file,size:(await fs.stat(file)).size,sha256:await sha(file)});
 await fs.mkdir(path.join(root,'verification/packages'),{recursive:true});await fs.writeFile(path.join(root,'verification/packages',`${platform}-${arch}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));return report;
}
if(require.main===module)pack(...process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={target,pack,verifyDirectory,sha};

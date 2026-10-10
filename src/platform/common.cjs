'use strict';
const {spawn}=require('node:child_process'),net=require('node:net'),path=require('node:path');
const READ_ACTIONS=new Set(['get-status','network-check','diagnose','wifi-info','ping-test','speedtest','vpn-status','helper-status','get-config','export-config']);
const WRITE_ACTIONS=new Set(['flush-dns','set-dns','restore-dns','clear-proxy','restore-proxy','renew-dhcp','vpn-connect','vpn-coexist','vpn-coexist-reset','install-helper','uninstall-helper','save-config','import-config']);
function object(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw TypeError(label+' 必须是对象');return value;}
function onlyKeys(value,keys){for(const key of Object.keys(value))if(!keys.includes(key))throw Error('不接受字段 '+key);}
function text(value,max=120){if(typeof value!=='string'||value.length>max||/[\x00-\x1f]/.test(value))throw Error('文本格式无效');return value;}
function ip(value){return typeof value==='string'&&net.isIP(value)!==0;}
function domain(value){return typeof value==='string'&&value.length<=253&&/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);}
function cidr(value){if(typeof value!=='string')return false;const pair=value.split('/');return pair.length===2&&net.isIPv4(pair[0])&&/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(pair[1]);}
function validateConfig(input){
 const cfg=object(input,'配置');onlyKeys(cfg,['company','vpn','windows']);
 const company=cfg.company??{},vpn=cfg.vpn??{},windows=cfg.windows??{};object(company,'公司');object(vpn,'VPN');object(windows,'Windows 配置');
 onlyKeys(company,['name','intranetCIDR','intranetDNS','resolverDomain','internalHost','internalProbeIP']);onlyKeys(vpn,['enabled','configName','clientAppPath']);onlyKeys(windows,['adapterName']);
 const c={name:text(company.name??'',80),intranetCIDR:company.intranetCIDR??'',intranetDNS:company.intranetDNS??[],resolverDomain:company.resolverDomain??'',internalHost:company.internalHost??'',internalProbeIP:company.internalProbeIP??''};
 if(c.intranetCIDR!==''&&!cidr(c.intranetCIDR))throw Error('内网网段必须是合法 IPv4/CIDR');
 if(!Array.isArray(c.intranetDNS)||c.intranetDNS.length>4||!c.intranetDNS.every(ip))throw Error('内网 DNS 必须是 IP 地址列表');
 for(const key of ['resolverDomain','internalHost'])if(c[key]!==''&&!domain(c[key]))throw Error('内网域名格式无效');
 if(c.internalProbeIP!==''&&!ip(c.internalProbeIP))throw Error('内网探针必须是合法 IP');
 const v={enabled:vpn.enabled??false,configName:text(vpn.configName??'',120),clientAppPath:vpn.clientAppPath??'/Applications/Tunnelblick.app'};
 if(v.configName.startsWith('/'))throw Error('VPN 名称不能是命令选项');
 if(typeof v.enabled!=='boolean'||v.clientAppPath!=='/Applications/Tunnelblick.app')throw Error('VPN 开关或客户端无效');
 return {company:c,vpn:v,windows:{adapterName:text(windows.adapterName??'',120)}};
}
function validateRequest(action,args={}){
 if(!READ_ACTIONS.has(action)&&!WRITE_ACTIONS.has(action))throw Error('不支持的网络操作');object(args,'参数');
 if(action==='set-dns'){
  onlyKeys(args,['primary','secondary']);const primary=args.primary,secondary=args.secondary??'';
  if(primary!=='empty'&&!ip(primary))throw Error('DNS 地址格式无效');if(secondary!==''&&!ip(secondary))throw Error('备用 DNS 地址格式无效');if(primary==='empty'&&secondary!=='')throw Error('自动 DNS 不接受备用地址');
  return {primary,secondary};
 }
 if(action==='save-config'){onlyKeys(args,['config']);return {config:validateConfig(args.config)};}
 if(action==='import-config'){onlyKeys(args,['json']);if(typeof args.json!=='string'||args.json.length>32768)throw Error('配置文本过大');return {json:JSON.stringify(validateConfig(JSON.parse(args.json)))};}
 onlyKeys(args,[]);return {};
}
/** Execute a fixed binary and argv without a shell. An abort resolves only after
 * the actual child closes; descendants share a POSIX process group. Timeout is
 * TERM then KILL, with bounded stdout/stderr. The caller may safely serialize on
 * this promise, including when a child takes time to undo work after TERM.
 */
function runProcess(file,args=[],{input,signal,timeoutMs=30000,maxOutput=512*1024,onStdout}={}){
 if(typeof file!=='string'||!path.isAbsolute(file)||!Array.isArray(args)||!args.every(a=>typeof a==='string')||!Number.isFinite(timeoutMs)||timeoutMs<1)throw TypeError('无效系统调用');
 if(signal?.aborted)return Promise.reject(Object.assign(Error('操作已取消'),{code:'ABORT_ERR'}));
 return new Promise((resolve,reject)=>{
  let child,timeout,escalate,failure,stdout='',stderr='',size=0,done=false;
  const fail=(code,message)=>{if(!failure)failure=Object.assign(Error(message),{code});};
  const killTree=force=>{
   if(!child?.pid)return;
   if(process.platform==='win32'){
    // The fixed system taskkill path avoids PATH hijacking; /T kills descendants.
    const killer=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T',...(force?['/F']:[])],{windowsHide:true,stdio:'ignore',shell:false});killer.on('error',()=>{try{child.kill(force?'SIGKILL':'SIGTERM');}catch{}});
   }else{try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(e){if(e.code!=='ESRCH'){try{child.kill(force?'SIGKILL':'SIGTERM');}catch{}}}}
  };
  const terminate=()=>{killTree(false);if(!escalate)escalate=setTimeout(()=>killTree(true),750);};
  const aborted=()=>{fail('ABORT_ERR','操作已取消');terminate();};
  const finish=error=>{if(done)return;done=true;clearTimeout(timeout);clearTimeout(escalate);signal?.removeEventListener('abort',aborted);error?reject(error):resolve({stdout,stderr});};
  try{child=spawn(file,args,{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});}catch(e){finish(e);return;}
  const collect=(chunk,isError)=>{size+=chunk.length;if(size>maxOutput){fail('OUTPUT_LIMIT','系统返回超过大小限制');terminate();return;}if(isError)stderr+=chunk.toString('utf8');else{stdout+=chunk.toString('utf8');try{onStdout?.(chunk);}catch{}}};
  child.stdout.on('data',c=>collect(c,false));child.stderr.on('data',c=>collect(c,true));
  child.on('error',e=>{fail(e.code||'PROCESS_START','无法启动系统操作');});
  child.on('close',(exitCode,exitSignal)=>{if(failure){finish(failure);return;}if(exitCode!==0){finish(Object.assign(Error('系统操作失败'),{code:'PROCESS_EXIT',exitCode,exitSignal,stdout,stderr}));return;}finish();});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');signal?.addEventListener('abort',aborted,{once:true});
  timeout=setTimeout(()=>{fail('PROCESS_TIMEOUT','系统操作超时');terminate();},timeoutMs);
 });
}
module.exports={READ_ACTIONS,WRITE_ACTIONS,validateRequest,validateConfig,runProcess,ip,domain,cidr};

'use strict';
const fs=require('node:fs'),path=require('node:path');
const ALLOWED_META=new Set(['message','code','durationMs','ok','phase','issue']);
function redact(value){
 return String(value??'')
  .replace(/Bearer\s+[^\s,;]+/gi,'Bearer [已隐藏]')
  .replace(/\b(?:password|passwd|token|secret|api[_-]?key|key|authorization)\s*[:=]\s*[^\s,;]+/gi,'凭据=[已隐藏]')
  .replace(/https?:\/\/[^\s<>"']+/gi,'[链接已隐藏]')
  .replace(/\b[A-Za-z]:[\\/][^\r\n"<>]+/g,'[路径已隐藏]')
  .replace(/\/(?:Users|home|private|var|tmp|etc|Volumes|Library|Applications)\/[^\s"'<>]+/g,'[路径已隐藏]')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[IP已隐藏]')
  .replace(/\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]{0,39}(?:%[\w-]+)?\b/gi,'[IP已隐藏]')
  .replace(/\b(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}\b/gi,'[域名已隐藏]');
}
function regularFile(file){try{const s=fs.lstatSync(file);if(s.isSymbolicLink()||!s.isFile())throw Error('日志路径不是普通文件');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
class OperationLog{
 constructor(directory,{maxBytes=256*1024,maxEntries=200}={}){
  if(!Number.isInteger(maxBytes)||maxBytes<1024||!Number.isInteger(maxEntries)||maxEntries<1)throw TypeError('日志容量无效');
  this.directory=directory;this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.file=path.join(directory,'operations.jsonl');this.rows=[];
  fs.mkdirSync(directory,{recursive:true,mode:0o700});if(fs.lstatSync(directory).isSymbolicLink())throw Error('日志目录不能是符号链接');
  for(let n=3;n>=0;n--){const p=n?this.file.replace(/\.jsonl$/,`.${n}.jsonl`):this.file,s=regularFile(p);if(s&&s.size<=maxBytes)for(const line of fs.readFileSync(p,'utf8').split('\n')){try{const row=JSON.parse(line);if(typeof row.action==='string'&&typeof row.time==='string')this.rows.push(this._clean(row));}catch{}}}
  this.rows=this.rows.slice(-maxEntries);
 }
 _clean(row){const out={time:row.time,level:['info','warn','error'].includes(row.level)?row.level:'info',action:redact(row.action).slice(0,80)};for(const [k,v]of Object.entries(row))if(ALLOWED_META.has(k)&&['string','number','boolean'].includes(typeof v))out[k]=typeof v==='string'?redact(v).slice(0,1000):v;return out;}
 add(level,action,meta={}){
  const row=this._clean({...meta,time:new Date().toISOString(),level,action});
  const line=JSON.stringify(row)+'\n';const s=regularFile(this.file);
  if(s&&s.size+Buffer.byteLength(line)>this.maxBytes){
   const last=this.file.replace(/\.jsonl$/,'.3.jsonl');regularFile(last);fs.rmSync(last,{force:true});
   for(let n=2;n>=0;n--){const from=n?this.file.replace(/\.jsonl$/,`.${n}.jsonl`):this.file;if(regularFile(from))fs.renameSync(from,this.file.replace(/\.jsonl$/,`.${n+1}.jsonl`));}
  }
  fs.appendFileSync(this.file,line,{mode:0o600});this.rows.push(row);this.rows=this.rows.slice(-this.maxEntries);return {...row};
 }
 entries(){return structuredClone(this.rows);}
 export(){return this.rows.map(r=>`${r.time} [${r.level}] ${r.action} ${JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k])=>ALLOWED_META.has(k))))}`).join('\n');}
 clear(){for(let n=0;n<=3;n++){const p=n?this.file.replace(/\.jsonl$/,`.${n}.jsonl`):this.file;regularFile(p);fs.rmSync(p,{force:true});}this.rows=[];}
}
module.exports={redact,OperationLog};

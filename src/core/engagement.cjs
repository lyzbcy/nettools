'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {dayInShanghai}=require('./updater.cjs');
const SUCCESS_ACTIONS=new Set(['diagnose','network-check','flush-dns','set-dns','clear-proxy','renew-dhcp','wifi-info','speedtest','vpn-coexist']);
class Engagement{
 constructor(file,{now=()=>new Date()}={}){this.file=file;this.now=now;this.value={days:[],operations:0,dismissedAt:null};try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw Error('使用记录无效');const data=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(data.days)||data.days.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d))||!Number.isSafeInteger(data.operations)||data.operations<0||(data.dismissedAt!==null&&!Number.isFinite(data.dismissedAt)))throw Error('使用记录无效');this.value=data;}catch(e){if(e.code!=='ENOENT')this.value={days:[],operations:0,dismissedAt:this.now().getTime()};}this.recordDay();}
 save(){fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(this.value)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);}finally{fs.rmSync(tmp,{force:true});}}
 recordDay(){this.value.days=[...new Set([...this.value.days,dayInShanghai(this.now())])].slice(-30);this.save();}
 success(action){if(!SUCCESS_ACTIONS.has(action))return;this.value.operations=Math.min(100000,this.value.operations+1);this.save();}
 dismiss(){this.value.dismissedAt=this.now().getTime();this.save();}
 snapshot(){return {show:this.value.days.length>=3&&this.value.operations>=5&&(this.value.dismissedAt===null||this.now().getTime()-this.value.dismissedAt>=15*86400000)};}
}
module.exports={Engagement};

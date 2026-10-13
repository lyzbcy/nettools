'use strict';
const {redact}=require('./log.cjs');
const {randomBytes}=require('node:crypto');
const CATEGORIES=new Set(['问题反馈','建议','真实评价']);
function limitedBytes(value,max){let text=String(value??'');while(Buffer.byteLength(text,'utf8')>max)text=text.slice(0,-1);return text;}
function previewFeedback(payload,context){
 if(!payload||typeof payload.message!=='string'||!payload.message.trim())throw Error('请填写留言');
 if(payload.message.length>2000||Buffer.byteLength(payload.message)>1500)throw Error('留言过长，请控制在 500 个汉字以内');
 if(typeof payload.includeLogs!=='boolean')throw Error('请选择是否附加日志');
 const category=payload.category??'问题反馈';if(!CATEGORIES.has(category))throw Error('反馈分类无效');
 const title=`${String(context.name||'捞鱼的网络工具').slice(0,80)} ${String(context.version||'未知版本').slice(0,40)}\n${category}\n`;
 let text=title+payload.message.trim();
 if(payload.includeLogs){const logs=redact(context.logs||'');const room=1900-Buffer.byteLength(text+'\n\n脱敏操作日志：\n');if(room>0&&logs)text+='\n\n脱敏操作日志：\n'+limitedBytes(logs,room);}
 return text;
}
async function sendFeedback(payload,context,{endpoint,post}){
 return sendText(previewFeedback(payload,context),{endpoint,post});
}
async function sendText(text,{endpoint,post}){
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.hostname!=='qyapi.weixin.qq.com'||url.pathname!=='/cgi-bin/webhook/send'||url.username||url.password||!url.searchParams.get('key'))throw Error('反馈通道配置无效');
 const result=await post(endpoint,{msgtype:'text',text:{content:text}});
 if(!result||result.errcode!==0)throw Error(`反馈发送失败（${result?.errcode??'无响应'}），请稍后重试`);
 return {ok:true,message:'反馈已送达，谢谢你帮助改进'};
}
function fields(value,allowed){
 if(!value||typeof value!=='object'||Object.prototype.toString.call(value)!=='[object Object]'||Object.keys(value).some(key=>!allowed.includes(key)))throw Error('反馈参数无效');
}
function formKey(payload){return JSON.stringify({category:payload.category??'问题反馈',message:payload.message,includeLogs:payload.includeLogs});}
const PREVIEW_TTL_MS=5*60000;
class FeedbackSession{
 constructor({now=()=>Date.now()}={}){this.now=now;this.active=null;this.sending=false;}
 preview(payload,context){
  if(this.sending)throw Error('反馈正在发送，请稍候');
  this.active=null;fields(payload,['category','message','includeLogs']);
  const text=previewFeedback(payload,context),previewId=randomBytes(16).toString('hex');
  // Store only bounded final text and the bounded form identity, never raw logs.
  this.active={previewId,text,key:formKey(payload),expiresAt:this.now()+PREVIEW_TTL_MS};return {text,previewId};
 }
 cancel(request){
  if(arguments.length!==1)throw Error('取消反馈参数无效');fields(request,['previewId']);
  if(Object.hasOwn(request,'previewId')&&(typeof request.previewId!=='string'||!/^[a-f0-9]{32}$/.test(request.previewId)))throw Error('取消反馈参数无效');
  if(!request.previewId||request.previewId===this.active?.previewId)this.active=null;return {cancelled:true};
 }
 async send(request,{getEndpoint,post}){
  if(this.sending)throw Error('反馈正在发送，请稍候');fields(request,['category','message','includeLogs','previewId']);
  const preview=this.active;
  if(!preview||typeof request.previewId!=='string'||request.previewId!==preview.previewId)throw Error('请先重新预览，再发送反馈');
  if(this.now()>=preview.expiresAt||formKey(request)!==preview.key){this.active=null;throw Error('内容已变化或预览已过期，请重新预览后发送');}
  // Consume before any credential read or asynchronous work; no retry/replay.
  this.active=null;this.sending=true;
  try{return await sendText(preview.text,{endpoint:await getEndpoint(),post});}finally{this.sending=false;}
 }
}
module.exports={previewFeedback,sendFeedback,limitedBytes,FeedbackSession};

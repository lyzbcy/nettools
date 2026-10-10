'use strict';
const {redact}=require('./log.cjs');
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
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.hostname!=='qyapi.weixin.qq.com'||url.pathname!=='/cgi-bin/webhook/send'||url.username||url.password||!url.searchParams.get('key'))throw Error('反馈通道配置无效');
 const preview=previewFeedback(payload,context);
 const result=await post(endpoint,{msgtype:'text',text:{content:preview}});
 if(!result||result.errcode!==0)throw Error(`反馈发送失败（${result?.errcode??'无响应'}），请稍后重试`);
 return {ok:true,message:'反馈已送达，谢谢你帮助改进'};
}
module.exports={previewFeedback,sendFeedback,limitedBytes};

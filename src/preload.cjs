'use strict';
const {contextBridge,ipcRenderer}=require('electron');
async function request(channel,...args){const result=await ipcRenderer.invoke(channel,...args);if(!result?.ok)throw Object.assign(Error(result?.error?.message||'操作未完成'),{code:result?.error?.code||'APP_ERROR'});return result.data;}
contextBridge.exposeInMainWorld('nettools',Object.freeze({
 snapshot:()=>request('nettools:snapshot'),call:(action,args={})=>request('nettools:call',action,args),settings:patch=>request('nettools:settings',patch),check:()=>request('nettools:check'),cancelRestart:()=>request('nettools:cancel-restart'),
 logs:()=>request('nettools:logs'),copyLogs:()=>request('nettools:copy-logs'),clearLogs:()=>request('nettools:clear-logs'),open:key=>request('nettools:open',key),window:action=>request('nettools:window',action),quit:()=>request('nettools:quit'),
 dismissEngagement:()=>request('nettools:dismiss-engagement'),
 feedback:Object.freeze({preview:payload=>request('nettools:feedback-preview',payload),send:payload=>request('nettools:feedback-send',payload),cancel:(requestValue={})=>request('nettools:feedback-cancel',requestValue)}),
 update:Object.freeze({check:()=>request('nettools:update-check'),stage:()=>request('nettools:update-stage'),install:()=>request('nettools:update-install'),cancel:()=>request('nettools:update-cancel')}),
 onState:listener=>{if(typeof listener!=='function')throw TypeError('需要状态回调');const handler=(_event,state)=>listener(state);ipcRenderer.on('nettools:state',handler);return ()=>ipcRenderer.removeListener('nettools:state',handler);}
}));

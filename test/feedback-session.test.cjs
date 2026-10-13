'use strict';
// Actual main setup, IPC, Controller, OperationLog and HTTP encoding. Only OS,
// Electron lifecycle and the private credential/transport boundary are isolated.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const root=path.resolve(__dirname,'..'),mainFile=path.join(root,'src/main.cjs'),realRequire=createRequire(mainFile);
async function mainFixture(t,{postWait}={}){
 const data=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-feedback-'));t.after(()=>fs.rmSync(data,{recursive:true,force:true}));const handlers=new Map(),posts=[];let configReads=0;
 const app=new EventEmitter();Object.assign(app,{isPackaged:false,getPath:()=>data,setName(){},requestSingleInstanceLock:()=>false,quit(){}});
 const mainFrame={url:require('node:url').pathToFileURL(path.join(root,'ui/index.html')).href},webContents={id:71,mainFrame,send(){}},window={webContents,isDestroyed:()=>false};
 const platform={invoke:async action=>action==='helper-status'?{installed:false}:action==='network-check'?{ok:true,issue:'ok'}:{},repair:async()=>({ok:false})};
 const electron={app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},powerMonitor:new EventEmitter(),Notification:{isSupported:()=>false},net:{fetch:async(_url,options)=>{posts.push(JSON.parse(options.body));if(postWait)await postWait;return {ok:true,body:new ReadableStream({start(c){c.enqueue(Buffer.from('{"errcode":0}'));c.close();}})};}}};
 const safeFs=new Proxy(fs,{get(target,key){if(key==='lstatSync')return file=>String(file).endsWith('feedback-channel.json')?{isSymbolicLink:()=>false,isFile:()=>true,size:70}:target.lstatSync(file);if(key==='readFileSync')return (file,...args)=>{if(String(file).endsWith('feedback-channel.json')){configReads++;return JSON.stringify({endpoint:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture'});}return target.readFileSync(file,...args);};return target[key];}});
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(mainFile,'utf8')+'\nwindow=fixtureWindow;module.exports={setup,getLogger:()=>logger,getEngagement:()=>engagement,getController:()=>controller};',{module,fixtureWindow:window,__dirname:path.dirname(mainFile),process:{...process,argv:[],env:{}},Buffer,URL,AbortController,structuredClone,setTimeout,clearTimeout,require:name=>name==='electron'?electron:name==='node:fs'?safeFs:name==='./platform/darwin.cjs'?{createDarwinPlatform:()=>platform}:name==='./platform/windows.cjs'?{createWindowsPlatform:()=>platform}:name==='./core/updater.cjs'?{Updater:class{snapshot(){return {};}async check(){}}}:realRequire(name)},{filename:mainFile});
 await module.exports.setup();const event={sender:webContents,senderFrame:mainFrame};const call=(name,...args)=>handlers.get('nettools:'+name)(event,...args);return {call,handlers,posts,get configReads(){return configReads;},logger:module.exports.getLogger(),engagement:module.exports.getEngagement(),controller:module.exports.getController(),event};
}
const p={category:'问题反馈',message:'请检查连接',includeLogs:true};
test('actual main sends the exact preview despite newly appended or cleared logs',async t=>{
 const f=await mainFixture(t);f.logger.add('info','scanfiles1',{ok:true});const preview=await f.call('feedback-preview',p);assert.equal(preview.ok,true);f.logger.add('info','cleaningfiles2',{ok:true});
 const sent=await f.call('feedback-send',{...p,previewId:preview.data.previewId});assert.equal(sent.ok,true);assert.equal(f.posts.length,1);assert.equal(f.posts[0].text.content,preview.data.text,'HTTP body must equal what the user previewed');assert.ok(!f.posts[0].text.content.includes('cleaningfiles2'));
 const second=await f.call('feedback-preview',p);f.logger.clear();assert.equal((await f.call('feedback-send',{...p,previewId:second.data.previewId})).ok,true);assert.equal(f.posts[1].text.content,second.data.text);
});
test('actual main rejects missing, changed, replaced, cancelled and replayed previews before config or HTTP',async t=>{
 const f=await mainFixture(t);assert.equal((await f.call('feedback-send',p)).ok,false,'no preview must reject');assert.equal(f.configReads,0);
 const first=(await f.call('feedback-preview',p)).data;assert.equal((await f.call('feedback-send',{...p,message:'不同留言',previewId:first.previewId})).ok,false);assert.equal(f.configReads,0);
 const second=(await f.call('feedback-preview',p)).data;assert.equal((await f.call('feedback-send',{...p,previewId:first.previewId})).ok,false);
 assert.equal(typeof f.handlers.get('nettools:feedback-cancel'),'function');await f.call('feedback-cancel',{});assert.equal((await f.call('feedback-send',{...p,previewId:second.previewId})).ok,false);
 const third=(await f.call('feedback-preview',p)).data;assert.equal((await f.call('feedback-send',{...p,previewId:third.previewId})).ok,true);assert.equal((await f.call('feedback-send',{...p,previewId:third.previewId})).ok,false);assert.equal(f.configReads,1);assert.equal(f.posts.length,1);
});
test('actual IPC rejects extra renderer authority and nonlocal/subframe cancel requests',async t=>{
 const f=await mainFixture(t);for(const field of ['logs','path','endpoint','text'])assert.equal((await f.call('feedback-preview',{...p,[field]:'untrusted'})).ok,false,field);
 const cancel=f.handlers.get('nettools:feedback-cancel');assert.equal(typeof cancel,'function');for(const event of [{sender:{id:99,mainFrame:f.event.senderFrame},senderFrame:f.event.senderFrame},{sender:f.event.sender,senderFrame:{url:f.event.senderFrame.url}}])assert.equal((await cancel(event,{})).ok,false);
 for(const malformed of [new Date(),new Map(),[],null,42])assert.equal((await f.call('feedback-cancel',malformed)).ok,false,'cancel requires a plain record');assert.equal((await f.call('feedback-cancel',{path:'/tmp/untrusted'})).ok,false);assert.equal((await f.call('feedback-cancel',{},{})).ok,false);assert.equal(f.configReads,0);assert.equal(f.posts.length,0);
});
test('actual main consumes authorization synchronously and has a single in-flight send',async t=>{
 let resolve;const f=await mainFixture(t,{postWait:new Promise(r=>resolve=r)});const first=(await f.call('feedback-preview',p)).data;const pending=f.call('feedback-send',{...p,previewId:first.previewId});f.logger.add('info','after-await',{ok:true});
 const duplicate=f.call('feedback-send',{...p,previewId:first.previewId});try{assert.equal(f.configReads,1,'duplicate must reject before private config read');assert.equal((await duplicate).ok,false);assert.equal((await f.call('feedback-preview',p)).ok,false);assert.equal(f.posts.length,1);}finally{resolve();await Promise.all([pending,duplicate]);}assert.equal((await pending).ok,true);assert.equal(f.posts[0].text.content,first.text);
});
test('host session expires authorization, bounds capture and consumes it before credential await',async()=>{
 const {FeedbackSession}=require('../src/core/feedback.cjs');assert.equal(typeof FeedbackSession,'function');let now=100,resolve,reads=0,posts=[];const session=new FeedbackSession({now:()=>now});
 const context={name:'捞鱼的网络工具',version:'5.0.2',logs:'scanfiles1\n'.repeat(1000)},preview=session.preview(p,context);assert.ok(Buffer.byteLength(preview.text)<=1900);now+=5*60000;
 await assert.rejects(session.send({...p,previewId:preview.previewId},{getEndpoint:()=>{reads++;},post:async()=>{}}),/预览/);assert.equal(reads,0);
 const fresh=session.preview(p,context),pending=session.send({...p,previewId:fresh.previewId},{getEndpoint:async()=>{reads++;await new Promise(r=>resolve=r);return 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture';},post:async(_url,body)=>{posts.push(body);return {errcode:0};}});context.logs='new log';session.cancel({});
 await assert.rejects(session.send({...p,previewId:fresh.previewId},{getEndpoint:()=>{reads++;},post:async()=>{}}));resolve();assert.equal((await pending).ok,true);assert.equal(reads,1);assert.equal(posts[0].text.content,fresh.text);
});
test('late cancellation cannot revoke a newer preview and failed sends require re-preview without retry',async()=>{
 const {FeedbackSession}=require('../src/core/feedback.cjs'),session=new FeedbackSession(),context={name:'捞鱼的网络工具',version:'5.0.2'};
 const old=session.preview(p,context),fresh=session.preview(p,context);session.cancel({previewId:old.previewId});let calls=0;
 await assert.rejects(session.send({...p,previewId:fresh.previewId},{getEndpoint:()=> 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture',post:async()=>{calls++;throw Error('fixture offline');}}),/offline/);assert.equal(calls,1);
 await assert.rejects(session.send({...p,previewId:fresh.previewId},{getEndpoint:()=>{throw Error('must not read credentials');},post:async()=>{calls++;}}),/预览/);assert.equal(calls,1);
 const retry=session.preview(p,context);assert.equal((await session.send({...p,previewId:retry.previewId},{getEndpoint:()=> 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture',post:async()=>{calls++;return {errcode:0};}})).ok,true);assert.equal(calls,2);
});

test('actual main confirmed feedback is independent of auxiliary usage and settings writes',async t=>{
 const f=await mainFixture(t);f.engagement.dismiss=()=>{throw Error('fixture usage unavailable');};f.engagement.save=()=>{throw Error('fixture usage unavailable');};f.controller.updateSettings=async()=>{throw Error('fixture settings unavailable');};
 const preview=(await f.call('feedback-preview',p)).data;const result=await f.call('feedback-send',{...p,previewId:preview.previewId});assert.equal(result.ok,true);assert.equal(result.data.ok,true);assert.equal(f.posts.length,1);assert.equal(f.posts[0].text.content,preview.text);
});

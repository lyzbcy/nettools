'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let log,feedback;try{log=require('../src/core/log.cjs');}catch{}try{feedback=require('../src/core/feedback.cjs');}catch{}
test('logs redact private network addresses, domains, paths and credentials',()=>{
 assert.equal(typeof log?.redact,'function');
 const text=log.redact('DNS 10.2.3.4 gitlab.corp.example /Users/zeen/private/config.json token=very-secret Bearer abc123');
 for(const secret of ['10.2.3.4','gitlab.corp.example','/Users/zeen','very-secret','abc123'])assert.ok(!text.includes(secret));
});
test('persistent operation log is bounded, survives reopening, and clears all rotations',t=>{
 assert.equal(typeof log?.OperationLog,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const l=new log.OperationLog(dir,{maxBytes:1024,maxEntries:4});
 for(let i=0;i<35;i++)l.add('info','diagnose',{message:'result '.repeat(15),durationMs:i});
 assert.ok(l.entries().length<=4);assert.ok(fs.readdirSync(dir).length<=4);
 const reopened=new log.OperationLog(dir,{maxBytes:1024,maxEntries:4});assert.ok(reopened.entries().length>0);
 assert.ok(reopened.export().includes('diagnose'));reopened.clear();assert.equal(reopened.entries().length,0);
 assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')).length,0);
});
test('nested sensitive metadata is excluded before persistence and exports',t=>{
 assert.equal(typeof log?.OperationLog,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nettools-log-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const l=new log.OperationLog(dir);l.add('error','repair',{password:'hidden-password',config:{internalHost:'corp.private'},message:'failed 192.168.1.5',code:'FAILED'});
 const all=fs.readFileSync(path.join(dir,'operations.jsonl'),'utf8')+l.export();
 for(const secret of ['hidden-password','corp.private','192.168.1.5'])assert.ok(!all.includes(secret));
 assert.ok(all.includes('FAILED'));
});
test('feedback preview includes name/version, bounded note, and only optional redacted logs',()=>{
 assert.equal(typeof feedback?.previewFeedback,'function');
 const r=feedback.previewFeedback({category:'问题反馈',message:'网络无法使用',includeLogs:false},{name:'捞鱼的网络工具',version:'5.0.0',logs:'10.1.2.3'});
 assert.ok(r.includes('捞鱼的网络工具'));assert.ok(r.includes('5.0.0'));assert.ok(r.includes('网络无法使用'));assert.ok(!r.includes('10.1.2.3'));
 const included=feedback.previewFeedback({category:'问题反馈',message:'检查故障',includeLogs:true},{name:'捞鱼的网络工具',version:'5.0.0',logs:'DNS 10.1.2.3 token=secret'});
 assert.ok(!included.includes('10.1.2.3'));assert.ok(!included.includes('secret'));
 assert.throws(()=>feedback.previewFeedback({message:'',includeLogs:true},{}));
 assert.throws(()=>feedback.previewFeedback({message:'a'.repeat(2001),includeLogs:false},{}));
});
test('feedback sends only on explicit call, propagates transport rejection, and has no retry',async()=>{
 assert.equal(typeof feedback?.sendFeedback,'function');let count=0;
 const payload={category:'建议',message:'增加提示',includeLogs:false}, context={name:'捞鱼的网络工具',version:'5.0.0',logs:''};
 await assert.rejects(feedback.sendFeedback(payload,context,{endpoint:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',post:async()=>{count++;throw Error('offline');}}),/offline/);
 assert.equal(count,1);
 const result=await feedback.sendFeedback(payload,context,{endpoint:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',post:async(url,body)=>{count++;assert.equal(body.msgtype,'text');return {errcode:0};}});
 assert.equal(result.ok,true);assert.equal(count,2);
});
test('feedback cannot be redirected to an arbitrary endpoint or report server rejection as success',async()=>{
 assert.equal(typeof feedback?.sendFeedback,'function');const p={message:'失败反馈',includeLogs:false},c={name:'捞鱼的网络工具',version:'5.0.0'};
 await assert.rejects(feedback.sendFeedback(p,c,{endpoint:'http://example.com',post:async()=>({errcode:0})}));
 await assert.rejects(feedback.sendFeedback(p,c,{endpoint:'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',post:async()=>({errcode:40058,errmsg:'invalid'})}),/40058/);
});

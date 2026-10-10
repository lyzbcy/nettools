'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
let api;try{api=require('../src/core/http.cjs');}catch{}
test('JSON transport rejects HTTP errors and caps responses before parsing',async()=>{
 assert.equal(typeof api?.jsonRequest,'function');await assert.rejects(api.jsonRequest(async()=>new Response('offline',{status:503}),'https://example.test'),/503/);
 await assert.rejects(api.jsonRequest(async()=>new Response('x'.repeat(1024*1024+1)),'https://example.test'),/过大/);
 assert.deepEqual(await api.jsonRequest(async()=>new Response('{"ok":true}'),'https://example.test'),{ok:true});
});
test('already aborted requests do not perform network transmission',async()=>{
 assert.equal(typeof api?.jsonRequest,'function');let calls=0;const c=new AbortController();c.abort();await assert.rejects(api.jsonRequest(async()=>{calls++;return new Response('{}');},'https://example.test',{signal:c.signal}));assert.equal(calls,0);
});
test('downloads write actual streamed bytes, report progress and reject excess data',async t=>{
 assert.equal(typeof api?.download,'function');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nettools-http-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const progress=[];
 await api.download(async()=>new Response('package'),{url:'https://example.test/package',size:7},path.join(dir,'good'),{onProgress:r=>progress.push(r)});assert.equal(await fs.readFile(path.join(dir,'good'),'utf8'),'package');assert.equal(progress.at(-1),7);
 await assert.rejects(api.download(async()=>new Response('too large'),{url:'https://example.test/package',size:1},path.join(dir,'bad'),{}),/超过/);
});

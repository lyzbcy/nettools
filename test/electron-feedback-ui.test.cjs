'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{spawnSync}=require('node:child_process');
test('production DOM feedback handlers revoke edits, close, Escape, late preview and unmount',t=>{
 let pkg;try{pkg=require.resolve('electron/package.json');}catch(e){if(e.code==='MODULE_NOT_FOUND')return t.skip('Pinned Electron absent before CI runtime build');throw e;}
 const executable=process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':process.platform==='win32'?'electron.exe':'electron',local=path.resolve('.local-tools',`electron-${process.platform}-${process.arch}`,executable),electron=fs.existsSync(local)?local:path.join(path.dirname(pkg),'dist',executable),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=spawnSync(electron,[path.resolve('test/fixtures/electron-feedback-ui.cjs')],{env,timeout:60000,maxBuffer:1024*1024,encoding:'utf8'});assert.equal(result.error,undefined,result.error?.stack);assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout.trim());for(const flag of ['productionDom','productionPreload','edits','closeEscape','lateIgnored','singleSend','busyPreviewPreserved','unmount'])assert.equal(report[flag],true);
});

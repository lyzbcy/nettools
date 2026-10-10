'use strict';
// CI-only acceptance of the installed Electron application. This entry is never
// activated by the UI or a regular desktop launch and never sends feedback.
const fs=require('node:fs/promises'),path=require('node:path');
async function settlePage(window){await window.webContents.executeJavaScript('(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()',true);}
async function desktopAcceptance({app,window,getState,reportDir}){
 if(process.env.CI!=='true'||!path.isAbsolute(reportDir))throw Error('桌面验收入口仅允许隔离 CI');
 const report={platform:process.platform,arch:process.arch,version:app.getVersion(),packaged:app.isPackaged,visible:window.isVisible(),steps:[],startedAt:new Date().toISOString()};
 const evaluate=code=>window.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function waitFor(code){const end=Date.now()+15000;while(Date.now()<end){if(await evaluate(code))return;await sleep(75);}throw Error('界面验收等待超时');}
 async function screenshot(name){
  await settlePage(window);
  const current=getState();if(current.settings.intervalMinutes===17){const disk=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'settings.json'),'utf8'));if(disk.intervalMinutes!==17||disk.enabled||disk.restartOnTimeout||disk.launchAtLogin)throw Error('截图前磁盘设置与17分钟安全状态不一致');await waitFor("document.getElementById('interval-trigger').textContent.includes('17')");}
  const pixels=await window.webContents.capturePage();await fs.writeFile(path.join(reportDir,name+'.png'),pixels.toPNG());report.steps.push({name,screenshot:name+'.png',ok:true});
 }
 try{
  await fs.mkdir(reportDir,{recursive:true});if(!report.packaged||!report.visible)throw Error('不是实际可见安装版');const initial=getState();if(initial.settings.enabled||initial.settings.restartOnTimeout)throw Error('默认保活或重启意外开启');report.native={healthy:initial.network?.ok===true,diagnosticError:initial.lastError?.code||null,authorizationInstalled:initial.authorization?.installed===true};
  if(initial.lastError)throw Error('原生初始化未完成：'+initial.lastError.code);
  await waitFor("document.getElementById('network-pill').textContent!=='正在读取状态'");await screenshot('01-dashboard');
  await evaluate("document.querySelector('[data-page=guard]').click()");await waitFor("document.getElementById('page-guard').classList.contains('active')");
  await evaluate("document.getElementById('interval-trigger').click();document.querySelector('[data-interval=custom]').click();document.getElementById('interval-number').value='17';document.getElementById('save-interval').click()");await waitFor("document.getElementById('interval-trigger').textContent.includes('17')");
  if(getState().settings.intervalMinutes!==17||getState().settings.restartOnTimeout)throw Error('间隔未真正持久化或重启策略发生变化');await screenshot('02-guard-custom-interval');
  await evaluate("document.getElementById('interval-number').value='0';document.getElementById('save-interval').click()");await waitFor("document.getElementById('toast').textContent.includes('整数分钟')");if(getState().settings.intervalMinutes!==17)throw Error('非法间隔改变了设置');report.steps.push({name:'invalid-interval-preserves-setting',ok:true});
  await evaluate("document.querySelector('[data-page=diagnose]').click();document.querySelector('[data-action=diagnose]').click()");await waitFor("document.querySelectorAll('#diagnose-results .diagnose-row').length===8");await screenshot('03-actual-eight-item-diagnosis');
  await evaluate("document.getElementById('open-logs').click()");await waitFor("!document.getElementById('logs-modal').classList.contains('hidden')");await screenshot('04-operation-log');await evaluate("document.querySelector('[data-close=logs-modal]').click()");
  await evaluate("document.getElementById('open-feedback').click();document.getElementById('feedback-message').value='CI 只预览反馈，不发送';document.getElementById('preview-feedback').click()");await waitFor("document.getElementById('feedback-preview').textContent.includes('CI 只预览反馈')");await screenshot('05-feedback-preview-no-send');await evaluate("document.querySelector('[data-close=feedback-modal]').click()");
  window.setSize(900,620);await sleep(300);for(const page of ['dashboard','guard','diagnose','repair','wifi','vpn','about']){await evaluate(`document.querySelector('[data-page=${page}]').click()`);await sleep(100);const overflow=await evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth+1");if(overflow)throw Error('最小窗口出现横向溢出：'+page);
   const entries=await evaluate("(()=>{const side=document.querySelector('.sidebar').getBoundingClientRect(),footer=document.querySelector('footer').getBoundingClientRect();return ['open-logs','open-feedback','check-update'].map(id=>{const button=document.getElementById(id),rect=button.getBoundingClientRect(),hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2),style=getComputedStyle(button);return {id,top:rect.top,bottom:rect.bottom,footerTop:footer.top,visible:rect.width>0&&rect.height>0&&rect.top>=side.top&&rect.bottom<=Math.min(side.bottom,footer.top,innerHeight)&&rect.left>=side.left&&rect.right<=side.right&&style.visibility==='visible'&&style.display!=='none',clickable:!button.disabled&&!!hit&&(hit===button||button.contains(hit))};});})()");
   if(entries.some(entry=>!entry.visible||!entry.clickable))throw Error('最小窗口侧栏入口被遮挡或不可点击：'+JSON.stringify(entries));report.steps.push({name:'minimum-sidebar-entries',page,entries,ok:true});await screenshot('06-minimum-'+page);}
  const current=getState();if(current.settings.enabled||current.settings.restartOnTimeout)throw Error('只读验收改变了保活/重启安全默认值');report.settingsPreserved=true;report.ok=true;
 }catch(error){report.ok=false;report.error=error.message;throw error;}
 finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(reportDir,'desktop-report.json'),JSON.stringify(report,null,2)+'\n');}
 return report;
}
module.exports={desktopAcceptance,settlePage};

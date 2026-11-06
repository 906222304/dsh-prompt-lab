/** Real Chromium + React DOM acceptance with isolated user data. No live user profile is touched. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(url) {
    this.sequence = 0; this.pending = new Map(); this.events = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve,reject) => { this.socket.addEventListener('open',resolve); this.socket.addEventListener('error',reject); });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const operation=this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) operation?.reject(new Error(JSON.stringify(message.error))); else operation?.resolve(message.result);
      } else this.events.get(message.method)?.(message.params);
    });
  }
  async call(method, params = {}) {
    await this.ready; const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});
  }
  async evaluate(expression) {
    const result=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
}
async function main() {
  const browser = process.env.PROMPT_LAB_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const dependencies = process.env.PROMPT_LAB_BROWSER_DEPS;
  if (!dependencies) throw new Error('Set PROMPT_LAB_BROWSER_DEPS to a node_modules directory with react@18 and react-dom@18');
  const project=path.resolve(__dirname,'..');
  const pluginVersion=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8')).version;
  const working=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-browser-'));
  const artifactDir=process.env.PROMPT_LAB_BROWSER_ARTIFACTS || path.join(working,'artifacts');
  fs.mkdirSync(artifactDir,{recursive:true});
  const downloads=path.join(working,'downloads');fs.mkdirSync(downloads);
  const oldHome=process.env.DSH_HOME; process.env.DSH_HOME=path.join(working,'home');
  const state=await import(pathToFileURL(path.join(project,'lib/state.js')).href);
  const plugin=await import(pathToFileURL(path.join(project,'lib/index.js')).href);
  const ui=await import(pathToFileURL(path.join(project,'lib/ui.js')).href);
  const sections=[], hooks={};
  plugin.apply({systemPrompt:{section(s){sections.push(s);}},on(name,fn){hooks[name]=fn;}},{prompt:'浏览器验收初始正文'});
  const html=`<!doctype html><meta charset="utf-8"><title>Prompt Lab ${pluginVersion} acceptance</title>
<style>body{margin:0;background:#222;color:#eee}#app{height:100vh;display:flex}</style>
<div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script>
<script>const root=ReactDOM.createRoot(document.getElementById('app'));window.__qaUnmount=()=>root.render(null);
window.__ModuleLoader__={load(bundle){const plugin=bundle.factory(name=>{if(name==='react')return React;throw Error(name)});
plugin.apply({effect:fn=>fn(),slots:{inject(name,fn){fn()},register(options,render){window.__qaRender=()=>root.render(render());return ()=>root.render(null)}}});window.__qaRender();}};</script><script src="/client.js"></script>`;
  const server=http.createServer(async(req,res)=>{
    try {
      const route=new URL(req.url,'http://localhost').pathname;
      if(route.startsWith('/prompt-lab/api'))return await ui.handler(req,res);
      if(route==='/qa/assemble') {
        const input={sections:sections.slice().sort((a,b)=>a.order-b.order).map(s=>({name:s.name,order:s.order,text:s.text({})})),contexts:[]};
        await hooks['system-prompt/assemble'](input,{},async()=>input);
        res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true}));
      }
      const files={'/react.js':path.join(dependencies,'react/umd/react.development.js'),'/react-dom.js':path.join(dependencies,'react-dom/umd/react-dom.development.js'),'/client.js':path.join(project,'client.js')};
      if(files[route]){res.writeHead(200,{'content-type':'text/javascript'});return res.end(fs.readFileSync(files[route]));}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port, browserData=path.join(working,'browser');
  const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${browserData}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let rootCDP,page;
  const errors=[];let acceptDialog=true;
  async function wait(condition,label) {
    for(let i=0;i<100;i++){if(await condition())return;await delay(100);}
    throw new Error('Timeout: '+label);
  }
  try {
    const portFile=path.join(browserData,'DevToolsActivePort');
    await wait(()=>fs.existsSync(portFile),'browser startup');
    const [debugPort,browserSocket]=fs.readFileSync(portFile,'utf8').trim().split('\n');
    rootCDP=new CDP(`ws://127.0.0.1:${debugPort}${browserSocket.trim()}`);
    await rootCDP.call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    const response=await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const target=(await response.json()).find(item=>item.type==='page');page=new CDP(target.webSocketDebuggerUrl);
    page.events.set('Runtime.exceptionThrown',event=>errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
    page.events.set('Page.javascriptDialogOpening',()=>page.call('Page.handleJavaScriptDialog',{accept:acceptDialog}));
    await page.call('Runtime.enable');await page.call('Page.enable');
    await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
    await page.call('Page.navigate',{url:`http://127.0.0.1:${port}/`});
    await wait(()=>page.evaluate(`!!document.querySelector('textarea')`),'initial panel');
    const ensureMenu=async label=>{
      if(['新建配置','复制已保存配置','重命名','删除配置','导出此配置','配置名称'].includes(label)) {
        await page.evaluate(`(()=>{if(!document.querySelector('[aria-label="管理配置操作"]'))[...document.querySelectorAll('button')].find(b=>b.textContent==='管理配置')?.click()})()`);
      }
      if(['复制规则','删除规则','导出规则'].includes(label)) {
        await page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='更多操作');if(b?.getAttribute('aria-expanded')==='false')b.click()})()`);
      }
    };
    const ready=label=>wait(()=>page.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});return !!b&&!b.disabled&&b.getClientRects().length>0})()`),'button ready '+label);
    const click=async label=>{
      await ensureMenu(label);
      await ready(label);
      return page.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)});button.scrollIntoView({block:'nearest'});button.click();})()`);
    };
    const fill=async(selector,value)=>{
      if(selector==='[aria-label="配置名称"]')await ensureMenu('配置名称');
      await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const d=e?.closest('details');if(d&&!d.open)d.querySelector('summary').click()})()`);
      await wait(()=>page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled&&document.querySelector(${JSON.stringify(selector)}).getClientRects().length>0`),'input ready '+selector);
      return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    const select=async(selector,value)=>{
      return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e.getClientRects().length){const name=${JSON.stringify(selector)}.includes('共享规则')?'data-rule-id':'data-profile-id';document.querySelector('['+name+'="'+${JSON.stringify(value)}+'"]')?.click();return;}e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    const text=()=>page.evaluate('document.body.innerText');
    const next=async()=>delay(150);
    await fill('[aria-label="配置名称"]','浏览器方案');await next();await click('新建配置');
    await wait(()=>state.snapshot().profiles.length===4,'profile created');await next();
    const id=state.snapshot().profiles.at(-1).id;
    await fill('textarea','browser body');await fill('textarea.rules','browser legacy');await next();await click('保存配置');
    await wait(()=>state.snapshot().profiles.find(p=>p.id===id).prompt==='browser body','profile saved');await next();
    await click('启用这套配置');await wait(()=>state.snapshot().selected===id,'profile activated');await next();
    await click('规则库');await next();
    for(const [name,content] of [['共享甲','alpha'],['共享乙','beta']]) {
      await fill('[aria-label="规则名称"]',name);await fill('[aria-label="规则正文"]',content);await next();await click('保存规则');
      await wait(()=>state.snapshot().ruleSets.some(r=>r.name===name),'rule '+name);await next();
      if(name==='共享甲'){await click('新建规则');await next();}
    }
    await click('复制规则');await wait(()=>state.snapshot().ruleSets.length===3,'rule copy');await next();
    await fill('[aria-label="规则名称"]','副本改名');await next();await click('保存规则');
    await wait(()=>state.snapshot().ruleSets.some(r=>r.name==='副本改名'),'rule rename');await next();
    await ready('保存规则');
    await page.evaluate(`document.querySelector('input[type=checkbox]').click()`);await next();await click('保存规则');
    await wait(()=>state.snapshot().ruleSets.find(r=>r.name==='副本改名').enabled===false,'rule disabled');await next();
    await click('删除规则');await wait(()=>state.snapshot().ruleSets.length===2,'rule deletion');await next();
    const firstRuleId=state.snapshot().ruleSets.find(r=>r.name==='共享甲').id;
    await select('[aria-label="选择共享规则"]',firstRuleId);await next();
    await fill('[aria-label="规则正文"]','unsaved rule draft');await next();
    await click('提示词与规则');await next();await click('规则库');await next();
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="规则正文"]').value`),'unsaved rule draft');
    await click('载入最新规则');await next();
    assert.equal(await page.evaluate(`document.querySelector('[aria-label="规则正文"]').value`),'alpha');
    await click('提示词与规则');await next();
    for(const name of ['共享甲','共享乙']) {
      await page.evaluate(`(()=>{const row=[...document.querySelectorAll('.pl-inline')].find(e=>e.querySelector('span')?.textContent===${JSON.stringify(name)});[...row.querySelectorAll('button')].find(b=>b.textContent==='添加引用').click();})()`);await next();
    }
    await page.evaluate(`(()=>{const row=[...document.querySelectorAll('.pl-inline')].find(e=>e.querySelector('span')?.textContent==='2. 共享乙');[...row.querySelectorAll('button')].find(b=>b.textContent==='↑').click();})()`);await next();
    await click('保存配置');await next();
    const ruleB=state.snapshot().ruleSets.find(r=>r.name==='共享乙').id;
    await wait(()=>state.snapshot().profiles.find(p=>p.id===id).ruleIds[0]===ruleB,'reference order');
    await page.evaluate(`fetch('/qa/assemble',{method:'POST'})`);
    assert.equal(state.snapshot().assembly.sections[1].text,'## 当前规则集\nbrowser legacy\n\n## 共享乙\nbeta\n\n## 共享甲\nalpha');
    await click('规则库');await next();await select('[aria-label="选择共享规则"]',firstRuleId);await next();
    await ensureMenu('删除规则');await next();
    assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='删除规则').disabled`),true);
    assert.ok((await text()).includes('浏览器方案'));
    await click('提示词与规则');await next();
    const p=state.snapshot().profiles.find(p=>p.id===id);
    state.updateProfile({action:'save',...p,prompt:'other window',expectedVersion:p.version},{requireVersion:true});
    await fill('textarea','unsaved browser');await next();await click('保存配置');
    await wait(async()=>(await text()).includes('其他窗口'),'save conflict');
    assert.equal(await page.evaluate(`document.querySelector('textarea').value`),'unsaved browser');
    await click('载入最新版本');await next();assert.equal(await page.evaluate(`document.querySelector('textarea').value`),'other window');
    await click('复制已保存配置');await wait(()=>state.snapshot().profiles.length===5,'profile copy');await next();
    await fill('[aria-label="配置名称"]','副本方案');await next();await click('重命名');await wait(()=>state.snapshot().profiles.some(p=>p.name==='副本方案'),'profile rename');await next();
    await click('导出此配置');
    await wait(()=>fs.readdirSync(downloads).some(p=>p.endsWith('.json')),'JSON download');
    const exportFile=path.join(downloads,fs.readdirSync(downloads).find(p=>p.endsWith('.json')));
    const exported=JSON.parse(fs.readFileSync(exportFile));assert.equal(exported.profiles[0].name,'副本方案');assert.equal(exported.ruleSets.length,2);
    await click('导入导出');await next();
    const doc=await page.call('DOM.getDocument');const input=await page.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'input[type=file]'});
    await page.call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:[exportFile]});
    await wait(async()=>(await text()).includes('导入预览'),'import preview');assert.equal(state.snapshot().profiles.length,5);
    await click('确认追加导入');await wait(()=>state.snapshot().profiles.length===6,'import commit');await next();
    assert.equal(state.snapshot().ruleSets.length,4);assert.equal(state.snapshot().selected,id);
    await click('提示词与规则');await next();
    await select('select.pl-select',id);await next();await click('删除配置');
    await wait(()=>state.snapshot().profiles.length===5,'active profile delete');await next();assert.equal(state.snapshot().selected,'default');
    await fill('textarea','草稿恢复');await next();await page.evaluate('window.__qaUnmount()');await next();await page.evaluate('window.__qaRender()');
    await wait(()=>page.evaluate(`document.querySelector('textarea')?.value==='草稿恢复'`),'draft restored after unmount');
    await fill('textarea','你是一位严谨、可靠的开发助手。\n\n工作方式\n• 先确认目标与已有上下文，再开始实施。\n• 优先给出具体、可验证的方案。\n• 将观察结果、推断和未验证假设明确区分。\n\n交付要求\n使用简体中文，保持回答简洁。完成后说明变更与验证结果。');
    for(const theme of ['light','dark']) for(const width of [1200,520,360]) {
      await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await next();
      await page.evaluate(`(()=>{document.querySelector('.pl-body').scrollTop=0;const editor=document.querySelector('.pl-editor-content');if(editor)editor.scrollTop=0;})()`);
      assert.equal(await page.evaluate('document.querySelector(".pl-body").scrollWidth<=document.querySelector(".pl-body").clientWidth'),true,`no horizontal overflow at ${width}px ${theme}`);
      const screenshot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-panel-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));
    }
    await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
    for(const [label,file] of [['规则库','rules'],['导入导出','transfer'],['设置','settings'],['组装快照','assembly']]) {
      await click(label);await next();
      const screenshot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-${file}-light.png`),Buffer.from(screenshot.data,'base64'));
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,version:pluginVersion,renderer:'Chromium + React 18 DOM',checks:['profile create/save/activate/copy/rename/delete with fallback','rule CRUD/disable/referenced delete protection','ordered references','legacy plus shared sections','409 draft protection','real JSON download and file import preview/commit','profile and rule draft remount recovery','1200/520/360px light and dark layouts','all five pages rendered'],artifacts:artifactDir}));
  } catch(error) {
    if(page){try{console.error('UI at failure: '+await page.evaluate('document.body.innerText'));}catch{}}
    throw error;
  } finally {
    if(rootCDP){try{await rootCDP.call('Browser.close');}catch{}rootCDP.socket.close();}
    page?.socket.close();child.kill();await new Promise(resolve=>server.close(resolve));
    if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;
    // Keep isolated fixtures and downloads beside the screenshot for inspection; paths are printed only for artifacts.
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

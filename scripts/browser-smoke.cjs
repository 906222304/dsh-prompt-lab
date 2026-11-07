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
  const {registerBackend}=await import(pathToFileURL(path.join(project,'lib/studio/model.js')).href);
  const {registerSessionReader}=await import(pathToFileURL(path.join(project,'lib/studio/sessions.js')).href);
  const withdrawSessions=registerSessionReader({list:async()=>[{id:'browser-feedback',title:'合成失败反馈',live:false}],preview:async id=>({sessionId:id,capturedThroughSeq:2,messages:[{seq:1,role:'user',text:'以后给出实际验证结果，不要只声称成功。',hash:'fixture-user-hash',truncated:false},{seq:2,role:'assistant',text:'未选中的助手内容',hash:'fixture-assistant-hash',truncated:false}]})});
  let studioMode='normal';const studioCalls=[];
  const withdrawStudio=registerBackend({defaultRoute:()=>({provider:'fixture',model:'browser-model'}),providers:()=>[{id:'fixture',name:'Browser fixture'}],models:async()=>[{id:'browser-model',name:'Browser model'}],
    async generate(options){
      studioCalls.push(options);
      if(options.purpose==='prompt-lab-examples')return {text:JSON.stringify({name:'浏览器 AI 样例',cases:[{id:'train',split:'train',input:'TRAIN_BROWSER',checks:[{type:'equals',value:'PASS'}]},{id:'held',split:'validation',input:'HELD_BROWSER',checks:[{type:'equals',value:'PASS'}]}]}),route:options.route};
      if(options.purpose==='prompt-lab-evaluation')return {text:options.system.includes('维护项目时')||options.system.includes('优化后保证完成')?'PASS':'FAIL',route:options.route,usage:{inputTokens:50,outputTokens:1}};
      if(options.purpose==='prompt-lab-optimization')return {text:JSON.stringify({prompt:'优化后保证完成：先定位代码，执行验证并列出证据。',rules:'简洁汇报',changes:['依据训练失败补全验证']}),route:options.route};
      if(options.purpose==='prompt-lab-grading')return {text:JSON.stringify({a:{score:1,reason:'符合标准'},b:{score:1,reason:'符合标准'}}),route:options.route};
      const input=JSON.parse(options.user).selectedData;
      if(studioMode==='slow')await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,3500);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal.reason);},{once:true});});
      if(studioMode==='invalid')return {text:'invalid response',route:options.route};
      const data={name:input.operation==='learn'?'会话反馈规则':input.operation==='curate'?'合并后的规则方案':input.operation==='extract'?'提取的团队规则':input.previousCandidate?'反馈改进方案':input.operation==='revise'?'精简后的维护方案':'AI 浏览器维护方案',
        prompt:['extract','learn'].includes(input.operation)?'':input.operation==='curate'?input.base.draft.prompt:input.previousCandidate?'先定位代码并验证，简洁汇报结果。':input.operation==='revise'?'先定位代码，修改后验证；简洁交付。':'维护项目时先定位问题，再实施修改并验证。',
        rules:['extract','learn'].includes(input.operation)?'':'结果区分已验证和未验证。',
        ruleSuggestions:[{action:'create',name:'AI 验证要求',text:'执行适用验证；无法执行时明确说明原因。',reason:'来自明确反馈',source:'改完验证',scope:'当前方案',conflict:'请与已有验证规则比较'}],
        changes:['整理可执行目标'],assumptions:[],questions:['项目实际验证命令待补充']};
      if(input.operation==='curate')data.ruleSuggestions=[{action:'create',name:'合并验证规范',text:'修改后验证并给出结果证据。',replacesRuleIds:input.sourceRules.slice(0,2).map(r=>r.id)}];
      return {text:JSON.stringify(data),route:options.route,usage:{inputTokens:120,outputTokens:180}};
    }});
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
      if(route==='/qa/studio-mode'){studioMode=new URL(req.url,'http://localhost').searchParams.get('mode');res.writeHead(200);return res.end('ok');}
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
      if(['新建配置','复制已保存配置','重命名','删除配置','导出此配置','配置名称','版本记录与恢复'].includes(label)) {
        await wait(()=>page.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='管理配置'&&!b.disabled)`),'profile mutation finished before menu');
        await page.evaluate(`(()=>{if(!document.querySelector('[aria-label="管理配置操作"]'))[...document.querySelectorAll('button')].find(b=>b.textContent==='管理配置')?.click()})()`);
      }
      if(['复制规则','删除规则','导出规则'].includes(label)) {
        await wait(()=>page.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='更多操作'&&!b.disabled)`),'rule mutation finished before menu');
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
      await wait(()=>page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;if(e.getClientRects().length)return [...e.options].some(o=>o.value===${JSON.stringify(value)});const name=${JSON.stringify(selector)}.includes('共享规则')?'data-rule-id':'data-profile-id';const b=document.querySelector('['+name+'="'+${JSON.stringify(value)}+'"]');return !!b&&!b.disabled&&b.getClientRects().length>0})()`),'selector ready '+selector);
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
    for(const [label,file] of [['规则库','rules'],['导入导出','transfer'],['设置','settings']]) {
      await click(label);await next();
      const screenshot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-${file}-light.png`),Buffer.from(screenshot.data,'base64'));
    }
    assert.equal(await page.evaluate('document.querySelector(".pl-advanced").open'),false,'advanced compatibility collapsed by default');
    for(const mode of ['redact','strip','off']) {
      await select('[aria-label="环境信息处理方式"]',mode);
      await wait(()=>state.snapshot().settings.contextFilter===mode,'environment setting '+mode);await next();
      assert.equal(state.snapshot().settings.identityBreak,false,'environment does not enable compatibility');
    }
    await page.evaluate('document.querySelector(".pl-advanced>summary").click()');await next();
    await page.evaluate('document.querySelector("[aria-label=渠道身份句兼容]").click()');
    await wait(()=>state.snapshot().settings.identityBreak===true,'compatibility enabled');await next();
    assert.equal(state.snapshot().settings.contextFilter,'off');
    assert.ok((await text()).includes('已开启'));
    await page.evaluate('document.querySelector(".pl-advanced>summary").click()');await next();
    assert.ok((await text()).includes('渠道身份句兼容 · 已开启'),'enabled state visible when advanced is closed');
    await page.evaluate('document.querySelector(".pl-advanced>summary").click()');await next();
    await page.evaluate('document.querySelector("[aria-label=渠道身份句兼容]").click()');
    await wait(()=>state.snapshot().settings.identityBreak===false,'compatibility disabled');await next();
    await page.evaluate('document.querySelector(".pl-inline-help>summary").click()');await next();
    for(const theme of ['light','dark']) for(const width of [1200,360]) {
      await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await next();
      for(const [file,selector] of [['settings-details','.pl-processing-head'],['compatibility','.pl-advanced']]) {
        await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`);await next();
        assert.equal(await page.evaluate('document.querySelector(".pl-body").scrollWidth<=document.querySelector(".pl-body").clientWidth'),true,'settings details no horizontal overflow');
        const screenshot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-${file}-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));
      }
    }
    await page.evaluate('document.querySelector(".pl-advanced>summary").click();document.querySelector(".pl-inline-help>summary").click()');await next();
    assert.equal(await page.evaluate('document.querySelector(".pl-diagnostics").open'),false,'diagnostics collapsed by default');
    assert.equal((await text()).includes('prompt-lab:custom'),false,'diagnostic body hidden');
    await page.evaluate('document.querySelector(".pl-diagnostics>summary").click()');await next();
    assert.ok((await text()).includes('可能来自其他会话'));
    assert.equal(await page.evaluate('document.querySelectorAll("[data-diagnostic-section]").length'),2);
    await page.evaluate('document.querySelector("[data-diagnostic-section]>summary").click()');await next();
    assert.ok((await text()).includes('prompt-lab:custom'));
    for(const theme of ['light','dark']) for(const width of [1200,360]) {
      await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await next();
      await page.evaluate('document.querySelector(".pl-diagnostics").scrollIntoView({block:"end"})');
      assert.equal(await page.evaluate('document.querySelector(".pl-body").scrollWidth<=document.querySelector(".pl-body").clientWidth'),true,'diagnostic no horizontal overflow');
      const screenshot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-diagnostics-${theme}-${width}.png`),Buffer.from(screenshot.data,'base64'));
    }
    await click('提示词与规则');await next();await click('设置');await next();
    assert.equal(await page.evaluate('document.querySelector(".pl-diagnostics").open'),false,'diagnostics collapsed on reentry');
    await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
    await click('提示词与规则');await next();
    const beforeAI=state.snapshot(),draftBeforeAI=await page.evaluate('document.querySelector("textarea.main").value');
    await click('AI 创作');await wait(()=>page.evaluate('!!document.querySelector("#pl-ai-goal")'),'AI drawer mounted');
    await fill('#pl-ai-goal','维护 Java 项目，中文，先定位再修改，改完验证。');await click('生成候选');
    await wait(async()=>(await text()).includes('AI 浏览器维护方案'),'generated candidate');
    assert.equal(state.snapshot().profiles.length,beforeAI.profiles.length);assert.equal(state.snapshot().ruleSets.length,beforeAI.ruleSets.length);
    assert.equal(await page.evaluate('document.querySelector("textarea.main").value'),draftBeforeAI);
    assert.equal(await page.evaluate('document.querySelector(".pl-studio-inputs").open'),false);
    await page.evaluate('document.querySelector(".pl-studio-inputs>summary").click()');
    assert.ok(await page.evaluate('document.querySelector(".pl-studio-inputs").innerText.includes("本次未带入当前草稿")'));
    await page.evaluate('document.querySelector(".pl-studio-inputs>summary").click();document.querySelector(".pl-studio-head button").focus()');
    await page.evaluate(`window.__qaLastControl=[...document.querySelector('.pl-studio').querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(n=>{if(n.disabled||!n.getClientRects().length)return false;for(let p=n.parentElement;p&&p!==document.querySelector('.pl-studio');p=p.parentElement)if(p.tagName==='DETAILS'&&!p.open&&n!==p.querySelector(':scope > summary'))return false;return true;}).at(-1);undefined`);
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(await page.evaluate('document.activeElement===window.__qaLastControl'),true,'dialog backwards focus wraps to the last visible control');
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`);
    assert.equal(await page.evaluate('document.activeElement.getAttribute("aria-label")'),'关闭 AI 创作','dialog forwards focus wraps');
    await page.evaluate('document.querySelector("#pl-ai-goal").focus()');
    await click('AI 生成测试样例');await wait(async()=>(await text()).includes('已保存：浏览器 AI 样例'),'AI suite saved');
    await ready('两版试跑');await click('两版试跑');await wait(async()=>(await text()).includes('文本试跑有提升'),'two-version evaluation');
    assert.equal(state.snapshot().profiles.length,beforeAI.profiles.length,'evaluation never adopts');
    for(const theme of ['light','dark'])for(const width of [1200,520,360]){
      await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await next();
      await page.evaluate(`document.querySelector('[aria-label="试跑结果"]').scrollIntoView({block:'start'})`);
      assert.equal(await page.evaluate('document.querySelector(".pl-studio-body").scrollWidth<=document.querySelector(".pl-studio-body").clientWidth'),true,'experiment results no horizontal overflow');
      const shot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-evaluation-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});await click('预算内优化');
    await wait(()=>page.evaluate(`!!document.querySelector('.pl-candidate h3')&&document.querySelector('[aria-label="试跑结果"]')?.textContent.includes('训练轮次 2')`),'bounded optimization candidate');
    assert.ok(studioCalls.filter(o=>o.purpose==='prompt-lab-optimization').every(o=>!o.user.includes('HELD_BROWSER')),'writer never receives held-out inputs');
    await page.evaluate('document.querySelector(".pl-studio-history>summary").click();[...document.querySelectorAll(".pl-history-item")].find(b=>b.textContent.startsWith("AI 浏览器维护方案")).click()');
    await wait(()=>page.evaluate('document.querySelector(".pl-candidate h3")?.textContent==="AI 浏览器维护方案"'),'restore creation candidate from history');
    for(const theme of ['light','dark'])for(const width of [1200,520,360]){
      await page.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});
      await page.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await next();
      await page.evaluate('document.querySelector(".pl-studio-body").scrollTop=0');
      assert.equal(await page.evaluate('document.querySelector(".pl-studio-body").scrollWidth<=document.querySelector(".pl-studio-body").clientWidth'),true,'AI drawer no horizontal overflow');
      const shot=await page.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(artifactDir,`${pluginVersion}-studio-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await page.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
    await click('查看原稿与候选差异');assert.equal(await page.evaluate('!!document.querySelector(".pl-diff")'),true);
    await fill('[aria-label="候选修改反馈"]','再精简一版，不带入未选择的旧草稿。');await click('按反馈再改一版');
    await wait(async()=>(await text()).includes('反馈改进方案'),'feedback candidate refinement');
    assert.equal(JSON.parse(studioCalls.at(-1).user).selectedData.base.draft,null,'refinement does not silently send unselected current draft');
    await click('另存为新方案');await wait(()=>state.snapshot().profiles.length===beforeAI.profiles.length+1,'AI atomic profile adoption');await next();
    assert.equal(state.snapshot().ruleSets.length,beforeAI.ruleSets.length+1);assert.equal(state.snapshot().selected,beforeAI.selected);
    assert.equal(await page.evaluate('document.querySelector("textarea.main").value'),draftBeforeAI);
    await click('打开新方案');await next();assert.equal(await page.evaluate('!!document.querySelector(".pl-studio")'),false);
    const aiProfile=state.snapshot().profiles.find(p=>p.name==='反馈改进方案');
    await click('按反馈优化');await fill('#pl-ai-goal','更短，保留验证要求。');await click('生成候选');
    await wait(async()=>(await text()).includes('精简后的维护方案'),'AI revise');
    await click('仅替换正文与附加规则');await next();
    assert.equal(state.snapshot().profiles.find(p=>p.id===aiProfile.id).prompt,aiProfile.prompt,'draft replacement has no disk write');
    assert.equal(await page.evaluate('document.querySelector("textarea.main").value'),'先定位代码，修改后验证；简洁交付。');
    await click('保存配置');await wait(()=>state.snapshot().profiles.find(p=>p.id===aiProfile.id).version===2,'save AI draft');await next();
    await click('规则库');await next();await click('AI 整理规则');await fill('#pl-ai-goal','从反馈提取长期规则，排除一次性任务。');await fill('[aria-label="AI 所选材料"]','修改之后没有验证就宣称完成了；以后要说明验证情况。');
    await click('生成候选');await wait(async()=>(await text()).includes('提取的团队规则'),'AI rule extraction');
    const countBeforeExtract=state.snapshot().profiles.length,rulesBeforeExtract=state.snapshot().ruleSets.length;
    await click('保存所选规则');await wait(()=>state.snapshot().ruleSets.length===rulesBeforeExtract+1,'adopt extracted rule');assert.equal(state.snapshot().profiles.length,countBeforeExtract);
    await click('关闭 AI 创作');await click('提示词与规则');await next();
    await page.evaluate(`fetch('/qa/studio-mode?mode=slow')`);await click('按反馈优化');await fill('#pl-ai-goal','生成期间继续编辑的保护验收');await click('生成候选');
    await wait(()=>page.evaluate('document.querySelector(".pl-studio-status")?.textContent.includes("运行中")'),'slow job running');
    await click('关闭 AI 创作');await fill('textarea.main','生成期间继续保留的手工草稿');await click('AI 创作');
    await wait(async()=>(await text()).includes('当前配置或草稿已变化'),'late candidate stale marker');
    assert.equal(await page.evaluate('document.querySelector("textarea.main").value'),'生成期间继续保留的手工草稿');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='仅替换正文与附加规则').disabled`),true);
    await fill('#pl-ai-goal','取消任务验收');await click('生成候选');await wait(()=>page.evaluate('document.querySelector(".pl-studio-status")?.textContent.includes("运行中")'),'cancellable job running');
    await click('关闭 AI 创作');await click('AI 创作');await wait(()=>page.evaluate('document.querySelector(".pl-studio-status")?.textContent.includes("运行中")'),'active job restored');
    await click('取消生成');await wait(()=>page.evaluate('document.querySelector(".pl-studio-status")?.textContent.includes("已取消")'),'AI cancelled');
    await page.evaluate(`fetch('/qa/studio-mode?mode=invalid')`);await fill('#pl-ai-goal','错误输出保留原稿');await click('生成候选');
    await wait(()=>page.evaluate('document.querySelector(".pl-studio-status")?.textContent.includes("执行失败")'),'invalid output failed after bounded repair');
    assert.equal(await page.evaluate('document.querySelector("textarea.main").value'),'生成期间继续保留的手工草稿');
    await page.evaluate(`fetch('/qa/studio-mode?mode=normal')`);
    await select('#pl-ai-operation','learn');await fill('#pl-ai-goal','从明确用户纠正提炼长期规则');
    await page.evaluate('[...document.querySelectorAll("summary")].find(s=>s.textContent==="从会话中选择反馈").click()');
    await click('读取会话列表');await select('[aria-label="反馈来源会话"]','browser-feedback');
    await wait(()=>page.evaluate(`!!document.querySelector('[aria-label="选择反馈消息 1"]')`),'session messages preview');
    await page.evaluate(`document.querySelector('[aria-label="选择反馈消息 1"]').click()`);await click('生成候选');
    await wait(()=>page.evaluate('document.querySelector(".pl-candidate h3")?.textContent==="会话反馈规则"'),'selected-session learning');
    const learned=JSON.parse(studioCalls.at(-1).user).selectedData.selectedSession;assert.equal(learned.events.length,1);assert.equal(learned.events[0].seq,1);assert.ok(!JSON.stringify(learned).includes('未选中的助手内容'));
    await click('关闭 AI 创作');await click('规则库');await click('去重与修剪');await click('选择未引用规则');
    await page.evaluate(`(()=>{const boxes=[...document.querySelectorAll('[aria-label^="维护规则 "]')];if(boxes.filter(b=>b.checked).length<2)boxes.find(b=>!b.checked)?.click()})()`);
    await ready('AI 合并所选规则');await click('AI 合并所选规则');await click('生成候选');
    await wait(()=>page.evaluate('document.querySelector(".pl-candidate h3")?.textContent==="合并后的规则方案"'),'AI curation');
    assert.ok((await text()).includes('仅在新方案中替换引用'));await click('关闭 AI 创作');
    await click('提示词与规则');await click('版本记录与恢复');
    await wait(()=>page.evaluate(`document.querySelector('[aria-label="选择资产版本"]').options.length>1`),'version records loaded');
    const versions=await page.evaluate(`[...document.querySelector('[aria-label="选择资产版本"]').options].map(o=>o.value).filter(Boolean)`);assert.ok(versions.length);
    await select('[aria-label="选择资产版本"]',versions[0]);await next();const beforeRestore=state.snapshot();
    await click('另存恢复方案');await wait(()=>state.snapshot().profiles.length===beforeRestore.profiles.length+1,'version restore copy');assert.equal(state.snapshot().selected,beforeRestore.selected);
    await click('关闭版本记录与恢复');await click('规则库');await click('去重与修剪');await click('选择未引用规则');
    const ruleCount=state.snapshot().ruleSets.length;await click('删除未引用规则');await wait(()=>state.snapshot().ruleSets.length<ruleCount,'unused rule pruning');await click('关闭规则去重与修剪');
    await click('提示词与规则');withdrawStudio();await click('AI 创作');
    await wait(async()=>(await text()).includes('AI 服务尚未就绪'),'AI offline state');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='生成候选').disabled`),true);
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await next();
    assert.equal(await page.evaluate('!!document.querySelector(".pl-studio")'),false,'Escape closes the dialog');assert.equal(state.snapshot().selected,beforeAI.selected);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,version:pluginVersion,renderer:'Chromium + React 18 DOM',checks:['existing profile/rule CRUD, conflict, import/export and draft recovery','responsive light/dark management and settings','AI generation, diff and atomic unactivated adoption','AI revise into draft then explicit save','AI rule extraction and selection adoption','AI examples, editable suite, two-version evaluation and bounded optimization','writer excludes held-out samples','explicit selected-session feedback provenance','rule curation and unused-rule pruning','full asset-version restore without activation','late candidate never overwrites changed draft','close/reopen active AI task and cancellation','invalid output bounded repair and service unavailable','1200/520/360px light and dark AI drawer/evaluation'],aiFixtureCalls:studioCalls.length,artifacts:artifactDir}));
  } catch(error) {
    if(page){try{console.error('UI at failure: '+await page.evaluate('document.body.innerText'));}catch{}}
    throw error;
  } finally {
    withdrawStudio();withdrawSessions();
    if(rootCDP){try{await rootCDP.call('Browser.close');}catch{}rootCDP.socket.close();}
    page?.socket.close();child.kill();await new Promise(resolve=>server.close(resolve));
    if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;
    // Keep isolated fixtures and downloads beside the screenshot for inspection; paths are printed only for artifacts.
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

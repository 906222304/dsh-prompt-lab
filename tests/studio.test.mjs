import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Studio } from '../lib/studio/jobs.js';
import { hostBackend, registerBackend } from '../lib/studio/model.js';
import { prepareInput, parseCandidate, draftKey } from '../lib/studio/contracts.js';
import { initialize, resetForTests, snapshot, updateProfile, updateRule, applyStudioCandidate } from '../lib/state.js';
import { handler } from '../lib/ui.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-studio-')), previousHome=process.env.DSH_HOME;
let directory, home, backend, engine, calls;
const route={provider:'test',model:'fixture'};
const candidate=(extra={})=>({name:'AI 维护方案',prompt:'先定位相关代码，再修改并验证。',rules:'结果区分已验证和未验证。',
  ruleSuggestions:[{action:'create',name:'验证要求',text:'修改后执行适用验证；无法执行时说明原因。',reason:'用户明确要求',source:'修改后验证',scope:'当前方案',conflict:''}],
  changes:['整理目标'],assumptions:[],questions:['项目测试命令待补充'],...extra});
const request=(extra={})=>({requestId:'test-'+Math.random().toString(36).slice(2),operation:'generate',profileId:'default',
  profileVersion:snapshot().profiles[0].version,goal:'维护项目，改完验证',includeDraft:false,...extra});
async function done(id, studio=engine) {
  for(let i=0;i<100;i++){const j=studio.get(id);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,5));}
  throw new Error('fixture did not finish');
}
function createEngine(options={}) { return new Studio({directory,snapshot,apply:applyStudioCandidate,backend:()=>backend,...options}); }
const adopt=(id,extra={})=>engine.adopt({id,mode:'profile',indices:[0],expectedStoreVersion:snapshot().storage.storeVersion,...extra});
beforeEach(()=>{
  home=fs.mkdtempSync(path.join(root,'case-'));process.env.DSH_HOME=home;resetForTests();initialize({prompt:'原配置正文'});
  directory=path.join(home,'prompt-lab');calls=[];
  backend={defaultRoute:()=>route,providers:()=>[{id:'test',name:'Fixture'}],models:async()=>[{id:'fixture',name:'Fixture'}],
    async generate(options){calls.push(options);return {text:JSON.stringify(candidate()),route,usage:{inputTokens:10,outputTokens:20}};}};
  engine=createEngine();
});
after(()=>{
  engine?.dispose();if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('prompt-lab-studio-'));
  fs.rmSync(root,{recursive:true,force:true});
});

test('AI generation is isolated; adoption atomically saves a new unactivated profile with rules',async()=>{
  const before=snapshot(),job=await done(engine.start(request()).id);
  assert.equal(job.status,'succeeded');assert.equal(job.candidate.verified,false);assert.equal(calls.length,1);
  assert.equal(snapshot().revision,before.revision);assert.deepEqual(snapshot().profiles,before.profiles);assert.equal(fs.existsSync(path.join(directory,'profiles.json')),false);
  const saved=adopt(job.id);assert.equal(saved.profiles.length,before.profiles.length+1);assert.equal(saved.selected,before.selected);
  assert.equal(saved.ruleSets.length,1);assert.equal(saved.profiles.find(p=>p.id===saved.editedId).ruleIds[0],saved.ruleSets[0].id);
  const disk=JSON.parse(fs.readFileSync(path.join(directory,'profiles.json'),'utf8'));assert.equal(disk.schemaVersion,2);assert.equal(disk.profiles.length,saved.profiles.length);
  const again=adopt(job.id);assert.equal(again.alreadyApplied,true);assert.equal(again.profiles.length,saved.profiles.length);
});

test('copying a referenced rule changes only the new profile and keeps source order',async()=>{
  const a=updateRule({action:'rule.create',name:'已有甲',text:'原甲'}).editedRuleId;
  const b=updateRule({action:'rule.create',name:'已有乙',text:'原乙'}).editedRuleId;
  let p=snapshot().profiles[0];updateProfile({action:'save',...p,ruleIds:[a,b],expectedVersion:p.version});p=snapshot().profiles[0];
  const original=snapshot();backend.generate=async options=>({text:JSON.stringify(candidate({ruleSuggestions:[
    {action:'copy',existingRuleId:a,name:'甲改进',text:'新甲'}, {action:'reuse',existingRuleId:b}]})),route});
  const job=await done(engine.start(request({includeDraft:true,draft:p})).id);assert.equal(job.status,'succeeded');
  const saved=adopt(job.id,{indices:[0,1]}),created=saved.profiles.find(p=>p.id===saved.editedId);
  assert.equal(created.ruleIds[1],b);assert.notEqual(created.ruleIds[0],a);
  assert.equal(saved.ruleSets.find(r=>r.id===a).text,'原甲');assert.deepEqual(saved.profiles.find(p=>p.id==='default'),original.profiles[0]);
});

test('draft snapshots preserve whitespace and unknown rule references are rejected',()=>{
  const p=snapshot().profiles[0],draft={...p,prompt:'  保留空白\n',rules:'\n'};
  const prepared=prepareInput(request({operation:'revise',includeDraft:true,draft}),snapshot());
  assert.equal(prepared.base.draftKey,draftKey(draft));
  assert.throws(()=>prepareInput(request({includeDraft:true,draft:{...draft,ruleIds:['missing']}}),snapshot()),/引用规则/);
  assert.throws(()=>parseCandidate(JSON.stringify(candidate({ruleSuggestions:[{action:'reuse',existingRuleId:'foreign'}]})),prepared),/未选定/);
});

test('request deduplication dispatches once and rejects reused keys for different input',async()=>{
  const input=request(),first=engine.start(input),second=engine.start(input);assert.equal(first.id,second.id);
  await done(first.id);assert.equal(calls.length,1);
  assert.throws(()=>engine.start({...input,goal:'different'}),/不同内容/);
});

test('JSON repair is limited to one call and unknown usage stays unknown',async()=>{
  backend.generate=async options=>{calls.push(options);return calls.length===1?{text:'bad JSON',route}:{text:JSON.stringify(candidate()),route,usage:{inputTokens:3,outputTokens:7}};};
  const job=await done(engine.start(request()).id);assert.equal(job.status,'succeeded');assert.equal(job.usage.calls,2);
  assert.equal(job.usage.inputTokens,null);assert.ok(calls[1].user.includes('repair'));
  backend.generate=async options=>{calls.push(options);return {text:'still bad',route};};
  const failed=await done(engine.start(request()).id);assert.equal(failed.status,'failed');assert.equal(failed.usage.calls,2);assert.equal(failed.candidate,null);
});

test('cancelled requests discard late results without touching profiles',async()=>{
  let release;backend.generate=options=>{calls.push(options);return new Promise(resolve=>{release=resolve;});};
  const before=snapshot(),started=engine.start(request());await new Promise(setImmediate);
  engine.cancel(started.id);release({text:JSON.stringify(candidate()),route});await new Promise(setImmediate);
  const job=await done(started.id);assert.equal(job.status,'cancelled');assert.equal(job.candidate,null);assert.equal(calls.length,1);
  assert.deepEqual(snapshot().profiles,before.profiles);assert.equal(snapshot().selected,before.selected);
});

test('deadlines terminate even a provider that ignores cancellation',async()=>{
  let release;backend.generate=()=>new Promise(resolve=>{release=resolve;});engine=createEngine({limits:{timeoutMs:15}});
  const job=await done(engine.start(request()).id);assert.equal(job.status,'timed_out');assert.equal(job.candidate,null);
  release({text:JSON.stringify(candidate()),route});
});

test('a second concurrent task is rejected and model absence leaves assets available',async()=>{
  let release;backend.generate=()=>new Promise(resolve=>{release=resolve;});const job=engine.start(request());
  assert.throws(()=>engine.start(request()),/正在运行/);await new Promise(setImmediate);engine.cancel(job.id);release({text:'{}',route});
  backend=null;assert.equal((await engine.capabilities()).available,false);assert.throws(()=>engine.start(request()),/未就绪/);
  assert.equal(snapshot().profiles.length,1);
});

test('adoption rejects changed profiles and referenced rules and retains the candidate',async()=>{
  let job=await done(engine.start(request()).id);const p=snapshot().profiles[0];updateProfile({action:'save',...p,prompt:'另一窗口',expectedVersion:p.version});
  assert.throws(()=>adopt(job.id),/配置已变化/);assert.equal(engine.get(job.id).status,'succeeded');
  const id=updateRule({action:'rule.create',name:'引用',text:'原文'}).editedRuleId;
  job=await done(engine.start(request({sourceRuleIds:[id]})).id);let r=snapshot().ruleSets[0];updateRule({action:'rule.save',id,text:'修改',expectedVersion:r.version});
  assert.throws(()=>adopt(job.id),/共享规则已变化/);assert.equal(snapshot().profiles.length,1);
});

test('failed atomic profile write creates no orphan rules and can be retried once',async()=>{
  const job=await done(engine.start(request()).id),before=snapshot(),rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===path.join(directory,'profiles.json'))throw Object.assign(new Error('fixture write denied'),{code:'EACCES'});return rename(from,to);};
  try{assert.throws(()=>adopt(job.id),/write denied/);}finally{fs.renameSync=rename;}
  assert.deepEqual(snapshot().profiles,before.profiles);assert.deepEqual(snapshot().ruleSets,before.ruleSets);
  const saved=adopt(job.id);assert.equal(saved.profiles.length,2);assert.equal(saved.ruleSets.length,1);
});

test('a committed asset survives receipt-write failure and recovery does not duplicate it',async()=>{
  const job=await done(engine.start(request()).id),persist=engine.persist.bind(engine);
  engine.persist=value=>{if(value.application?.status==='committed')throw new Error('fixture receipt failure');persist(value);};
  const saved=adopt(job.id);assert.ok(saved.studioWarning);assert.equal(saved.profiles.length,2);
  engine=createEngine();const again=adopt(job.id);assert.equal(again.alreadyApplied,true);assert.equal(again.profiles.length,2);assert.equal(again.ruleSets.length,1);
});

test('rule extraction adopts only selected rules without changing profiles or activation',async()=>{
  backend.generate=async()=>({text:JSON.stringify(candidate({prompt:'',rules:'',ruleSuggestions:[{action:'create',name:'提取规则',text:'明确未验证结果'}]})),route});
  const before=snapshot(),job=await done(engine.start(request({operation:'extract',materials:'未验证的结论要说明'})).id);
  const saved=adopt(job.id,{mode:'rules'});assert.deepEqual(saved.profiles,before.profiles);assert.equal(saved.selected,before.selected);assert.equal(saved.ruleSets.length,1);
});

test('profile/rule limits reject the entire candidate without partial writes',async()=>{
  const job=await done(engine.start(request()).id);
  while(snapshot().profiles.length<20)updateProfile({action:'create',name:'额外配置'});
  assert.throws(()=>adopt(job.id),/20 套/);assert.equal(snapshot().ruleSets.length,0);
  while(snapshot().ruleSets.length<50)updateRule({action:'rule.create',name:'额外规则',text:'规则'});
  assert.throws(()=>adopt(job.id,{mode:'rules'}),/50/);assert.equal(snapshot().ruleSets.length,50);
});

test('restart recovers unfinished tasks as interrupted without redispatch',async()=>{
  const finished=await done(engine.start(request()).id);const file=engine.jobFile(finished.id),record=JSON.parse(fs.readFileSync(file,'utf8'));
  record.status='running';record.input.operation='optimize';record.result={kind:'optimize',complete:true,accepted:true,retained:'candidate'};fs.writeFileSync(file,JSON.stringify(record));
  const before=calls.length;engine=createEngine();const recovered=engine.get(finished.id);assert.equal(recovered.status,'interrupted');assert.equal(calls.length,before);
  assert.equal(recovered.candidate,null);assert.equal(recovered.result.complete,false);assert.equal(recovered.result.accepted,false);assert.equal(recovered.result.retained,'baseline');
});

test('bounded history and clearing remove only owned job records and preserve assets',async()=>{
  engine=createEngine({limits:{history:2}});
  for(let i=0;i<3;i++)await done(engine.start(request()).id);
  assert.equal(engine.history().length,2);fs.writeFileSync(path.join(engine.root,'jobs','unrelated.txt'),'keep');
  engine.clear();assert.equal(engine.history().length,0);assert.equal(fs.readFileSync(path.join(engine.root,'jobs','unrelated.txt'),'utf8'),'keep');assert.equal(snapshot().profiles.length,1);
});

test('corrupt studio settings cannot be overwritten or disable profile management',()=>{
  fs.mkdirSync(path.join(directory,'studio'),{recursive:true});fs.writeFileSync(path.join(directory,'studio','settings.json'),'{broken');
  engine=createEngine();assert.throws(()=>engine.start(request()),/阻止覆盖/);assert.equal(fs.readFileSync(engine.settingsFile(),'utf8'),'{broken');
  const saved=updateProfile({action:'create',name:'仍能管理'});assert.equal(saved.profiles.length,2);
});

test('host model adapter uses explicit messages and zero tools, assembles final blocks once',async()=>{
  let sent,prepare;
  const model=hostBackend({agentDefaultModel:{currentSelection:()=>route},llm:{listProviders:()=>[{id:'test',name:'Fixture',apiKey:'never return'}],listModels:async()=>[{id:'fixture',name:'Fixture',secret:'never return'}],
    async prepareCall(config,signal){prepare=config;return {config,async *stream(options){sent=options;yield {type:'text-delta',index:0,text:'partial'};yield {type:'block-end',index:0,block:{type:'text',text:'complete'}};yield {type:'usage',usage:{inputTokens:2,outputTokens:3}};yield {type:'finish',reason:{kind:'stop'}};}};}}});
  const result=await model.generate({route,system:'専用',user:'selected data',maxTokens:300,signal:new AbortController().signal});
  assert.equal(result.text,'complete');assert.deepEqual(sent.tools,[]);assert.equal(sent.messages.length,1);assert.equal(sent.messages[0].role,'user');assert.ok(sent.messages[0].id);assert.equal(prepare.maxTokens,300);
  assert.deepEqual(model.providers(),[{id:'test',name:'Fixture'}]);assert.deepEqual(await model.models('test'),[{id:'fixture',name:'Fixture'}]);assert.equal(result.usage.inputTokens,2);
});

test('host model adapter rejects tool calls and truncated or failed streams',async()=>{
  for(const chunks of [[{type:'finish',reason:{kind:'max-tokens'}}],[{type:'tool-call-delta',index:0,name:'exec'}],[{type:'finish',reason:{kind:'error'}}],[]]){
    const model=hostBackend({llm:{async prepareCall(config){return {config,async *stream(){yield*chunks;}};}}});
    await assert.rejects(model.generate({route,system:'test',user:'test',maxTokens:20,signal:new AbortController().signal}));
  }
});

test('studio HTTP keeps the UI origin gate and returns service-unavailable without changing data',async()=>{
  async function invoke(headers){
    const req=Readable.from([]);req.method='GET';req.url='/prompt-lab/api/studio';req.headers=headers;req.socket={remoteAddress:'127.0.0.1'};
    let code,body;await handler(req,{writeHead(value){code=value;},end(value){body=JSON.parse(value);}});return {code,body};
  }
  assert.equal((await invoke({host:'127.0.0.1'})).code,403);
  assert.equal((await invoke({host:'127.0.0.1','x-prompt-lab-ui':'1',origin:'https://foreign.invalid'})).code,403);
  const response=await invoke({host:'127.0.0.1','x-prompt-lab-ui':'1'});assert.equal(response.code,200);assert.equal(response.body.available,false);assert.equal(snapshot().profiles.length,1);
});

test('identical suggested rules deduplicate and reuse selected existing rules',()=>{
  const id=updateRule({action:'rule.create',name:'现有验证',text:'执行  适用验证',enabled:false}).editedRuleId;
  const input=prepareInput(request({sourceRuleIds:[id]}),snapshot());
  const value=parseCandidate(JSON.stringify(candidate({ruleSuggestions:[{action:'create',name:'重复',text:'执行 适用验证'},{action:'create',name:'重复二',text:'执行 适用验证'}]})),input);
  assert.equal(value.ruleSuggestions.length,1);assert.equal(value.ruleSuggestions[0].action,'reuse');assert.equal(value.ruleSuggestions[0].existingRuleId,id);assert.equal(value.ruleSuggestions[0].existingEnabled,false);
  assert.throws(()=>parseCandidate(JSON.stringify(candidate({questions:['一','二','三']})),input),/最多两项/);
});

test('cleared cancelled jobs cannot reappear when a late provider rejects',async()=>{
  let release;backend.generate=()=>new Promise(resolve=>{release=resolve;});const job=engine.start(request());await new Promise(setImmediate);
  engine.cancel(job.id);engine.remove(job.id);release({text:JSON.stringify(candidate()),route});await new Promise(setImmediate);
  assert.equal(fs.existsSync(engine.jobFile(job.id)),false);assert.equal(engine.history().length,0);assert.throws(()=>engine.get(job.id),/不存在/);
});

test('an explicit model remains usable when the host default is not configured',async()=>{
  backend.defaultRoute=()=>({provider:'',model:''});const cap=await engine.capabilities();assert.equal(cap.available,true);assert.equal(cap.route.model,'fixture');
  const job=await done(engine.start(request({route})).id);assert.equal(job.status,'succeeded');
});

test('refining a previous candidate does not require or silently include an unselected draft',()=>{
  const input=prepareInput(request({operation:'revise',includeDraft:false,previousCandidate:candidate()}),snapshot());
  assert.equal(input.base.draft,null);assert.equal(input.base.draftKey,null);assert.equal(input.previousCandidate.prompt,candidate().prompt);
  assert.ok(!JSON.stringify(input).includes('原配置正文'));
});

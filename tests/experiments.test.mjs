import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Studio} from '../lib/studio/jobs.js';
import {initialize,resetForTests,snapshot,applyStudioCandidate,updateRule,updateProfile} from '../lib/state.js';
import {compileVariant,frozenCandidate} from '../lib/studio/experiments.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-experiments-')),originalHome=process.env.DSH_HOME;
const route={provider:'fixture',model:'target',reasoningEffort:'low'};
let engine,calls,generate;
const content=(prompt='seed')=>({name:'候选',prompt,rules:'',ruleSuggestions:[],changes:[],assumptions:[],questions:[]});
const request=extra=>({requestId:'request-'+Math.random().toString(36).slice(2),operation:'generate',goal:'生成',profileId:'default',profileVersion:snapshot().profiles[0].version,...extra});
const wait=async id=>{for(let n=0;n<300;n++){const j=engine.get(id);if(!['queued','running'].includes(j.status))return j;await new Promise(r=>setTimeout(r,3));}throw new Error('fixture timeout');};
beforeEach(()=>{
  process.env.DSH_HOME=fs.mkdtempSync(path.join(root,'case-'));resetForTests();initialize({prompt:'baseline'});calls=[];
  generate=async o=>({text:o.purpose==='prompt-lab-studio'?JSON.stringify(content()):o.system.includes('seed')?'PASS':'FAIL',route,usage:{inputTokens:10,outputTokens:2}});
  const backend={defaultRoute:()=>route,providers:()=>[{id:'fixture'}],models:async()=>[{id:'target'}],generate:async o=>{calls.push(o);return generate(o);}};
  engine=new Studio({directory:path.join(process.env.DSH_HOME,'prompt-lab'),snapshot,apply:applyStudioCandidate,backend:()=>backend});
});
after(()=>{engine.dispose();if(originalHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=originalHome;
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('prompt-lab-experiments-'));fs.rmSync(root,{recursive:true,force:true});});
async function setup(extra={}){
  const seed=await wait(engine.start(request()).id);
  const suite=engine.suites.save({name:'固定案例',cases:[{id:'train',split:'train',input:'TRAIN_ONLY',checks:[{type:'equals',value:'PASS'}]},
    {id:'held',split:'validation',input:'HELD_OUT_SECRET',checks:[{type:'equals',value:'PASS'}]}]}).suite;
  return {operation:'evaluate',candidateJobId:seed.id,indices:[],suiteId:suite.id,suiteRevision:suite.revision,draft:snapshot().profiles[0],...extra};
}
test('evaluation freezes inputs, compares raw results and never changes or activates profiles',async()=>{
  const input=await setup(),before=snapshot();const job=await wait(engine.start(request(input)).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.accepted,true);assert.equal(job.result.complete,true);
  assert.equal(job.result.comparison.candidate[0].output,'PASS');assert.equal(job.result.comparison.baseline[0].output,'FAIL');
  assert.equal(job.usage.calls,4);assert.equal(job.usage.reservedOutputTokens,4096);
  assert.deepEqual(snapshot().profiles,before.profiles);assert.equal(snapshot().selected,before.selected);
  assert.deepEqual(job.input.suite.cases.map(c=>c.input),['TRAIN_ONLY','HELD_OUT_SECRET']);
  assert.ok(job.calls.every(c=>c.maxTokens===1024&&c.route.reasoningEffort==='low'));
  assert.throws(()=>engine.adopt({id:job.id}),/没有可采用候选/);
});
test('optimization withholds validation from the writer and only exposes a better final candidate',async()=>{
  const input=await setup({operation:'optimize',budget:{maxRounds:1}});
  generate=async o=>({text:o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'improved',rules:'',changes:['训练修正']}):o.system.includes('improved')?'PASS':'FAIL',route});
  const before=snapshot(),job=await wait(engine.start(request(input)).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.accepted,true);assert.equal(job.candidate.content.prompt,'improved');
  const writer=calls.find(o=>o.purpose==='prompt-lab-optimization');assert.ok(writer.user.includes('TRAIN_ONLY'));assert.ok(!writer.user.includes('HELD_OUT_SECRET'));
  assert.equal(calls.filter(o=>o.user==='HELD_OUT_SECRET').length,2);
  assert.deepEqual(snapshot().profiles,before.profiles);
  const saved=engine.adopt({id:job.id,mode:'profile',indices:[],expectedStoreVersion:snapshot().storage.storeVersion});
  assert.equal(saved.profiles.find(p=>p.id===saved.editedId).prompt,'improved');assert.equal(saved.selected,before.selected);
});
test('no improvement retains the baseline and cannot be adopted as an optimized candidate',async()=>{
  const input=await setup({operation:'optimize',budget:{maxRounds:1}});
  generate=async o=>({text:o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'longer',rules:'',changes:[]}):'PASS',route});
  const job=await wait(engine.start(request(input)).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.retained,'baseline');assert.equal(job.result.accepted,false);assert.equal(job.candidate,null);
});
test('budget exhaustion stops dispatch and preserves partial evidence without a candidate',async()=>{
  const input=await setup({operation:'optimize',budget:{maxCalls:4,maxRounds:1}});
  generate=async o=>({text:o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'improved',rules:'',changes:[]}):o.system.includes('improved')?'PASS':'FAIL',route});
  const job=await wait(engine.start(request(input)).id);
  assert.equal(job.status,'budget_exhausted');assert.equal(job.usage.calls,4);assert.equal(job.candidate,null);assert.equal(job.result.complete,false);
  assert.ok(!calls.some(o=>o.user==='HELD_OUT_SECRET'));
});
test('output reservation blocks a call before spending beyond the configured total',async()=>{
  const input=await setup({budget:{maxOutputTotal:1000}});const before=calls.length;
  const job=await wait(engine.start(request(input)).id);
  assert.equal(job.status,'budget_exhausted');assert.equal(job.usage.calls,0);assert.equal(calls.length,before);
});
test('failed target output cannot become a passing score',async()=>{
  const input=await setup();generate=async()=>{throw new Error('provider offline');};
  const job=await wait(engine.start(request(input)).id);
  assert.equal(job.result.complete,false);assert.equal(job.result.accepted,false);assert.equal(job.result.comparison.summary.candidate.errors,2);
  assert.ok(job.result.comparison.candidate.every(r=>!r.pass&&r.score===0));
});
test('judge failure invalidates both scores rather than treating an unchecked answer as passing',async()=>{
  const input=await setup();const suite=engine.suites.get(input.suiteId);suite.cases[0].rubric='回答应符合参考';
  const updated=engine.suites.save({...suite,expectedRevision:suite.revision}).suite;
  generate=async o=>({text:o.purpose==='prompt-lab-grading'?'invalid judge JSON':'PASS',route});
  const job=await wait(engine.start(request({...input,suiteRevision:updated.revision})).id);
  assert.equal(job.result.complete,false);assert.match(job.result.comparison.candidate[0].error,/评分失败/);assert.equal(job.result.comparison.candidate[0].pass,false);
});
test('model parameter drift aborts comparison and leaves no adoptable candidate',async()=>{
  const input=await setup();generate=async()=>({text:'PASS',route:{...route,reasoningEffort:'high'}});
  const job=await wait(engine.start(request(input)).id);assert.equal(job.status,'failed');assert.equal(job.usage.calls,1);assert.equal(job.candidate,null);
});
test('cancellation stops a hanging evaluator even if the provider resolves late',async()=>{
  const input=await setup();let release;generate=()=>new Promise(resolve=>{release=resolve;});
  const started=engine.start(request(input));await new Promise(setImmediate);engine.cancel(started.id);
  const job=await wait(started.id);assert.equal(job.status,'cancelled');release({text:'PASS',route});await new Promise(setImmediate);
  assert.equal(engine.get(started.id).candidate,null);assert.equal(engine.get(started.id).usage.calls,1);
});
test('suite revisions conflict before dispatch and later edits do not alter an active frozen suite',async()=>{
  const input=await setup();const old=engine.suites.get(input.suiteId);
  const updated=engine.suites.save({...old,name:'新名字',expectedRevision:old.revision}).suite;
  assert.throws(()=>engine.start(request(input)),/测试集版本已变化/);
  let release;generate=()=>new Promise(resolve=>{release=resolve;});
  const started=engine.start(request({...input,suiteRevision:updated.revision}));await new Promise(setImmediate);
  engine.suites.save({...updated,name:'第三版',expectedRevision:updated.revision});
  assert.equal(engine.get(started.id).input.suite.name,'新名字');engine.cancel(started.id);release({text:'PASS',route});
});
test('AI sample generation saves an editable suite with explicit origin and train/validation splits',async()=>{
  generate=async()=>({text:JSON.stringify({name:'AI 草稿',cases:[{id:'a',split:'train',input:'a',checks:[{type:'contains',value:'ok'}]},{id:'b',split:'validation',input:'b',checks:[{type:'contains',value:'ok'}]}]}),route});
  const job=await wait(engine.start(request({operation:'examples',draft:snapshot().profiles[0]})).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.suite.origin,'ai');assert.equal(engine.suites.list().suites.length,1);assert.equal(job.candidate,null);
});
test('curation freezes and adopts the same ordered merged rules while preserving existing shared rules',async()=>{
  const ids=['甲','乙','丙'].map(name=>updateRule({action:'create',name,text:name}).editedRuleId);const p=snapshot().profiles[0];
  updateProfile({action:'save',...p,ruleIds:ids,expectedVersion:p.version});
  generate=async()=>({text:JSON.stringify({...content(),ruleSuggestions:[{action:'create',name:'合并',text:'合并甲乙',replacesRuleIds:ids.slice(0,2)}]}),route});
  const job=await wait(engine.start(request({operation:'curate',sourceRuleIds:ids,includeDraft:true,draft:snapshot().profiles[0]})).id);
  const frozen=frozenCandidate(job,[0]);assert.deepEqual(frozen.variant.ruleSets.map(r=>r.name),['合并','丙']);
  const saved=engine.adopt({id:job.id,mode:'profile',indices:[0],expectedStoreVersion:snapshot().storage.storeVersion});
  const profile=saved.profiles.find(p=>p.id===saved.editedId);const rules=profile.ruleIds.map(id=>saved.ruleSets.find(r=>r.id===id));
  assert.equal(compileVariant({...profile,ruleSets:rules}),frozen.variant.text);assert.equal(saved.ruleSets.find(r=>r.id===ids[0]).text,'甲');
});

test('a training improvement is rejected when independent validation regresses',async()=>{
  const input=await setup({operation:'optimize',budget:{maxRounds:1}});
  generate=async o=>({text:o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'improved',rules:'',changes:[]}):o.user==='HELD_OUT_SECRET'?(o.system==='baseline'?'PASS':'FAIL'):o.system.includes('improved')?'PASS':'FAIL',route});
  const job=await wait(engine.start(request(input)).id);
  assert.equal(job.result.training.summary.candidate.passed,1);assert.equal(job.result.validation.summary.baseline.passed,1);
  assert.equal(job.result.validation.summary.candidate.passed,0);assert.equal(job.result.accepted,false);assert.equal(job.result.retained,'baseline');assert.equal(job.candidate,null);
});

test('optimized adoption cannot remove or reorder the rule selection used during evaluation',async()=>{
  generate=async()=>({text:JSON.stringify({...content(),ruleSuggestions:[{action:'create',name:'fixed selection',text:'retain this rule'}]}),route});
  const input=await setup({operation:'optimize',indices:[0],budget:{maxRounds:1}});
  generate=async o=>({text:o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'IMPROVED_FIXTURE',rules:'',changes:[]}):o.system.includes('IMPROVED_FIXTURE')?'PASS':'FAIL',route});
  const job=await wait(engine.start(request(input)).id);assert.equal(job.result.accepted,true);
  const adoption={id:job.id,mode:'profile',expectedStoreVersion:snapshot().storage.storeVersion};
  assert.throws(()=>engine.adopt({...adoption,indices:[]}),/完整规则顺序/);
  const saved=engine.adopt({...adoption,indices:[0]});assert.equal(saved.profiles.find(p=>p.id===saved.editedId).ruleIds.length,1);
});

test('changing the negotiated output limit between target calls aborts fixed-parameter comparison',async()=>{
  const input=await setup();let count=0;generate=async()=>({text:'PASS',route,parameters:{maxTokens:++count===1?1024:512}});
  const job=await wait(engine.start(request(input)).id);assert.equal(job.status,'failed');assert.match(job.error,/参数发生变化/);assert.equal(job.candidate,null);
});

test('a frozen evaluation remains runnable after its editable suite is removed',async()=>{
  const input=await setup(),suite=engine.suites.get(input.suiteId);
  const started=engine.start(request(input));engine.suites.remove(suite.id,suite.revision);
  const job=await wait(started.id);assert.equal(job.status,'succeeded');assert.equal(job.result.complete,true);assert.equal(job.input.suite.id,suite.id);
});

test('evaluation deduplication ignores the validation-use counter changed by its own run',async()=>{
  const input=request(await setup()),first=engine.start(input);await wait(first.id);const count=calls.length;
  assert.equal(engine.start(input).id,first.id);assert.equal(calls.length,count);
});

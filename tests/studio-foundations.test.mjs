import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, resetForTests, snapshot, updateProfile, updateRule, restoreStudioRevision, maintainStudioRules, studioStorageDirectory } from '../lib/state.js';
import { RevisionStore } from '../lib/studio/revisions.js';
import { SuiteStore, checkOutput } from '../lib/studio/suites.js';
import { hostSessionReader, registerSessionReader, selectSessionSource } from '../lib/studio/sessions.js';
import {atomicWrite,normalizeStore,fileDigest} from '../lib/store.js';
import {registerBackend} from '../lib/studio/model.js';
import {dispatchStudio} from '../lib/studio/runtime.js';

const originalHome = process.env.DSH_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lab-foundations-'));
beforeEach(() => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(root, 'case-'));
  resetForTests(); initialize();
});
after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('prompt-lab-foundations-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('restoring an old profile copies frozen shared rules and preserves current activation', () => {
  const selected = snapshot().selected;
  const ruleId = updateRule({ action: 'create', name: '规则', text: '旧正文' }).editedRuleId;
  const secondId=updateRule({action:'create',name:'停用规则',text:'旧第二条',enabled:false}).editedRuleId;
  const profileId = updateProfile({ action: 'create', name: '方案', prompt: '旧提示词' }).editedId;
  const profile = snapshot().profiles.find(p => p.id === profileId);
  updateProfile({ action: 'save', ...profile, ruleIds: [secondId,ruleId], promptEnabled: false,rulesEnabled:false, expectedVersion: profile.version });
  const history = new RevisionStore(studioStorageDirectory());
  const frozenId = history.list(profileId).revisions.find(r => r.storeVersion === snapshot().storage.storeVersion).id;
  const rule = snapshot().ruleSets.find(r => r.id === ruleId);
  updateRule({ action: 'save', ...rule, text: '新正文', expectedVersion: rule.version });
  const result = restoreStudioRevision({ revisionId: frozenId, side: 'after', profileId, mode: 'copy', expectedStoreVersion: snapshot().storage.storeVersion });
  const restored = result.profiles.find(p => p.id === result.editedId);
  assert.equal(restored.promptEnabled, false);
  assert.equal(restored.prompt, '旧提示词');
  assert.equal(restored.rulesEnabled,false);
  assert.equal(result.ruleSets.find(r=>r.id===restored.ruleIds[0]).text,'旧第二条');
  assert.equal(result.ruleSets.find(r=>r.id===restored.ruleIds[0]).enabled,false);
  assert.notEqual(restored.ruleIds[1], ruleId);
  assert.equal(result.ruleSets.find(r => r.id === restored.ruleIds[1]).text, '旧正文');
  assert.equal(result.ruleSets.find(r => r.id === ruleId).text, '新正文');
  assert.equal(result.selected, selected);
});

test('a prepared journal is recovered only when its complete after-image reached the asset file',()=>{
  const directory=studioStorageDirectory(),history=new RevisionStore(directory),file=path.join(directory,'profiles.json');
  const before=normalizeStore({profiles:snapshot().profiles,ruleSets:[],selected:snapshot().selected,storeVersion:1});
  const after=normalizeStore({...before,storeVersion:2,profiles:before.profiles.map((p,i)=>i? p:{...p,prompt:'committed',version:p.version+1})});
  const pending=history.prepare(before,after,null);
  assert.equal(history.list().revisions.length,0);assert.equal(history.list().pending,1);
  atomicWrite(file,after);
  assert.equal(history.get(pending.id).status,'committed');assert.equal(history.get(pending.id).afterFingerprint,fileDigest(file));
});

test('a corrupt journal preserves its file and does not block saving existing configuration',()=>{
  updateProfile({action:'create',name:'first'});const directory=studioStorageDirectory(),history=new RevisionStore(directory),id=history.list().revisions[0].id;
  const file=history.file(id),broken='{broken journal';fs.writeFileSync(file,broken);
  const result=updateProfile({action:'create',name:'second'});
  assert.ok(result.profiles.some(p=>p.name==='second'));assert.ok(result.historyWarning);assert.equal(fs.readFileSync(file,'utf8'),broken);
  assert.throws(()=>history.list());
});

test('revision retention bounds committed records and refuses to discard unproven pending entries',()=>{
  const history=new RevisionStore(studioStorageDirectory());
  for(let i=0;i<35;i++){const p=snapshot().profiles[0];updateProfile({action:'save',...p,prompt:'revision '+i,expectedVersion:p.version});}
  assert.equal(history.list().revisions.length,30);
  const pendingDirectory=path.join(process.env.DSH_HOME,'pending-fixture'),pending=new RevisionStore(pendingDirectory);
  const before=normalizeStore({profiles:snapshot().profiles,ruleSets:[],storeVersion:1});
  for(let i=0;i<30;i++)pending.prepare(before,normalizeStore({...before,storeVersion:i+2}),null);
  assert.throws(()=>pending.prepare(before,normalizeStore({...before,storeVersion:99}),null),/占满预算/);
  assert.equal(pending.list().pending,30);assert.equal(pending.list().revisions.length,0);
});

test('replacing a saved profile requires confirmation and an unchanged item version',()=>{
  const profile=snapshot().profiles[0];updateProfile({action:'save',...profile,prompt:'edited',expectedVersion:profile.version});
  const history=new RevisionStore(studioStorageDirectory()),id=history.list().revisions[0].id;
  const input={revisionId:id,side:'before',profileId:profile.id,targetId:profile.id,mode:'replace',expectedStoreVersion:snapshot().storage.storeVersion,expectedVersion:profile.version};
  assert.throws(()=>restoreStudioRevision(input),/明确确认/);
  assert.throws(()=>restoreStudioRevision({...input,confirm:true}),e=>e.statusCode===409);
  const current=snapshot().profiles[0],result=restoreStudioRevision({...input,confirm:true,expectedVersion:current.version});
  assert.equal(result.profiles[0].prompt,profile.prompt);assert.equal(result.profiles[0].version,current.version+1);
});

test('studio dispatch authenticates selected message content and strips client-supplied session snapshots',async()=>{
  const calls=[],route={provider:'fixture',model:'model'};
  const stop=registerBackend({defaultRoute:()=>route,providers:()=>[{id:route.provider}],models:async()=>[{id:route.model}],generate:async options=>{calls.push(JSON.parse(options.user).selectedData);return {route,text:JSON.stringify({name:'反馈规则',prompt:'',rules:'',ruleSuggestions:[{action:'create',name:'证据',text:'给出验证证据',source:'selected seq 1'}]})};}});
  const stopReader=registerSessionReader({preview:async id=>({sessionId:id,capturedThroughSeq:2,messages:[{seq:1,role:'user',text:'真实选定反馈',hash:'server-hash'},{seq:2,role:'assistant',text:'未选消息',hash:'other-hash'}]})});
  const post=body=>dispatchStudio({method:'POST'},new URLSearchParams(),body);
  const done=async id=>{for(let n=0;n<100;n++){const r=await dispatchStudio({method:'GET'},new URLSearchParams({kind:'job',id}));if(!['queued','running'].includes(r.job.status))return r.job;await new Promise(r=>setTimeout(r,3));}throw new Error('fixture timeout');};
  try{
    const base={action:'start',operation:'learn',goal:'提取长期纠正',profileId:'default',profileVersion:snapshot().profiles[0].version,selectedSession:{events:[{text:'伪造消息'}]}};
    const first=await post({...base,requestId:'learn-selected-1',sessionSelection:{sessionId:'fixture-session',events:[{seq:1,hash:'server-hash'}]}});
    const job=await done(first.job.id);assert.equal(job.status,'succeeded');assert.equal(job.candidate.sources.selectedSession.events[0].text,'真实选定反馈');
    assert.equal(calls[0].selectedSession.events.length,1);assert.ok(!JSON.stringify(calls[0]).includes('未选消息'));assert.ok(!JSON.stringify(calls[0]).includes('伪造消息'));
    const second=await post({...base,requestId:'learn-manual-2',materials:'粘贴反馈'});await done(second.job.id);assert.equal(calls[1].selectedSession,null);
  }finally{stopReader();stop();}
});

test('batch maintenance refuses deletion of a referenced rule without modifying assets', () => {
  const id = updateRule({ action: 'create', name: '引用规则', text: '保留' }).editedRuleId;
  const p = snapshot().profiles[0];
  updateProfile({ action: 'save', ...p, ruleIds: [id], expectedVersion: p.version });
  const before = snapshot();
  assert.throws(() => maintainStudioRules({ mode: 'delete', ids: [id], versions: { [id]: 1 }, confirm: true, expectedStoreVersion: before.storage.storeVersion }), e => e.statusCode === 409);
  assert.deepEqual(snapshot().ruleSets, before.ruleSets);
  assert.equal(snapshot().storage.storeVersion, before.storage.storeVersion);
});

test('suite edits reject stale revisions and checks reject malformed JSON', () => {
  const store = new SuiteStore(studioStorageDirectory());
  const input = { name: '基础样例', cases: [{ id: 'one', split: 'train', input: '返回 JSON', checks: [{ type: 'hasKeys', value: ['ok'] }] }] };
  const first = store.save(input).suite;
  const second = store.save({ ...input, id: first.id, expectedRevision: first.revision, name: '新名称' }).suite;
  assert.throws(() => store.save({ ...input, id: first.id, expectedRevision: first.revision }), e => e.statusCode === 409);
  assert.equal(store.get(first.id).name, second.name);
  assert.equal(checkOutput('{invalid', first.cases[0].checks)[0].pass, false);
  assert.equal(checkOutput('{"ok":true}', first.cases[0].checks)[0].pass, true);
});

test('session selection excludes reasoning and tools and rejects changed selected messages', async () => {
  let text = '用户修正';
  const reader = hostSessionReader({ readSurface: async () => ({ capturedThroughSeq: 3, events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '可见回答' }] } } },
    { seq: 3, type: 'tool/result', data: { text: '工具秘密' } },
  ] }) });
  const dispose = registerSessionReader(reader);
  try {
    const preview = await reader.preview('synthetic-session');
    assert.equal(preview.messages.length, 2);
    assert.equal(preview.messages[1].text, '可见回答');
    const selection = { sessionId: preview.sessionId, events: [{ seq: 1, hash: preview.messages[0].hash }] };
    const source = await selectSessionSource(selection);
    assert.equal(source.events.length, 1);
    assert.equal(source.events[0].text, text);
    text = '修正已变化';
    await assert.rejects(selectSessionSource(selection), e => e.statusCode === 409);
  } finally { dispose(); }
});

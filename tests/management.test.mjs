import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { initialize, resetForTests, snapshot, updateProfile, updateRule, exportData, previewImport, importData } from '../lib/state.js';
import { MAX_PROFILES, MAX_RULE_SETS, MAX_IMPORT_BYTES, normalizeStore } from '../lib/store.js';
import { handler } from '../lib/ui.js';
import { apply } from '../lib/index.js';

const originalHome = process.env.DSH_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lab-management-'));
let home, file;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(root, 'case-'));
  file = path.join(home, 'prompt-lab', 'profiles.json');
  process.env.DSH_HOME = home; resetForTests(); initialize();
});
after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('prompt-lab-management-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const current = id => snapshot().profiles.find(p => p.id === id);
const rule = id => snapshot().ruleSets.find(r => r.id === id);
const createProfile = name => updateProfile({ action: 'create', name }).editedId;
const createRule = (name, text = name) => updateRule({ action: 'rule.create', name, text }).editedRuleId;
function saveProfile(id, fields = {}) {
  const p = current(id);
  return updateProfile({ action: 'save', ...p, ...fields, expectedVersion: p.version }, { requireVersion: true });
}
function saveRule(id, fields = {}) {
  const r = rule(id);
  return updateRule({ action: 'rule.save', ...r, ...fields, expectedVersion: r.version }, { requireVersion: true });
}
const fails = (fn, status) => assert.throws(fn, e => e.statusCode === status);
async function post(body, route = '/prompt-lab/api', raw) {
  const req = Object.assign(Readable.from([Buffer.from(raw ?? JSON.stringify(body))]), {
    method: 'POST', url: route, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:1000', 'content-type': 'application/json', 'x-prompt-lab-ui': '1' },
  });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handler(req, res); return res;
}

test('legacy migration is lazy, backs up original bytes and preserves texts and settings', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = JSON.stringify({ selected: 'custom', profiles: [{ id: 'custom', name: '原方案', prompt: '正文😀', rules: '旧规则' }] });
  fs.writeFileSync(file, old);
  fs.writeFileSync(path.join(path.dirname(file), 'settings.json'), JSON.stringify({ contextFilter: 'redact', identityBreak: false }));
  initialize();
  assert.equal(snapshot().storage.needsMigration, true);
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  saveProfile('custom', { prompt: '更新正文' });
  const state = snapshot();
  assert.equal(state.storage.needsMigration, false);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'backups', state.storage.backup), 'utf8'), old);
  assert.equal(current('custom').rules, '旧规则');
  assert.equal(state.settings.contextFilter, 'redact');
  assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, 2);
  initialize();
  assert.equal(current('custom').prompt, '更新正文');
});

test('corrupt or future data cannot be overwritten through fallback defaults', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bytes of ['{broken', JSON.stringify({ schemaVersion: 99, profiles: [] })]) {
    fs.writeFileSync(file, bytes); initialize();
    assert.ok(snapshot().storage.error);
    fails(() => createProfile('不得覆盖'), 409);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('profile create copy rename and reload do not silently activate or share mutable data', () => {
  const selected = snapshot().selected;
  const id = createProfile('新配置');
  saveProfile(id, { prompt: 'copy fixture', rules: 'legacy' });
  const copy = updateProfile({ action: 'duplicate', id, expectedVersion: current(id).version }, { requireVersion: true }).editedId;
  assert.notEqual(copy, id);
  assert.equal(current(copy).prompt, 'copy fixture');
  updateProfile({ action: 'rename', id: copy, name: '改名', expectedVersion: current(copy).version }, { requireVersion: true });
  assert.equal(current(copy).name, '改名'); assert.equal(snapshot().selected, selected);
  saveProfile(copy, { prompt: 'only copy changes' });
  initialize(); assert.equal(current(id).prompt, 'copy fixture'); assert.equal(current(copy).prompt, 'only copy changes');
});

test('active profile deletion requires confirmation and an explicit fallback, last item is protected', () => {
  const second=createProfile('Synthetic fallback'),third=createProfile('Synthetic third');
  const p = current('default');
  fails(() => updateProfile({ action: 'delete', id: p.id, expectedVersion: p.version }), 400);
  fails(() => updateProfile({ action: 'delete', id: p.id, expectedVersion: p.version, confirm: true }), 400);
  updateProfile({ action: 'delete', id: p.id, expectedVersion: p.version, confirm: true, fallbackId: second });
  assert.equal(snapshot().selected, second);
  updateProfile({ action: 'delete', id: third, confirm: true });
  fails(() => updateProfile({ action: 'delete', id: second, confirm: true, fallbackId: 'missing' }), 400);
  assert.equal(snapshot().profiles.length, 1);
});

test('HTTP editing uses item versions, rejects stale saves and keeps polling separate', async () => {
  const p = current('default');
  const missing = await post({ action: 'save', id: p.id, prompt: 'x', rules: '' });
  assert.equal(missing.status, 428);
  let first = await post({ action: 'save', id: p.id, prompt: 'window a', rules: '', expectedVersion: p.version });
  assert.equal(first.status, 200);
  const conflict = await post({ action: 'save', id: p.id, prompt: 'window b', rules: '', expectedVersion: p.version });
  assert.equal(conflict.status, 409); assert.equal(current(p.id).prompt, 'window a');
  const latest = current(p.id);
  const callbacks = {};
  apply({ systemPrompt: { section(s) { callbacks[s.name] = s; } }, on() {} });
  callbacks['prompt-lab:custom'].text(); callbacks['prompt-lab:rules'].text();
  assert.equal(current(p.id).version, latest.version);
  first = await post({ action: 'rename', id: p.id, name: 'still editable', expectedVersion: latest.version });
  assert.equal(first.status, 200);
});

test('reusable rules preserve ordered references, independent switches and legacy text exactly once', () => {
  const a = createRule('A', 'alpha'), b = createRule('B', 'beta');
  saveProfile('default', { prompt: 'body', rules: 'legacy', ruleIds: [b,a] });
  const callbacks = {};
  apply({ systemPrompt: { section(s) { callbacks[s.name] = s; } }, on() {} });
  assert.equal(callbacks['prompt-lab:custom'].order, 5100);
  assert.equal(callbacks['prompt-lab:rules'].order, 5101);
  assert.equal(callbacks['prompt-lab:custom'].text(), 'body');
  assert.equal(callbacks['prompt-lab:rules'].text(), '## 当前规则集\nlegacy\n\n## B\nbeta\n\n## A\nalpha');
  const second = createProfile('second'); saveProfile(second, { ruleIds: [a] });
  assert.equal(rule(a).usedBy.length, 2);
  saveRule(a, { enabled: false });
  assert.equal(callbacks['prompt-lab:rules'].text().includes('alpha'), false);
  saveProfile('default', { promptEnabled: false });
  assert.equal(callbacks['prompt-lab:custom'].text(), '');
  assert.ok(callbacks['prompt-lab:rules'].text().includes('beta'));
  saveProfile('default', { rulesEnabled: false }); assert.equal(callbacks['prompt-lab:rules'].text(), '');
  initialize(); assert.deepEqual(current('default').ruleIds, [b,a]); assert.equal(rule(a).enabled, false);
});

test('referenced rule deletion is blocked, unreferencing is required and copies are independent', () => {
  const id = createRule('shared'); saveProfile('default', { ruleIds: [id] });
  fails(() => updateRule({ action: 'rule.delete', id, confirm: true }), 409);
  const copy = updateRule({ action: 'rule.duplicate', id }).editedRuleId;
  saveRule(copy, { text: 'independent copy' }); assert.equal(rule(id).text, 'shared');
  saveProfile('default', { ruleIds: [] });
  updateRule({ action: 'rule.delete', id, confirm: true });
  assert.equal(rule(id), undefined); initialize(); assert.deepEqual(current('default').ruleIds, []);
});

test('export and import round trip into a clean isolated store without runtime information', () => {
  const r = createRule('中文😀', 'rule text'); saveProfile('default', { ruleIds: [r] });
  const bundle = exportData();
  for (const forbidden of ['settings','assembly','evaluation','selected','revision','generatedAt']) assert.equal(bundle[forbidden], undefined);
  assert.equal(bundle.profiles[0].version, undefined);
  const target = path.join(home, 'roundtrip'); process.env.DSH_HOME = target; resetForTests(); initialize();
  const targetFile = path.join(target,'prompt-lab','profiles.json');
  fs.mkdirSync(path.dirname(targetFile), {recursive:true});
  fs.writeFileSync(targetFile, JSON.stringify({schemaVersion:2,profiles:[{id:'only',name:'target',prompt:'target',rules:''}],ruleSets:[]}));
  initialize(); const preview = previewImport(bundle); importData(bundle, preview.storeVersion);
  assert.equal(snapshot().selected, 'only');
  const imported = exportData();
  assert.deepEqual(imported.profiles.slice(1), bundle.profiles); assert.deepEqual(imported.ruleSets, bundle.ruleSets);
});

test('import collisions remap rule references, preview is read only, stale preview conflicts', () => {
  const r = createRule('shared'); saveProfile('default', {ruleIds:[r]});
  const bundle = exportData('profile','default'); const before = fs.readFileSync(file,'utf8');
  const preview = previewImport(bundle); assert.equal(preview.profiles[0].renamedId,true); assert.equal(preview.ruleSets[0].renamedId,true);
  assert.equal(fs.readFileSync(file,'utf8'), before);
  createProfile('concurrent'); fails(() => importData(bundle,preview.storeVersion),409);
  importData(bundle,previewImport(bundle).storeVersion);
  const added = snapshot().profiles.at(-1); assert.notEqual(added.id,'default'); assert.notEqual(added.ruleIds[0],r);
  assert.equal(rule(added.ruleIds[0]).text,rule(r).text); assert.equal(snapshot().selected,'default');
});

test('rules-only transfer works and invalid references or mixed invalid items reject the entire import', () => {
  const r = createRule('source'); const bundle=exportData('rule',r);
  importData(bundle,previewImport(bundle).storeVersion); assert.equal(snapshot().ruleSets.length,2);
  const before=snapshot();
  const invalid={format:'dsh-prompt-lab',formatVersion:1,profiles:[{id:'x',name:'x',prompt:'x',rules:'',ruleIds:['absent']}],ruleSets:[]};
  fails(()=>previewImport(invalid),400);
  fails(()=>previewImport({...invalid,profiles:[{id:'x',name:'x',prompt:'x',rules:''},{id:'bad',name:'',prompt:'x',rules:''}]}),400);
  fails(()=>previewImport({...bundle,formatVersion:99}),400);
  fails(()=>previewImport({...bundle,ruleSets:[bundle.ruleSets[0],bundle.ruleSets[0]]}),400);
  assert.equal(snapshot().storage.storeVersion,before.storage.storeVersion);
});

test('bulk import has its own bounded endpoint and accepts more than a single save budget', async () => {
  const bundle = {format:'dsh-prompt-lab',formatVersion:1,profiles:[],ruleSets:Array.from({length:3},(_,i)=>({id:'r'+i,name:'r'+i,text:'中'.repeat(64000)}))};
  const raw=JSON.stringify({action:'preview',bundle}).replace(/中/g,'\\u4e2d');
  assert.ok(Buffer.byteLength(raw)>788000); assert.ok(Buffer.byteLength(raw)<MAX_IMPORT_BYTES);
  assert.equal((await post(null,'/prompt-lab/api',raw)).status,413);
  const preview=await post(null,'/prompt-lab/api/import',raw); assert.equal(preview.status,200);
  assert.equal((await post({action:'commit',bundle,expectedStoreVersion:preview.body.preview.storeVersion},'/prompt-lab/api/import')).status,200);
});

test('limits, duplicate references and invalid field types are enforced', () => {
  for(let i=snapshot().profiles.length;i<MAX_PROFILES;i++)createProfile('p'+i);
  fails(()=>createProfile('overflow'),400);
  for(let i=0;i<MAX_RULE_SETS;i++)createRule('r'+i);
  fails(()=>createRule('overflow'),400);
  const r=snapshot().ruleSets[0].id;
  fails(()=>saveProfile('default',{ruleIds:[r,r]}),400);
  fails(()=>saveProfile('default',{ruleIds:['missing']}),400);
  fails(()=>saveRule(r,{enabled:'yes'}),400);
  fails(()=>saveProfile('default',{promptEnabled:'yes'}),400);
  fails(()=>previewImport(exportData('rule',r)),400);
});

test('bulk endpoint enforces the upper byte limit before parsing or changing data', async () => {
  const before=snapshot().storage.storeVersion;
  const chunk=Buffer.alloc(65536,120);
  const req=Object.assign(Readable.from(Array(Math.ceil(MAX_IMPORT_BYTES/chunk.length)+1).fill(chunk)),{
    method:'POST',url:'/prompt-lab/api/import',socket:{remoteAddress:'127.0.0.1'},
    headers:{host:'localhost:1000','content-type':'application/json','x-prompt-lab-ui':'1'},
  });
  const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
  await handler(req,res);assert.equal(res.status,413);
  assert.equal(snapshot().storage.storeVersion,before);
});

test('atomic write failure and external edits never leave dangling references or update memory', () => {
  const r=createRule('r'); const before=snapshot(); const bytes=fs.readFileSync(file,'utf8');
  const rename=fs.renameSync;
  try { fs.renameSync=()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};
    assert.throws(()=>saveProfile('default',{ruleIds:[r]}),/disk full/);
  } finally {fs.renameSync=rename;}
  assert.equal(fs.readFileSync(file,'utf8'),bytes); assert.deepEqual(snapshot().profiles,before.profiles);
  assert.equal(fs.readdirSync(path.dirname(file)).some(name=>name.includes('.tmp-')),false);
  fs.writeFileSync(file,bytes+'\n'); fails(()=>saveProfile('default',{ruleIds:[r]}),409);
  assert.equal(fs.readFileSync(file,'utf8'),bytes+'\n');
});

test('normalized and exported data are copies with no mutable reference leaks', () => {
  const r=createRule('r'); saveProfile('default',{ruleIds:[r]});
  const s=snapshot(); s.profiles[0].ruleIds.length=0; s.ruleSets[0].usedBy[0].name='mutated';
  const exported=exportData(); exported.profiles[0].ruleIds.length=0;
  assert.deepEqual(current('default').ruleIds,[r]); assert.notEqual(rule(r).usedBy[0].name,'mutated');
  assert.equal(normalizeStore(JSON.parse(fs.readFileSync(file))).schemaVersion,2);
});


test('full asset HTTP import preserves activation, records a revision and restores interrupted graph before reads',async()=>{
 const {exportAssetPackage,previewAssetImport,importAssetPackage}=await import('../lib/studio/asset-package.js');
 const state=await import('../lib/state.js'),directory=state.studioStorageDirectory(),before=snapshot();
 // Persist once so the transaction verifies a real original core file.
 saveProfile(before.profiles[0].id);const original=snapshot(),bundle=exportAssetPackage(directory,original,{suites:false,scenarios:false,bindingHints:false});
 const preview=await post({action:'assets.preview',bundle},'/prompt-lab/api/assets');assert.equal(preview.status,200);assert.equal(snapshot().profiles.length,original.profiles.length);
 const commit=await post({action:'assets.commit',bundle,token:preview.body.token},'/prompt-lab/api/assets');assert.equal(commit.status,200);assert.equal(commit.body.profiles.length,original.profiles.length*2);assert.equal(commit.body.selected,original.selected);assert.equal(commit.body.receipt.activated,false);
 const retry=await post({action:'assets.commit',bundle,token:preview.body.token},'/prompt-lab/api/assets');assert.equal(retry.status,200);assert.equal(retry.body.receipt.alreadyApplied,true);
 const p=previewAssetImport(directory,snapshot(),bundle);assert.throws(()=>importAssetPackage(directory,snapshot(),bundle,p.token,{faultAfter:1}),e=>e.statusCode===503);
 state.ensureInitialized();assert.equal(snapshot().profiles.length,original.profiles.length*3);assert.equal(snapshot().selected,original.selected);assert.ok(importAssetPackage(directory,snapshot(),bundle,p.token).alreadyApplied);
});

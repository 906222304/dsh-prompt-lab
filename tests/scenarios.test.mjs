import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import * as state from '../lib/state.js';import {SuiteStore} from '../lib/studio/suites.js';import {ScenarioStore} from '../lib/studio/scenarios.js';import {inputDigest} from '../lib/studio/contracts.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-scenarios-')),prior=process.env.DSH_HOME;process.env.DSH_HOME=root;state.resetForTests();state.initialize();
after(()=>{if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
const suites=new SuiteStore(state.studioStorageDirectory()),store=new ScenarioStore(state.studioStorageDirectory()),route={provider:'p',model:'m'};
const suite=suites.save({name:'Scenario suite',cases:[{id:'t',split:'train',input:'Original',checks:[{type:'isJson'}]},{id:'v',split:'validation',input:'Validation',checks:[{type:'isJson'}]}]}).suite;
const body=()=>{const profile=state.snapshot().profiles[0];return {name:'Scenario',profileId:profile.id,profileVersion:profile.version,draft:profile,route,targetRoute:route,judgeRoute:route,suiteId:suite.id,suiteRevision:suite.revision,commonContext:'Shared context',budget:{maxCalls:12,maxRounds:1,maxOutputTotal:12000}};};
let saved;
test('scenario saves complete linked assets/settings and previews/loads without activation or model calls',()=>{
 const before=state.snapshot();saved=store.save(body(),before,suites).scenario;assert.equal(store.list().scenarios.length,1);assert.equal(saved.data.suite.hash,suite.hash);assert.equal(saved.data.budget.maxCalls,12);assert.equal(saved.data.route.model,'m');
 const preview=store.preview(saved.id,state.snapshot(),suites);assert.equal(preview.canApply,true);
 const loaded=store.load({id:saved.id,hash:saved.hash},state.snapshot(),suites,[{id:'p'}]);assert.deepEqual(loaded.scenario.data,saved.data);assert.equal(state.snapshot().selected,before.selected);assert.deepEqual(state.snapshot().profiles,before.profiles);
 suites.useValidation(suite);assert.equal(store.preview(saved.id,state.snapshot(),suites).canApply,true,'telemetry does not invalidate scenario assets');
 assert.throws(()=>store.load({id:saved.id,hash:saved.hash},state.snapshot(),suites,[]),e=>e.statusCode===409);
});
test('scenario rejects unsaved profile edits and drifted source assets while preserving frozen preview',()=>{
 const request=body();request.draft={...request.draft,prompt:'UNSAVED'};assert.throws(()=>store.save(request,state.snapshot(),suites),e=>e.statusCode===409);
 const p=state.snapshot().profiles[0];state.updateProfile({action:'save',...p,prompt:'New saved version',expectedVersion:p.version});
 const preview=store.preview(saved.id,state.snapshot(),suites);assert.equal(preview.canApply,false);assert.notEqual(preview.scenario.data.profile.prompt,'New saved version');assert.match(preview.reason,/已变化/);
 assert.throws(()=>store.load({id:saved.id,hash:saved.hash},state.snapshot(),suites,[{id:'p'}]),e=>e.statusCode===409);
});
test('stale scene refresh shows explicit changes and creates a new scenario with a fresh source contract',()=>{
 const old=store.get(saved.id),proposal=store.refreshPreview({id:saved.id},state.snapshot(),suites);assert.ok(proposal.changes.some(c=>c.field==='profile'));
 const body={id:saved.id,originalHash:proposal.originalHash,previewHash:proposal.hash,confirm:true};
 const updated=store.refresh(body,state.snapshot(),suites).scenario;assert.notEqual(updated.id,saved.id);assert.equal(store.get(saved.id).hash,old.hash);assert.equal(store.preview(updated.id,state.snapshot(),suites).canApply,true);
 const p=state.snapshot().profiles[0];state.updateProfile({action:'save',...p,prompt:'changed while reviewing refresh',expectedVersion:p.version});assert.throws(()=>store.refresh(body,state.snapshot(),suites),e=>e.statusCode===409);
 store.remove({id:updated.id,hash:updated.hash});
});
test('scenario deletion checks identity and corrupt data is preserved',()=>{
 assert.throws(()=>store.remove({id:saved.id,hash:'stale'}),e=>e.statusCode===409);
 const file=store.file(saved.id),original=fs.readFileSync(file,'utf8');fs.writeFileSync(file,original.replace('Shared context','TAMPERED'));
 assert.ok(store.list().warning);assert.throws(()=>store.get(saved.id));assert.ok(fs.existsSync(file));fs.writeFileSync(file,original);store.remove({id:saved.id,hash:saved.hash});assert.equal(store.list().scenarios.length,0);
});


test('legacy scene ignores transient rule usedBy metadata when linked assets have not changed',()=>{
 const rid=state.updateRule({action:'create',name:'Legacy linkage',text:'unchanged rule'}).editedRuleId,p=state.snapshot().profiles[0];
 state.updateProfile({action:'save',...p,ruleIds:[rid],expectedVersion:p.version});const snapshot=state.snapshot(),profile=snapshot.profiles[0],rule=snapshot.ruleSets.find(r=>r.id===rid);
 const record=store.save({...body(),profileId:profile.id,profileVersion:profile.version,draft:profile},snapshot,suites).scenario;
 // Reconstruct the 0.6.3 source key, which included UI-only usedBy metadata.
 record.data.sourceKey=inputDigest({profile:record.data.profile,ruleSets:record.data.ruleSets,suite:{id:record.data.suite.id,revision:record.data.suite.revision,hash:record.data.suite.hash}});record.hash=inputDigest(record.data);fs.writeFileSync(store.file(record.id),JSON.stringify(record));
 const other=state.snapshot().profiles[1];state.updateProfile({action:'save',...other,ruleIds:[rid],expectedVersion:other.version});assert.notDeepEqual(state.snapshot().ruleSets.find(r=>r.id===rid).usedBy,rule.usedBy);assert.equal(store.preview(record.id,state.snapshot(),suites).canApply,true);store.remove({id:record.id,hash:record.hash});
});

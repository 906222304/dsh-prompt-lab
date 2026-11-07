import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as state from '../lib/state.js';import {registerSessionReader} from '../lib/studio/sessions.js';
import {dispatchStudio} from '../lib/studio/runtime.js';import {BindingStore} from '../lib/studio/bindings.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-bindings-')),prior=process.env.DSH_HOME;
process.env.DSH_HOME=root;state.resetForTests();state.initialize();
after(()=>{if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
const call=body=>dispatchStudio({method:'POST'},new URLSearchParams(),body);
test('session pins freeze complete assets, survive reload, isolate sessions and allow explicit removal',async()=>{
 const stop=registerSessionReader({list:async()=>[{id:'a',workspace:'D:/project-a'},{id:'b',workspace:'D:/project-b'}]});
 try{
 const rid=state.updateRule({action:'create',name:'Shared',text:'frozen shared'}).editedRuleId;
 const p=state.snapshot().profiles[0];state.updateProfile({action:'save',...p,prompt:'session A frozen',rules:'attached frozen',ruleIds:[rid],expectedVersion:p.version});
 const global=state.snapshot().selected,preview=await call({action:'binding.preview',sessionId:'a',profileId:p.id});
 await call({action:'binding.save',sessionId:'a',profileId:p.id,hash:preview.draft.hash,expectedRevision:preview.revision,confirm:true});
 assert.equal(state.sessionScopePreview({id:'a'}).mode,'pinned');assert.equal(state.sessionScopePreview({id:'b'}).mode,'global');assert.equal(state.snapshot().selected,global);assert.equal(state.evaluate({agent:{session:{id:'a'}}}),'session A frozen\n\n## 当前规则集\nattached frozen\n\n## Shared\nfrozen shared');
 const rule=state.snapshot().ruleSets.find(r=>r.id===rid);state.updateRule({action:'save',...rule,text:'current shared',expectedVersion:rule.version});
 const current=state.snapshot().profiles.find(v=>v.id===p.id);state.updateProfile({action:'save',...current,prompt:'global changed',expectedVersion:current.version});
 assert.equal(state.sessionScopePreview({id:'a'}).sourceChanged,true);const ap=state.evaluate({agent:{session:{id:'a'}}}),bp=state.evaluate({agent:{session:{id:'b'}}});assert.ok(ap.includes('frozen shared'));assert.ok(!ap.includes('current shared'));assert.ok(bp.includes('global changed'));assert.ok(bp.includes('current shared'));
 assert.equal(state.snapshot().evaluation.sessionId,'b');state.evaluate({agent:{session:{id:'a'}}});assert.equal(state.snapshot().diagnostics.evaluated.binding.profileVersion,preview.draft.profile.version);
 state.initialize();assert.equal(state.evaluate({agent:{session:{id:'a'}}}),ap);assert.equal(state.evaluate({agent:{session:{id:'b'}}}),bp);
 assert.equal(state.evaluate({agent:{session:{id:'child-a'}}}),bp,'no implicit subagent inheritance');
 const fallback=state.snapshot().profiles.find(v=>v.id!==p.id);state.updateProfile({action:'delete',id:p.id,confirm:true,fallbackId:fallback.id});
 const removable=state.snapshot().ruleSets.find(v=>v.id===rid);state.updateRule({action:'delete',id:rid,confirm:true,expectedVersion:removable.version});
 assert.equal(state.evaluate({agent:{session:{id:'a'}}}),ap,'deleting original assets leaves the pinned snapshot intact');
 const unboundAfterDelete=state.evaluate({agent:{session:{id:'b'}}});
 state.initialize({enabled:false});assert.equal(state.evaluate({agent:{session:{id:'a'}}}),'');state.initialize();
 const stale=state.snapshot().sessionBindings.revision;await assert.rejects(()=>call({action:'binding.remove',sessionId:'a',expectedRevision:stale-1}),e=>e.statusCode===409);
 await call({action:'binding.remove',sessionId:'a',expectedRevision:stale});assert.equal(state.evaluate({agent:{session:{id:'a'}}}),unboundAfterDelete);
 }finally{stop();}
});
test('binding preview rejects changed source assets or project metadata and unknown sessions',async()=>{
 let workspace='D:/one';const stop=registerSessionReader({list:async()=>[{id:'a',workspace}]});
 try{const p=state.snapshot().profiles[0],preview=await call({action:'binding.preview',sessionId:'a',profileId:p.id});
 workspace='D:/two';await assert.rejects(()=>call({action:'binding.save',sessionId:'a',profileId:p.id,hash:preview.draft.hash,expectedRevision:preview.revision,confirm:true}),e=>e.statusCode===409);
 await assert.rejects(()=>call({action:'binding.preview',sessionId:'unknown',profileId:p.id}),e=>e.statusCode===409);
 const fresh=await call({action:'binding.preview',sessionId:'a',profileId:p.id});state.updateProfile({action:'save',...p,prompt:'changed after preview',expectedVersion:p.version});
 await assert.rejects(()=>call({action:'binding.save',sessionId:'a',profileId:p.id,hash:fresh.draft.hash,expectedRevision:fresh.revision,confirm:true}),e=>e.statusCode===409);
 }finally{stop();}
});
test('corrupt binding storage is preserved, blocks overwrite, and does not silently apply the global profile to bound sessions',()=>{
 const file=path.join(state.studioStorageDirectory(),'studio/bindings.json'),original=fs.readFileSync(file,'utf8');fs.writeFileSync(file,'{broken');
 state.initialize();assert.ok(state.snapshot().sessionBindings.error);assert.equal(state.sessionScopePreview({id:'a'}).mode,'blocked');assert.equal(state.evaluate({agent:{session:{id:'a'}}}),'');assert.ok(state.evaluate({}).length>0);
 const store=new BindingStore(state.studioStorageDirectory());assert.throws(()=>store.commit({action:'binding.remove',sessionId:'a',expectedRevision:0}),e=>e.statusCode===409);assert.equal(fs.readFileSync(file,'utf8'),'{broken');fs.writeFileSync(file,original);state.initialize();
});

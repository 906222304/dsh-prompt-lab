import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as state from '../lib/state.js';
import {inputDigest} from '../lib/studio/contracts.js';
import {registerSessionReader} from '../lib/studio/sessions.js';
import {registerBackend} from '../lib/studio/model.js';
import {dispatchStudio} from '../lib/studio/runtime.js';
import {SuiteStore,normalizeSuite} from '../lib/studio/suites.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-failure-')),prior=process.env.DSH_HOME;
process.env.DSH_HOME=root;state.resetForTests();state.initialize();
after(()=>{if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
const req=body=>dispatchStudio({method:'POST'},new URLSearchParams(),body);
const events=[{seq:1,role:'user',text:'Return a JSON object.'},{seq:2,role:'assistant',text:'I successfully executed all tools.'},{seq:3,role:'assistant',text:'UNSELECTED SECRET'}].map(e=>({...e,hash:inputDigest(e.text),truncated:false}));
let draft;
test('selected failure becomes an unsaved training draft with exact provenance and no unrelated messages',async()=>{
 const stopReader=registerSessionReader({preview:async()=>({sessionId:'s1',capturedThroughSeq:3,messages:events}),list:async()=>[]});let calls=0;
 const stop=registerBackend({providers:()=>[{id:'p'}],models:async()=>[],defaultRoute:()=>({provider:'p',model:'m'}),generate:async o=>{calls++;assert.equal(o.purpose,'prompt-lab-regression');assert.ok(!o.user.includes('UNSELECTED SECRET'));return {text:JSON.stringify({name:'Failure regression',cases:[{id:'failure-1',split:'validation',input:'invented input',reference:'',checks:[{type:'isJson'}],rubric:'',threshold:0.7}]}),route:o.route};}});
 try{
 const p=state.snapshot().profiles[0],base={action:'start',operation:'regression',requestId:'failure-case-0001',profileId:p.id,profileVersion:p.version,draft:p,goal:'Must return valid JSON; do not claim tool execution.',sessionSelection:{sessionId:'s1',events:events.slice(0,2).map(({seq,hash})=>({seq,hash}))}};
 const before=state.snapshot();await assert.rejects(()=>req({...base,sessionSelection:{sessionId:'s1',events:[{seq:1,hash:'old'}]}}),e=>e.statusCode===409);assert.equal(calls,0);
 const {job}=await req(base);let current;
 for(let i=0;i<60;i++){current=(await dispatchStudio({method:'GET'},new URLSearchParams({kind:'job',id:job.id}))).job;if(!['queued','running'].includes(current.status))break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(current.status,'succeeded',current.error);draft=current.result.suite;assert.equal(draft.cases[0].input,events[0].text);assert.equal(draft.cases[0].split,'train');assert.equal(draft.cases[0].source.failureOutput,events[1].text);assert.equal(draft.cases[0].source.confidence,'claimed');assert.equal(draft.cases[0].source.confirmed,false);
 assert.equal(new SuiteStore(root).list().suites.length,0);assert.deepEqual(state.snapshot().profiles,before.profiles);assert.equal(calls,1);
 }finally{stop();stopReader();}
});
test('failure suite requires review, persists provenance, rejects input drift and cannot become held-out validation',()=>{
 const suites=new SuiteStore(root);assert.throws(()=>suites.save(draft),/核对/);
 draft.cases[0].source.confirmed=true;const saved=suites.save(draft).suite;assert.equal(saved.version,2);assert.deepEqual(suites.get(saved.id).cases[0].source,saved.cases[0].source);
 assert.throws(()=>normalizeSuite({...saved,cases:saved.cases.map(c=>({...c,split:'validation'}))}),/只能作为训练/);
 assert.throws(()=>normalizeSuite({...saved,cases:saved.cases.map(c=>({...c,input:'new task'}))}),e=>e.statusCode===409);
 assert.throws(()=>normalizeSuite({...saved,cases:saved.cases.map(c=>({...c,checks:[],rubric:''}))}),/标准/);
 const tampered=structuredClone(saved);tampered.cases[0].source.events[1].text='different';assert.throws(()=>normalizeSuite(tampered),e=>e.statusCode===409);
 const file=suites.file(saved.id),bytes=fs.readFileSync(file,'utf8');fs.writeFileSync(file,bytes.replace('Return a JSON','Tampered JSON'));assert.throws(()=>suites.get(saved.id));fs.writeFileSync(file,bytes);
 const legacy=suites.save({name:'Legacy',cases:[{id:'v1',split:'validation',input:'original',checks:[{type:'isJson'}]}]}).suite;assert.equal(legacy.version,1);assert.equal(suites.get(legacy.id).cases[0].source,undefined);
});

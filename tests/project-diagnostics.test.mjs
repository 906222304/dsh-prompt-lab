import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanWorkspace,selectWorkspaceSource} from '../lib/studio/workspace.js';
import {injectionDiagnostics,textHash} from '../lib/diagnostics.js';
import * as state from '../lib/state.js';
import {dispatchStudio} from '../lib/studio/runtime.js';
import {registerBackend} from '../lib/studio/model.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-project-')),prior=process.env.DSH_HOME;
after(()=>{if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;assert.equal(path.dirname(temp),os.tmpdir());fs.rmSync(temp,{recursive:true,force:true});});
const directory=name=>{const value=path.join(temp,name);fs.mkdirSync(value,{recursive:true});return value;};
const selection=scan=>({root:scan.root,cwd:scan.cwd,files:scan.files.filter(f=>f.available).map(({path,hash})=>({path,hash}))});
test('project instruction scope stops at repository root and never scans children',()=>{
 const root=directory('repo'),cwd=directory('repo/src/nested');fs.mkdirSync(path.join(root,'.git'));fs.writeFileSync(path.join(temp,'AGENTS.md'),'outside');
 for(const [dir,name,text]of [[root,'AGENTS.md','root policy'],[path.dirname(cwd),'CLAUDE.local.md','ancestor'],[cwd,'AGENTS.local.md','leaf']])fs.writeFileSync(path.join(dir,name),text);
 directory('repo/src/nested/deeper');fs.writeFileSync(path.join(cwd,'deeper/CLAUDE.md'),'child');
 const scan=scanWorkspace({cwd});assert.equal(scan.root,root);assert.deepEqual(scan.files.map(f=>f.scope),['root','ancestor','cwd']);
 assert.deepEqual(selectWorkspaceSource(selection(scan)).files.map(f=>f.text),['root policy','ancestor','leaf']);
 const single=scanWorkspace({cwd:directory('no-root/leaf')});assert.equal(single.root,single.cwd);assert.equal(single.files.length,0);
 assert.throws(()=>scanWorkspace({cwd:temp,root}),/项目内/);
});
test('workspace frozen selection rejects stale files, excess bytes and paths outside candidate names',()=>{
 const root=directory('stale');fs.writeFileSync(path.join(root,'AGENTS.md'),'v1');const scan=scanWorkspace({cwd:root});fs.writeFileSync(path.join(root,'AGENTS.md'),'v2');
 assert.throws(()=>selectWorkspaceSource(selection(scan)),e=>e.statusCode===409);
 assert.throws(()=>selectWorkspaceSource({cwd:root,files:[{path:path.join(temp,'secret.txt'),hash:'x'}]}),e=>e.statusCode===409);
 fs.writeFileSync(path.join(root,'AGENTS.md'),'a'.repeat(60001));assert.equal(scanWorkspace({cwd:root}).files[0].available,false);
 fs.writeFileSync(path.join(root,'AGENTS.md'),'a'.repeat(50000));fs.writeFileSync(path.join(root,'CLAUDE.md'),'b'.repeat(50000));
 assert.throws(()=>selectWorkspaceSource(selection(scanWorkspace({cwd:root}))),e=>e.statusCode===413);
});
test('workspace real paths reject directory junction escapes and invalid UTF-8',()=>{
 const root=directory('links'),outside=directory('external');fs.writeFileSync(path.join(outside,'AGENTS.md'),'external');
 fs.symlinkSync(outside,path.join(root,'linked'),'junction');assert.throws(()=>scanWorkspace({cwd:path.join(root,'linked'),root}),/项目内/);
 fs.writeFileSync(path.join(root,'AGENTS.md'),Buffer.from([0xff]));assert.equal(scanWorkspace({cwd:root}).files[0].available,false);
});
test('workspace API freezes only explicit selected files and rechecks before model dispatch',async()=>{
 process.env.DSH_HOME=directory('home');state.resetForTests();state.initialize();
 const initialCount=state.snapshot().profiles.length;const root=directory('api');fs.writeFileSync(path.join(root,'AGENTS.md'),'selected policy');fs.writeFileSync(path.join(root,'CLAUDE.md'),'do not send');
 const q=new URLSearchParams(),scan=await dispatchStudio({method:'POST'},q,{action:'workspace.scan',cwd:root});const chosen={...selection(scan),files:selection(scan).files.slice(0,1)};
 const preview=await dispatchStudio({method:'POST'},q,{action:'workspace.preview',selection:chosen});assert.equal(preview.source.files.length,1);
 let seen;const stop=registerBackend({providers:()=>[{id:'p'}],defaultRoute:()=>({provider:'p',model:'m'}),models:async()=>[],generate:async opts=>{seen=opts;return {text:JSON.stringify({name:'test',prompt:'policy',rules:'',ruleSuggestions:[]}),route:opts.route};}});
 try{const profile=state.snapshot().profiles[0],body={action:'start',requestId:'project-source-1',operation:'generate',profileId:profile.id,profileVersion:profile.version,workspaceSelection:chosen,goal:''};
 fs.writeFileSync(path.join(root,'AGENTS.md'),'changed');await assert.rejects(()=>dispatchStudio({method:'POST'},q,body),e=>e.statusCode===409);assert.equal(seen,undefined);
 const fresh={...selection(scanWorkspace({cwd:root})),files:selection(scanWorkspace({cwd:root})).files.slice(0,1)};
 const {job}=await dispatchStudio({method:'POST'},q,{...body,workspaceSelection:fresh});
 for(let i=0;i<50;i++){const current=await dispatchStudio({method:'GET'},new URLSearchParams({kind:'job',id:job.id}));if(current.job.status==='succeeded')break;await new Promise(r=>setTimeout(r,5));}
 assert.ok(seen.user.includes('changed'));assert.ok(!seen.user.includes('do not send'));assert.equal(state.snapshot().profiles.length,initialCount);
 }finally{stop();}
});
test('diagnostic stages preserve exclusion reasons and never claim final-request verification',()=>{
 const raw='A sufficiently long project requirement for exact duplication';
 const args={profiles:[{id:'p',name:'Profile',version:2,prompt:raw,rules:'attached',promptEnabled:true,rulesEnabled:true,ruleIds:['r']}],ruleSets:[{id:'r',name:'Disabled',version:3,text:'rule',enabled:false}],selected:'p',status:{enabled:true,registered:true},configRevision:5,storeVersion:7,evaluation:{text:raw,configRevision:4,sessionId:'other'},assembly:{sections:[{name:'prompt-lab:custom',text:raw},{name:'another:policy',text:'prefix '+raw.replaceAll(' ','\n')+' suffix'}],contexts:[],scope:'session-assembly',sessionId:'another-session',configRevision:4,truncated:true}};
 const d=injectionDiagnostics(args);assert.equal(d.sources[0].hash,textHash(raw));assert.equal(d.sources[2].included,false);assert.match(d.sources[2].reason,/停用/);assert.equal(d.evaluated.stale,true);assert.equal(d.requestEvidence.verified,false);assert.equal(d.duplicates.length,1);assert.match(d.duplicateCoverage,/旧配置/);assert.equal(d.observed.sessionId,'another-session');
 args.assembly.configRevision=5;assert.match(injectionDiagnostics(args).duplicateCoverage,/截断/);
 args.status.enabled=false;assert.ok(injectionDiagnostics(args).sources.every(s=>!s.included));
});

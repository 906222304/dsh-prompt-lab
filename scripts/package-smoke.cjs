/** Exercise the actual archive and read its resulting assets with the retained baseline package. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
async function main(){
  const project=path.resolve(__dirname,'..'),version=require('../package.json').version;
  const archive=path.resolve(process.argv[2]||path.join(project,`dsh-prompt-lab-${version}.tgz`));
  const baselineArchive=path.resolve(process.argv[3]||path.join(project,'dsh-prompt-lab-0.6.0.tgz'));
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-package-')),oldHome=process.env.DSH_HOME;
  const extract=(file,to)=>{const entries=execFileSync('tar',['-tzf',file],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);assert.ok(entries.every(e=>e.startsWith('package/')&&!e.split('/').includes('..')));fs.mkdirSync(to,{recursive:true});execFileSync('tar',['-xzf',file,'-C',to],{windowsHide:true});};
  try{
    extract(archive,stage);const pkg=path.join(stage,'package');assert.equal(JSON.parse(fs.readFileSync(path.join(pkg,'package.json'))).version,version);
    process.env.DSH_HOME=path.join(stage,'fixture-home');
    const state=await import(pathToFileURL(path.join(pkg,'lib/state.js'))),plugin=await import(pathToFileURL(path.join(pkg,'lib/index.js')));
    const {Studio}=await import(pathToFileURL(path.join(pkg,'lib/studio/jobs.js'))),{RevisionStore}=await import(pathToFileURL(path.join(pkg,'lib/studio/revisions.js')));
    const sections={};plugin.apply({systemPrompt:{section:s=>{sections[s.name]=s;}},on(){}},{prompt:'BASELINE'});
    const ruleId=state.updateRule({action:'create',name:'Shared fixture',text:'shared policy'}).editedRuleId;
    let base=state.snapshot().profiles[0];state.updateProfile({action:'save',...base,ruleIds:[ruleId],expectedVersion:base.version});base=state.snapshot().profiles[0];
    const route={provider:'fixture',model:'archive'},calls=[];
    const backend={defaultRoute:()=>route,providers:()=>[{id:route.provider}],models:async()=>[{id:route.model}],generate:async o=>{
      calls.push(o);return {route,text:o.purpose==='prompt-lab-studio'?JSON.stringify({name:'Archive candidate',prompt:'CANDIDATE',rules:'',ruleSuggestions:[],changes:[],assumptions:[],questions:[]}):o.purpose==='prompt-lab-optimization'?JSON.stringify({prompt:'IMPROVED',rules:'',changes:['train feedback']}):o.system.includes('IMPROVED')?'PASS':'FAIL'};
    }};
    const engine=new Studio({directory:state.studioStorageDirectory(),snapshot:state.snapshot,apply:state.applyStudioCandidate,backend:()=>backend});
    const request=extra=>({requestId:'archive-'+Math.random().toString(36).slice(2),operation:'generate',goal:'Synthetic archive acceptance',profileId:base.id,profileVersion:base.version,includeDraft:true,draft:base,...extra});
    const done=async id=>{for(let n=0;n<100;n++){const j=engine.get(id);if(!['queued','running'].includes(j.status)){assert.equal(j.status,'succeeded',j.error);return j;}await new Promise(r=>setTimeout(r,5));}throw Error('archive job timeout');};
    const seed=await done(engine.start(request()).id);
    const suite=engine.suites.save({name:'Archive suite',cases:[{id:'train',split:'train',input:'TRAIN',checks:[{type:'equals',value:'PASS'}]},{id:'validation',split:'validation',input:'HELD_SECRET',checks:[{type:'equals',value:'PASS'}]}]}).suite;
    const optimized=await done(engine.start(request({operation:'optimize',candidateJobId:seed.id,indices:[],suiteId:suite.id,suiteRevision:suite.revision,budget:{maxRounds:1}})).id);
    assert.equal(optimized.result.accepted,true);assert.ok(calls.filter(c=>c.purpose==='prompt-lab-optimization').every(c=>!c.user.includes('HELD_SECRET')));
    const adopted=engine.adopt({id:optimized.id,mode:'profile',indices:[],expectedStoreVersion:state.snapshot().storage.storeVersion});assert.equal(adopted.selected,base.id);
    state.updateProfile({action:'activate',id:adopted.editedId});assert.equal(sections['prompt-lab:custom'].text(),'IMPROVED');assert.ok(sections['prompt-lab:rules'].text().includes('shared policy'));
    const history=new RevisionStore(state.studioStorageDirectory()),record=history.list(adopted.editedId).revisions[0];
    const restored=state.restoreStudioRevision({revisionId:record.id,side:'after',profileId:adopted.editedId,mode:'copy',expectedStoreVersion:state.snapshot().storage.storeVersion});assert.notEqual(restored.editedId,adopted.editedId);assert.equal(restored.selected,adopted.editedId);
    const baselineStage=path.join(stage,'baseline');extract(baselineArchive,baselineStage);
    const old=await import(pathToFileURL(path.join(baselineStage,'package/lib/index.js'))),oldState=await import(pathToFileURL(path.join(baselineStage,'package/lib/state.js'))),oldSections={};
    old.apply({systemPrompt:{section:s=>{oldSections[s.name]=s;}},on(){}},{});assert.equal(oldState.snapshot().version,'0.6.0');assert.equal(oldSections['prompt-lab:custom'].text(),'IMPROVED');assert.ok(oldSections['prompt-lab:rules'].text().includes('shared policy'));assert.equal(oldState.snapshot().profiles.length,state.snapshot().profiles.length);
    engine.dispose();console.log(JSON.stringify({ok:true,version,archiveRuntime:true,optimization:true,heldOutExcluded:true,adoption:true,restore:true,actual060ReadsNewAssets:true}));
  }finally{if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;
    assert.equal(path.dirname(path.resolve(stage)),path.resolve(os.tmpdir()));assert.ok(path.basename(stage).startsWith('prompt-lab-package-'));fs.rmSync(stage,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});

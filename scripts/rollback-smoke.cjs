/** Verify restoring a migrated fixture with the actual 0.4.9 package, never the user's data. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const{pathToFileURL}=require('node:url');
async function main(){
  const project=path.resolve(__dirname,'..');
  const archive=path.resolve(process.argv[2] || path.join(project,'dsh-prompt-lab-0.4.9.tgz'));
  const entries=execFileSync('tar',['-tzf',archive],{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/);
  assert.ok(entries.every(entry=>entry.startsWith('package/')&&!entry.split('/').includes('..')),'Expected an npm package archive');
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-lab-rollback-'));
  const previousHome=process.env.DSH_HOME;
  try {
    execFileSync('tar',['-xzf',archive,'-C',stage],{windowsHide:true});
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage,'package/package.json'),'utf8')).version,'0.4.9');
    const home=path.join(stage,'fixture-home');fs.mkdirSync(path.join(home,'prompt-lab'),{recursive:true});process.env.DSH_HOME=home;
    const file=path.join(home,'prompt-lab/profiles.json');
    const original=JSON.stringify({selected:'custom',profiles:[{id:'custom',name:'rollback fixture',prompt:'original body',rules:'original rule'}]});fs.writeFileSync(file,original);
    const current=await import(pathToFileURL(path.join(project,'lib/state.js')).href);current.initialize();
    const r=current.updateRule({action:'rule.create',name:'new rule',text:'new policy'}).editedRuleId;
    const p=current.snapshot().profiles[0];current.updateProfile({action:'save',...p,ruleIds:[r],expectedVersion:p.version});
    const backup=path.join(home,'prompt-lab/backups',current.snapshot().storage.backup);assert.equal(fs.readFileSync(backup,'utf8'),original);
    fs.copyFileSync(backup,file);
    const baseline=await import(pathToFileURL(path.join(stage,'package/lib/state.js')).href);baseline.initialize();
    assert.equal(baseline.evaluate(),'original body\n\n## 当前规则集\noriginal rule');
    console.log(JSON.stringify({ok:true,baseline:'0.4.9',schemaMigration:2,restoredOriginalBytes:true,legacyEvaluationVerified:true}));
  }finally{
    if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;
    assert.equal(path.dirname(path.resolve(stage)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(stage).startsWith('prompt-lab-rollback-'));
    fs.rmSync(stage,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

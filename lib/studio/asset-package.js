/** Portable, typed asset graphs. Model credentials and active bindings are never imported. */
import fs from 'node:fs';import path from 'node:path';import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {normalizeStore,normalizeProfile,normalizeRule,loadStore,fileDigest,problem} from '../store.js';
import {inputDigest,routeOf} from './contracts.js';import {normalizeSuite,SuiteStore} from './suites.js';
import {normalizeBudget} from './experiments.js';import {ScenarioStore,scenarioSourceKey} from './scenarios.js';import {BindingStore} from './bindings.js';
import {RevisionStore,makeRevisionRecord,REVISION_LIMITS} from './revisions.js';
import {assetPath,digestJSON,commitAssetImport,assetImportReceipt,recoverAssetImports} from './asset-journal.js';
export const ASSET_LIMITS=Object.freeze({bytes:32*1024*1024,profiles:20,rules:50,suites:20,scenarios:10,bindingHints:20,evidence:20});
const secret=randomBytes(32),categories=['profiles','rules','suites','scenarios','bindingHints','evidence'];
function guardAssets(directory){for(const folder of ['suites','scenarios','imported-bindings','imported-evidence','jobs','revisions']){const dir=assetPath(directory,'studio',folder);if(fs.existsSync(dir))for(const name of fs.readdirSync(dir))if(name.endsWith('.json'))assetPath(directory,'studio',folder,name);}assetPath(directory,'profiles.json');assetPath(directory,'studio','bindings.json');}
const clone=v=>JSON.parse(JSON.stringify(v));const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const keyOf=(kind,data)=>kind+'-'+digestJSON(data);
const required=(condition,message)=>{if(!condition)throw problem(message);};
const list=(value,max,label)=>{required(Array.isArray(value)&&value.length<=max,label+'数量无效或超限');return value;};
const bounded=(value,max,label)=>{required(typeof value==='string'&&value.length<=max,label+'无效或超长');return value;};
const integer=(v,min,max,label)=>{required(Number.isSafeInteger(v)&&v>=min&&v<=max,label+'无效');return v;};
const uuid=id=>/^[a-f0-9-]{36}$/.test(id);
const uid=(seed,kind,key)=>{const h=digestJSON({seed,kind,key}).slice(0,32);return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
function optionsOf(value={}){required(object(value),'导出选项无效');const result={};for(const k of categories){if(value[k]!==undefined)required(typeof value[k]==='boolean','导出选项须为布尔');result[k]=value[k]??(k!=='evidence');}return result;}
function suiteValue(record){
  required(object(record)&&/^s-[a-f0-9-]{36}$/.test(record.id),'测试集快照 ID 无效');const normalized=normalizeSuite(record);
  required([1,2,3].includes(record.version)&&record.hash===inputDigest(normalized),'测试集快照哈希不一致');
  return {version:record.version,id:record.id,revision:integer(record.revision,1,Number.MAX_SAFE_INTEGER,'测试集版本'),...normalized,hash:record.hash,validationUses:integer(record.validationUses??0,0,Number.MAX_SAFE_INTEGER,'验证使用次数'),origin:typeof record.origin==='string'?record.origin:'imported'};
}
function redactSuite(record,withEvidence){const data=suiteValue(record);if(!withEvidence){for(const item of data.cases)if(item.source){const s=item.source;item.source={kind:'imported-failure-summary',inputHash:inputDigest(item.input),originalHash:s.kind==='imported-failure-summary'?s.originalHash:digestJSON(s),confirmed:true,confidence:'claimed',sourceOmitted:true,...(s.confirmedAt?{confirmedAt:s.confirmedAt}:{})};}}
  const normalized=normalizeSuite(data);return {...data,version:normalized.cases.some(c=>c.source?.kind==='imported-failure-summary')?3:data.version,...normalized,hash:inputDigest(normalized)};
}
function terminalEvidence(job){
  required(object(job)&&job.version===1&&['succeeded','failed','cancelled','timed_out','interrupted','budget_exhausted'].includes(job.status),'只支持终结任务的只读证据');
  return {name:bounded(job.candidate?.content?.name||job.input?.goal||job.id,6000,'任务名称'),operation:bounded(job.input?.operation||'unknown',80,'操作'),status:job.status,createdAt:bounded(job.createdAt,50,'时间'),route:routeOf(job.route),input:clone(job.input),candidate:job.candidate?clone(job.candidate.content):null,result:job.result?clone(job.result):null,usage:clone(job.usage),readOnly:true};
}
function readJson(file,max=ASSET_LIMITS.bytes){if(fs.statSync(file).size>max)throw problem('资产文件超过读取预算',413);return JSON.parse(fs.readFileSync(file,'utf8'));}
export function exportAssetPackage(directory,state,requested={}){
  guardAssets(directory);const options=optionsOf(requested),graph=Object.fromEntries(categories.map(k=>[k,[]])),seen=new Map();let omittedRunning=0;
  const add=(type,kind,data)=>{const key=keyOf(kind,data);if(!seen.has(key)){seen.set(key,true);graph[type].push({key,...data});}return key;};
  const addRule=rule=>add('rules','r',{asset:normalizeRule(rule)});
  const addProfile=(profile,rules)=>{const asset=normalizeProfile(profile),ruleKeys=asset.ruleIds.map(id=>{const r=rules.find(r=>r.id===id);if(!r)throw problem('配置依赖缺失，无法生成完整资产包',409);return addRule(r);});return add('profiles','p',{asset,ruleKeys});};
  const addSuite=record=>add('suites','s',{asset:redactSuite(record,options.evidence)});
  if(options.rules)for(const rule of state.ruleSets)addRule(rule);
  if(options.profiles)for(const profile of state.profiles)addProfile(profile,state.ruleSets);
  const suites=new SuiteStore(directory),scenarios=new ScenarioStore(directory);
  if(options.suites){const data=suites.list();if(data.warning)throw problem(data.warning+'；请修复或取消导出测试集',409);for(const s of data.suites)addSuite(suites.get(s.id));}
  if(options.scenarios){const data=scenarios.list();if(data.warning)throw problem(data.warning+'；请修复或取消导出场景',409);for(const s of data.scenarios){const value=scenarios.get(s.id),d=value.data;add('scenarios','c',{name:d.name,profileKey:addProfile(d.profile,d.ruleSets),suiteKey:addSuite(d.suite),route:routeOf(d.route),targetRoute:routeOf(d.targetRoute),judgeRoute:routeOf(d.judgeRoute),budget:normalizeBudget(d.budget),commonContext:bounded(d.commonContext,8000,'共同背景'),origin:{id:value.id,hash:value.hash}});}}
  if(options.bindingHints){const store=new BindingStore(directory);if(store.error)throw problem(store.error,409);for(const b of store.data.bindings)add('bindingHints','h',{profileKey:addProfile(b.profile,b.ruleSets),originSessionId:b.sessionId,workspace:b.workspace,inactive:true});
    const hintDir=path.join(directory,'studio/imported-bindings');if(fs.existsSync(hintDir))for(const name of fs.readdirSync(hintDir))if(/^h-[a-f0-9-]{36}\.json$/.test(name)){const hint=readJson(path.join(hintDir,name));const p=state.profiles.find(p=>p.id===hint.profileId);if(p)add('bindingHints','h',{profileKey:addProfile(p,state.ruleSets),originSessionId:hint.originSessionId,workspace:hint.workspace,inactive:true});}}
  if(options.evidence){const jobs=path.join(directory,'studio/jobs');if(fs.existsSync(jobs))for(const name of fs.readdirSync(jobs).sort())if(/^j-[a-f0-9-]{36}\.json$/.test(name)){const job=readJson(path.join(jobs,name));if(['queued','running'].includes(job.status)){omittedRunning++;continue;}add('evidence','e',{data:terminalEvidence(job)});}
    const evidenceDir=path.join(directory,'studio/imported-evidence');if(fs.existsSync(evidenceDir))for(const name of fs.readdirSync(evidenceDir))if(/^e-[a-f0-9-]{36}\.json$/.test(name))add('evidence','e',{data:readJson(path.join(evidenceDir,name)).data});}
  for(const k of categories)required(graph[k].length<=ASSET_LIMITS[k],k+'及依赖数量超过资产包上限，请减少导出范围');
  required(categories.some(k=>graph[k].length),'请选择至少一种非空资产');
  const payload={format:'dsh-prompt-lab-assets',formatVersion:1,producer:{name:'dsh-prompt-lab',version:state.version},exportedAt:new Date().toISOString(),options,omittedRunning,graph};
  const bundle={...payload,digest:digestJSON(payload)};if(Buffer.byteLength(JSON.stringify(bundle),'utf8')>ASSET_LIMITS.bytes)throw problem('资产包超过 32 MiB，请减少所选类型或原文证据',413);return bundle;
}
function validateAssetPackage(bundle){
  required(object(bundle)&&bundle.format==='dsh-prompt-lab-assets'&&bundle.formatVersion===1&&object(bundle.graph),'不支持的完整资产包格式');
  if(Buffer.byteLength(JSON.stringify(bundle),'utf8')>ASSET_LIMITS.bytes)throw problem('资产包超过 32 MiB',413);
  const {digest,...payload}=bundle;required(digest===digestJSON(payload),'资产包内容或校验值已变化');const g=bundle.graph,index=new Map();
  for(const type of categories)for(const node of list(g[type],ASSET_LIMITS[type],type)){required(object(node)&&typeof node.key==='string'&&!index.has(node.key),'资产节点键重复或无效');const {key,...data}=node;required(key===keyOf({profiles:'p',rules:'r',suites:'s',scenarios:'c',bindingHints:'h',evidence:'e'}[type],data),'资产节点校验失败');index.set(key,{type,node});}
  const ref=(key,type)=>{const found=index.get(key);required(found?.type===type,'资产依赖不存在或类型错误');return found.node;};
  for(const node of g.rules)normalizeRule(node.asset);
  for(const node of g.profiles){const p=normalizeProfile(node.asset);list(node.ruleKeys,50,'规则依赖');required(node.ruleKeys.length===p.ruleIds.length,'配置规则依赖不完整');node.ruleKeys.forEach((key,i)=>required(ref(key,'rules').asset.id===p.ruleIds[i],'配置规则顺序或身份不匹配'));}
  for(const node of g.suites)suiteValue(node.asset);
  for(const node of g.scenarios){bounded(node.name,80,'场景名');ref(node.profileKey,'profiles');ref(node.suiteKey,'suites');routeOf(node.route);routeOf(node.targetRoute);routeOf(node.judgeRoute);normalizeBudget(node.budget);bounded(node.commonContext,8000,'场景背景');}
  for(const node of g.bindingHints){ref(node.profileKey,'profiles');bounded(node.originSessionId,200,'原会话');bounded(node.workspace,2000,'项目目录');required(node.inactive===true,'导入绑定必须保持未生效');}
  for(const node of g.evidence){required(object(node.data)&&node.data.readOnly===true&&typeof node.data.operation==='string'&&['succeeded','failed','cancelled','timed_out','interrupted','budget_exhausted'].includes(node.data.status),'导入任务证据必须是只读终结记录');if(Buffer.byteLength(JSON.stringify(node.data),'utf8')>2*1024*1024)throw problem('单份任务证据超过 2 MiB',413);}
  required(index.size>0,'资产包为空');return g;
}
export function assetDestinationFingerprint(directory){guardAssets(directory);const records=[['profiles.json',fileDigest(path.join(directory,'profiles.json'))],['studio/bindings.json',fileDigest(path.join(directory,'studio/bindings.json'))]];
  for(const type of ['suites','scenarios','imported-bindings','imported-evidence']){const dir=path.join(directory,'studio',type);if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).sort())if(/\.json$/.test(name))records.push(['studio/'+type+'/'+name,fileDigest(path.join(dir,name))]);}return digestJSON(records);
}
function planImport(directory,state,bundle,id,stamp){
  guardAssets(directory);if(state.storage?.error)throw problem('目标配置文件不可读，已阻止导入，请先恢复备份',409);const g=validateAssetPackage(bundle),pTaken=new Set(state.profiles.map(p=>p.id)),rTaken=new Set(state.ruleSets.map(r=>r.id)),mapping={},files=[],profiles=[],rules=[],suiteRecords=new Map(),summaries={};
  const add=(relative,data)=>{required(fileDigest(path.join(directory,relative))===null,'目标 ID 意外冲突，请重新预览');files.push({path:relative,data,beforeHash:null});};
  for(const n of g.rules){let target='r-'+digestJSON({id,key:n.key}).slice(0,18);required(!rTaken.has(target),'规则 ID 意外冲突');rTaken.add(target);mapping[n.key]=target;rules.push({...normalizeRule(n.asset),id:target,version:1});}
  for(const n of g.profiles){let target='p-'+digestJSON({id,key:n.key}).slice(0,18);required(!pTaken.has(target),'配置 ID 意外冲突');pTaken.add(target);mapping[n.key]=target;profiles.push({...normalizeProfile(n.asset),id:target,version:1,ruleIds:n.ruleKeys.map(key=>mapping[key])});}
  required(state.profiles.length+profiles.length<=20,'导入后的配置超过 20 套，请减少范围或先整理目标工作台');required(state.ruleSets.length+rules.length<=50,'导入后的规则超过 50 条');
  const existingSuites=new SuiteStore(directory).list(),existingScenes=new ScenarioStore(directory).list();required(!existingSuites.warning&&!existingScenes.warning,'目标有不可读资产，请先修复后再导入');
  required(existingSuites.suites.length+g.suites.length<=20,'导入后的测试集超过 20 份');required(existingScenes.scenarios.length+g.scenarios.length<=10,'导入后的场景超过 10 份');
  for(const n of g.suites){const data=normalizeSuite(n.asset),target='s-'+uid(id,'suite',n.key),record={version:n.asset.version,id:target,revision:1,...data,hash:inputDigest(data),origin:'imported',createdAt:stamp,updatedAt:stamp,validationUses:Math.max(1,n.asset.validationUses||0)};mapping[n.key]=target;suiteRecords.set(n.key,record);add('studio/suites/'+target+'.json',record);}
  for(const n of g.scenarios){const profile=profiles.find(p=>p.id===mapping[n.profileKey]),suite=suiteRecords.get(n.suiteKey),ruleSets=profile.ruleIds.map(id=>rules.find(r=>r.id===id));const data={name:n.name,profile,ruleSets,suite,sourceKey:scenarioSourceKey(profile,ruleSets,suite),route:routeOf(n.route),targetRoute:routeOf(n.targetRoute),judgeRoute:routeOf(n.judgeRoute),budget:normalizeBudget(n.budget),commonContext:n.commonContext};const target='c-'+uid(id,'scenario',n.key);mapping[n.key]=target;add('studio/scenarios/'+target+'.json',{version:1,id:target,data,hash:inputDigest(data),createdAt:stamp});}
  for(const n of g.bindingHints){const target='h-'+uid(id,'hint',n.key),data={version:1,id:target,profileId:mapping[n.profileKey],originSessionId:n.originSessionId,workspace:n.workspace,inactive:true,createdAt:stamp};mapping[n.key]=target;add('studio/imported-bindings/'+target+'.json',data);}
  for(const n of g.evidence){const target='e-'+uid(id,'evidence',n.key),data={version:1,id:target,data:n.data,createdAt:stamp,readOnly:true,originBundle:bundle.digest};mapping[n.key]=target;add('studio/imported-evidence/'+target+'.json',data);}
  for(const [kind,folder,limit]of [['bindingHints','imported-bindings',20],['evidence','imported-evidence',20]]){const dir=path.join(directory,'studio',folder),count=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>/\.json$/.test(n)).length:0;required(count+g[kind].length<=limit,'导入后的'+kind+'超过 '+limit+' 份');}
  const before=normalizeStore({schemaVersion:2,storeVersion:state.storage.storeVersion,selected:state.selected,profiles:state.profiles,ruleSets:state.ruleSets}),after=normalizeStore({...before,storeVersion:before.storeVersion+1,profiles:[...before.profiles,...profiles],ruleSets:[...before.ruleSets,...rules]});
  const disk=loadStore(path.join(directory,'profiles.json'),state.profiles.map(p=>({...p,ruleIds:[]})));if(disk.error||(disk.fingerprint!==null&&digestJSON(disk.data)!==digestJSON(before)))throw problem('磁盘配置与已载入状态不一致，请重新加载后再导入',409);
  const revision=makeRevisionRecord(before,after,fileDigest(path.join(directory,'profiles.json')),{id:'v-'+uid(id,'revision','assets'),createdAt:stamp});revision.status='committed';if(Buffer.byteLength(JSON.stringify(revision,null,2),'utf8')>REVISION_LIMITS.bytes)throw problem('导入前后版本快照超过 32 MiB，请减少范围',413);
  files.push({path:'studio/revisions/'+revision.id+'.json',data:revision,beforeHash:null});
  files.push({path:'profiles.json',data:after,beforeHash:fileDigest(path.join(directory,'profiles.json'))});
  for(const k of categories)summaries[k]=g[k].length;
  const receipt={importId:id,revisionId:revision.id,bundleHash:bundle.digest,counts:summaries,mapping,profileIds:profiles.map(p=>p.id),ruleIds:rules.map(r=>r.id),suiteIds:g.suites.map(n=>mapping[n.key]),scenarioIds:g.scenarios.map(n=>mapping[n.key]),bindingHintIds:g.bindingHints.map(n=>mapping[n.key]),evidenceIds:g.evidence.map(n=>mapping[n.key]),activated:false,bound:false};
  return {files,receipt,after};
}
function preserveLegacyCore(directory,state,plan,id){
  const core=plan.files.find(f=>f.path==='profiles.json');if(!state.storage.needsMigration||core.beforeHash===null)return;
  const source=assetPath(directory,'profiles.json');if(fileDigest(source)!==core.beforeHash)throw problem('磁盘配置已变化，请重新预览',409);
  const version=JSON.parse(fs.readFileSync(source,'utf8')).schemaVersion??0,destination=assetPath(directory,'backups','profiles-v'+version+'-assets-'+id+'.json');fs.mkdirSync(path.dirname(destination),{recursive:true});
  if(!fs.existsSync(destination)){fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);}if(fileDigest(destination)!==core.beforeHash)throw problem('迁移备份与原文件不一致，已阻止提交',409);
}
function sign(body){const text=Buffer.from(JSON.stringify(body)).toString('base64url');return text+'.'+createHmac('sha256',secret).update(text).digest('hex');}
function decode(token,verify=true){required(typeof token==='string'&&token.length<3000,'导入预览凭据无效');required(token.split('.').length===2,'导入预览凭据无效');const [text,mac]=token.split('.');required(/^[a-f0-9]{64}$/.test(mac||''),'导入预览凭据无效');if(verify){const expected=createHmac('sha256',secret).update(text).digest('hex');required(timingSafeEqual(Buffer.from(expected),Buffer.from(mac)),'服务已重新加载或预览不匹配，请重新预览');}let body;try{body=JSON.parse(Buffer.from(text,'base64url').toString());}catch{throw problem('导入预览无法解析');}required(uuid(body.id)&&typeof body.createdAt==='string','导入预览身份无效');return body;}
export function previewAssetImport(directory,state,bundle){recoverAssetImports(directory);const id=randomUUID(),stamp=new Date().toISOString(),plan=planImport(directory,state,bundle,id,stamp),body={id,createdAt:stamp,bundleHash:bundle.digest,destination:assetDestinationFingerprint(directory),planHash:digestJSON(plan),expiresAt:Date.now()+20*60*1000};return {ok:true,preview:{counts:plan.receipt.counts,profiles:plan.after.profiles.filter(p=>plan.receipt.profileIds.includes(p.id)).map(p=>({id:p.id,name:p.name})),bindingHintsInactive:true,evidenceReadOnly:true,validationIndependence:'导入测试集的独立性未核实，首次试跑按探索性结果标记',selectedUnchanged:state.selected,sourceRawIncluded:bundle.options?.evidence===true},token:sign(body)};}
export function importAssetPackage(directory,state,bundle,token,options={}){validateAssetPackage(bundle);const decoded=decode(token,false),prior=assetImportReceipt(directory,decoded.id);if(prior){required(prior.bundleHash===bundle.digest,'此导入标识对应不同内容');return {...prior.receipt,alreadyApplied:true};}
  const body=decode(token);required(body.bundleHash===bundle.digest&&body.expiresAt>=Date.now(),'材料已变化或预览过期，请重新预览');if(body.destination!==assetDestinationFingerprint(directory))throw problem('目标资产已变化，请重新预览',409);const plan=planImport(directory,state,bundle,body.id,body.createdAt);required(body.planHash===digestJSON(plan),'预览与当前提交计划不一致，请重新预览');preserveLegacyCore(directory,state,plan,body.id);const revision=plan.files.find(f=>f.path.startsWith('studio/revisions/'));new RevisionStore(directory).prune(Buffer.byteLength(JSON.stringify(revision.data,null,2),'utf8'),1);return commitAssetImport(directory,{id:body.id,bundleHash:bundle.digest,files:plan.files,receipt:plan.receipt},options);}
export function importedAssetRecords(directory){guardAssets(directory);const result={ok:true,bindingHints:[],evidence:[]};for(const [key,folder,pattern]of [['bindingHints','imported-bindings',/^h-[a-f0-9-]{36}\.json$/],['evidence','imported-evidence',/^e-[a-f0-9-]{36}\.json$/]]){const dir=path.join(directory,'studio',folder);if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(n=>pattern.test(n)).sort()){const record=readJson(path.join(dir,name),2*1024*1024);result[key].push(record);}}return result;}

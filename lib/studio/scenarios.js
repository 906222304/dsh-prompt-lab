/** Saved combinations of existing assets and trial settings; load never activates or calls a model. */
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {atomicWrite,problem,normalizeProfile,normalizeRule} from '../store.js';
import {inputDigest,draftKey,routeOf} from './contracts.js';
import {normalizeBudget} from './experiments.js';
const MAX_BYTES=2*1024*1024;
export const scenarioSourceKey=(profile,ruleSets,suite)=>inputDigest({profile:normalizeProfile(profile),ruleSets:ruleSets.map(normalizeRule),suite:{id:suite.id,revision:suite.revision,hash:suite.hash}});
const legacySourceKey=(profile,ruleSets,suite)=>inputDigest({profile,ruleSets,suite:{id:suite.id,revision:suite.revision,hash:suite.hash}});
export class ScenarioStore{
  constructor(directory){this.directory=path.join(directory,'studio','scenarios');}
  file(id){if(typeof id!=='string'||!/^c-[a-f0-9-]{36}$/.test(id))throw problem('场景 id 无效');return path.join(this.directory,id+'.json');}
  get(id){const file=this.file(id);if(!fs.existsSync(file))throw problem('场景不存在',404);if(fs.statSync(file).size>MAX_BYTES)throw problem('场景文件过大',409);
    const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version!==1||value.id!==id||value.hash!==inputDigest(value.data))throw problem('场景快照损坏，已保留原文件',409);return value;}
  list(){const scenarios=[];let warning=null;if(fs.existsSync(this.directory))for(const name of fs.readdirSync(this.directory))if(/^c-[a-f0-9-]{36}\.json$/.test(name))try{const v=this.get(name.slice(0,-5));scenarios.push({id:v.id,name:v.data.name,profileName:v.data.profile.name,suiteName:v.data.suite.name,hash:v.hash,createdAt:v.createdAt});}catch{warning='部分场景记录无法读取，原文件已保留';}
    return {ok:true,scenarios:scenarios.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),warning,limit:10};}
  save(request,state,suites){
    if(this.list().scenarios.length>=10)throw problem('最多保存 10 个场景，请先删除旧场景');
    if(typeof request.name!=='string'||!request.name.trim()||request.name.length>80)throw problem('请填写不超过 80 字的场景名称');
    const profile=state.profiles.find(p=>p.id===request.profileId);
    if(!profile||profile.version!==request.profileVersion||draftKey(profile)!==draftKey(request.draft||{}))throw problem('场景使用已保存版本；请先保存草稿并重新载入配置',409);
    const ruleSets=profile.ruleIds.map(id=>state.ruleSets.find(r=>r.id===id)),suite=suites.get(request.suiteId);
    if(suite.revision!==request.suiteRevision)throw problem('测试集已变化，请重新载入',409);
    if(typeof request.commonContext!=='string'||request.commonContext.length>8000)throw problem('共同背景无效');
    const data={name:request.name.trim(),profile,ruleSets,suite,sourceKey:scenarioSourceKey(profile,ruleSets,suite),route:routeOf(request.route),targetRoute:routeOf(request.targetRoute),judgeRoute:routeOf(request.judgeRoute),budget:normalizeBudget(request.budget),commonContext:request.commonContext};
    if(Buffer.byteLength(JSON.stringify(data),'utf8')>MAX_BYTES-2000)throw problem('场景超过 2 MiB 预算',413);
    const record={version:1,id:'c-'+randomUUID(),data,hash:inputDigest(data),createdAt:new Date().toISOString()};atomicWrite(this.file(record.id),record);return {ok:true,scenario:record};
  }
  preview(id,state,suites){const scenario=this.get(id),data=scenario.data;let reason=null;
    try{const profile=state.profiles.find(p=>p.id===data.profile.id);if(!profile)throw problem('原配置已删除');const rules=profile.ruleIds.map(id=>state.ruleSets.find(r=>r.id===id)),suite=suites.get(data.suite.id);
      const frozenKey=scenarioSourceKey(data.profile,data.ruleSets,data.suite);if(![frozenKey,legacySourceKey(data.profile,data.ruleSets,data.suite)].includes(data.sourceKey)||scenarioSourceKey(profile,rules,suite)!==frozenKey)throw problem('原配置、共享规则或测试集已变化；请恢复匹配资产版本，或使用最新资产另存场景');
    }catch(error){reason=String(error.message);}
    return {ok:true,scenario,canApply:!reason,reason};
  }
  refreshPreview(request,state,suites){
    const scenario=this.get(request.id),old=scenario.data,profile=state.profiles.find(p=>p.id===(request.profileId||old.profile.id));
    if(!profile)throw problem('原配置已删除，请明确选择替代配置',409);
    const suite=suites.get(request.suiteId||old.suite.id),ruleSets=profile.ruleIds.map(id=>state.ruleSets.find(r=>r.id===id));
    const name=request.name||old.name.slice(0,76)+' 更新';if(typeof name!=='string'||!name.trim()||name.length>80)throw problem('新场景名称须为 1–80 字');
    const data={name:name.trim(),profile,ruleSets,suite,sourceKey:scenarioSourceKey(profile,ruleSets,suite),route:routeOf(request.route||old.route),targetRoute:routeOf(request.targetRoute||old.targetRoute),judgeRoute:routeOf(request.judgeRoute||old.judgeRoute),budget:normalizeBudget(request.budget||old.budget),commonContext:request.commonContext??old.commonContext};
    if(typeof data.commonContext!=='string'||data.commonContext.length>8000)throw problem('共同背景无效');
    const fields=[['profile','配置正文与开关',normalizeProfile(old.profile),normalizeProfile(profile)],['rules','共享规则版本、内容与顺序',old.ruleSets.map(normalizeRule),ruleSets.map(normalizeRule)],['suite','测试集修订与检查标准',{id:old.suite.id,revision:old.suite.revision,hash:old.suite.hash},{id:suite.id,revision:suite.revision,hash:suite.hash}],['route','生成模型',old.route,data.route],['targetRoute','测试模型',old.targetRoute,data.targetRoute],['judgeRoute','评分模型',old.judgeRoute,data.judgeRoute],['budget','调用与输出预算',old.budget,data.budget],['commonContext','共同背景',old.commonContext,data.commonContext]];
    const changes=fields.filter(([, ,a,b])=>inputDigest(a)!==inputDigest(b)).map(([field,label,before,after])=>({field,label,before,after}));
    return {ok:true,originalId:scenario.id,originalHash:scenario.hash,hash:inputDigest(data),changes,data,warning:'仅生成更新预览；确认后另存场景，不改变旧场景或沿用旧评测结论'};
  }
  refresh(request,state,suites){
    if(request.confirm!==true)throw problem('请核对差异后确认另存场景');const proposal=this.refreshPreview(request,state,suites);
    if(proposal.originalHash!==request.originalHash||proposal.hash!==request.previewHash)throw problem('源资产、参数或旧场景已变化，请重新查看更新差异',409);
    const d=proposal.data;return this.save({name:d.name,profileId:d.profile.id,profileVersion:d.profile.version,draft:d.profile,suiteId:d.suite.id,suiteRevision:d.suite.revision,route:d.route,targetRoute:d.targetRoute,judgeRoute:d.judgeRoute,budget:d.budget,commonContext:d.commonContext},state,suites);
  }
  load(request,state,suites,providers){const result=this.preview(request.id,state,suites);
    if(!result.canApply||request.hash!==result.scenario.hash)throw problem(result.reason||'场景已变化，请重新预览',409);
    if(!providers||[result.scenario.data.route,result.scenario.data.targetRoute,result.scenario.data.judgeRoute].some(r=>!providers.some(p=>p.id===r.provider)))throw problem('场景引用的模型供应商不可用，请核对宿主模型设置',409);
    return result;
  }
  remove(request){const record=this.get(request.id);if(record.hash!==request.hash)throw problem('场景已变化，请重新载入',409);fs.unlinkSync(this.file(request.id));return {ok:true};}
}

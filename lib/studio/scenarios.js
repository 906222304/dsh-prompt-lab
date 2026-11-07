/** Saved combinations of existing assets and trial settings; load never activates or calls a model. */
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {atomicWrite,problem} from '../store.js';
import {inputDigest,draftKey,routeOf} from './contracts.js';
import {normalizeBudget} from './experiments.js';
const MAX_BYTES=2*1024*1024;
const sourceKey=(profile,ruleSets,suite)=>inputDigest({profile,ruleSets,suite:{id:suite.id,revision:suite.revision,hash:suite.hash}});
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
    const data={name:request.name.trim(),profile,ruleSets,suite,sourceKey:sourceKey(profile,ruleSets,suite),route:routeOf(request.route),targetRoute:routeOf(request.targetRoute),judgeRoute:routeOf(request.judgeRoute),budget:normalizeBudget(request.budget),commonContext:request.commonContext};
    if(Buffer.byteLength(JSON.stringify(data),'utf8')>MAX_BYTES-2000)throw problem('场景超过 2 MiB 预算',413);
    const record={version:1,id:'c-'+randomUUID(),data,hash:inputDigest(data),createdAt:new Date().toISOString()};atomicWrite(this.file(record.id),record);return {ok:true,scenario:record};
  }
  preview(id,state,suites){const scenario=this.get(id),data=scenario.data;let reason=null;
    try{const profile=state.profiles.find(p=>p.id===data.profile.id);if(!profile)throw problem('原配置已删除');const rules=profile.ruleIds.map(id=>state.ruleSets.find(r=>r.id===id)),suite=suites.get(data.suite.id);
      if(sourceKey(profile,rules,suite)!==data.sourceKey)throw problem('原配置、共享规则或测试集已变化；请恢复匹配资产版本，或使用最新资产另存场景');
    }catch(error){reason=String(error.message);}
    return {ok:true,scenario,canApply:!reason,reason};
  }
  load(request,state,suites,providers){const result=this.preview(request.id,state,suites);
    if(!result.canApply||request.hash!==result.scenario.hash)throw problem(result.reason||'场景已变化，请重新预览',409);
    if(!providers||[result.scenario.data.route,result.scenario.data.targetRoute,result.scenario.data.judgeRoute].some(r=>!providers.some(p=>p.id===r.provider)))throw problem('场景引用的模型供应商不可用，请核对宿主模型设置',409);
    return result;
  }
  remove(request){const record=this.get(request.id);if(record.hash!==request.hash)throw problem('场景已变化，请重新载入',409);fs.unlinkSync(this.file(request.id));return {ok:true};}
}

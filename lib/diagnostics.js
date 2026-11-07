/** Compact provenance; observations are never promoted into final-request evidence. */
import { createHash } from 'node:crypto';
export const textHash=text=>createHash('sha256').update(text).digest('hex');
const normalize=text=>text.replace(/\s+/gu,' ').trim();
export function contextIdentity(context){
  const id=context?.agent?.session?.id??context?.sessionId;
  return typeof id==='string'&&id.length>0&&id.length<=200?{sessionId:id}:{};
}
export function injectionDiagnostics({profiles,ruleSets,selected,status,configRevision,storeVersion,evaluation,assembly}){
  const profile=profiles.find(p=>p.id===selected),sources=[];
  if(profile){
    const gate=profile.rulesEnabled&&(!profile.promptEnabled||profile.prompt.trim());
    const add=(kind,id,version,name,text,enabled,reason)=>sources.push({kind,id,version,name,hash:textHash(text),chars:text.length,included:status.enabled!==false&&enabled&&!!text.trim(),reason:status.enabled===false?'插件注入关闭':!text.trim()?'内容为空':!enabled?reason:'参与当前配置预览'});
    add('prompt',profile.id,profile.version,profile.name+' · 正文',profile.prompt,profile.promptEnabled,'正文段关闭');
    add('attached',profile.id,profile.version,'配置附加规则',profile.rules,gate,'规则段关闭或启用的正文为空');
    for(const id of profile.ruleIds){const rule=ruleSets.find(r=>r.id===id);if(rule)add('shared',id,rule.version,rule.name,rule.text,gate&&rule.enabled,!rule.enabled?'共享规则已停用':'规则段关闭或启用的正文为空');}
  }
  const duplicate=[],own=new Set(['prompt-lab:custom','prompt-lab:rules']);
  if(assembly){
    const others=[...(assembly.sections||[]),...(assembly.contexts||[])].filter(s=>!own.has(s.name)).map(s=>({name:s.name,text:normalize(s.text||'')}));
    const ownBodies=(assembly.sections||[]).filter(s=>own.has(s.name)).map(s=>normalize(s.text||''));
    for(const source of sources.filter(s=>s.included)){
      const raw=source.kind==='prompt'?profile.prompt:source.kind==='attached'?profile.rules:ruleSets.find(r=>r.id===source.id).text,needle=normalize(raw);
      if(needle.length<20||!ownBodies.some(text=>text.includes(needle)))continue;
      for(const other of others){if(other.text.includes(needle))duplicate.push({sourceId:source.id,sourceName:source.name,other:other.name,kind:'normalized-exact',hash:source.hash});}
    }
  }
  return {saved:{storeVersion,configRevision,profileId:selected,profileVersion:profile?.version},
    registered:status.registered,sections:[{name:'prompt-lab:custom',order:5100},{name:'prompt-lab:rules',order:5101}],sources,
    evaluated:evaluation?{...evaluation,text:undefined,hash:textHash(evaluation.text),stale:evaluation.configRevision!==configRevision}:null,
    observed:assembly?{at:assembly.capturedAt,configRevision:assembly.configRevision,sessionId:assembly.sessionId||null,scope:assembly.scope,stale:assembly.configRevision!==configRevision,truncated:assembly.truncated}:null,
    requestEvidence:{verified:false,reason:'未取得模型 API 最终请求证据；求值和组装观察不能证明最终发送内容'},
    duplicates:duplicate,duplicateCoverage:!assembly?'未观察到组装':assembly.configRevision!==configRevision?'旧配置观察，仅供参考':assembly.truncated?'观察已截断，未命中不能排除重复':'仅检查可见组装中的规范化原文重复；未进行语义判定'};
}

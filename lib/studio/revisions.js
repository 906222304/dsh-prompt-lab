import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, digest, fileDigest, problem, normalizeStore } from '../store.js';

export const REVISION_LIMITS=Object.freeze({count:30,bytes:32*1024*1024});
const idPattern=/^v-[a-f0-9-]{36}$/;
const payload=r=>({version:r.version,id:r.id,createdAt:r.createdAt,before:r.before,after:r.after,changes:r.changes,beforeFingerprint:r.beforeFingerprint,afterFingerprint:r.afterFingerprint});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class RevisionStore {
  constructor(directory){this.directory=path.join(directory,'studio','revisions');this.profileFile=path.join(directory,'profiles.json');}
  file(id){if(!idPattern.test(id))throw problem('版本 id 无效');return path.join(this.directory,id+'.json');}
  entries(){
    if(!fs.existsSync(this.directory))return [];
    const entries=[];
    for(const name of fs.readdirSync(this.directory)){
      if(!idPattern.test(name.slice(0,-5))||!name.endsWith('.json'))continue;
      const file=path.join(this.directory,name),size=fs.statSync(file).size;
      if(size>REVISION_LIMITS.bytes)throw problem('版本文件超过读取预算，原文件已保留',409);
      const r=JSON.parse(fs.readFileSync(file,'utf8'));
      if(r.version!==1||r.id!==name.slice(0,-5)||!['prepared','committed','aborted'].includes(r.status)||r.digest!==digest(Buffer.from(JSON.stringify(payload(r)))))throw problem('版本记录损坏或格式未知，原文件已保留',409);
      entries.push(r);
    }
    // A prepared record is committed only with a persisted after-image or a proven later chain.
    const known=new Set([fileDigest(this.profileFile)]);
    for(const r of entries)if(r.status==='committed'){known.add(r.afterFingerprint);known.add(r.beforeFingerprint);}
    let advanced=true;
    while(advanced){advanced=false;for(const r of entries)if(r.status==='prepared'&&known.has(r.afterFingerprint)){
      r.status='committed';atomicWrite(this.file(r.id),r);known.add(r.beforeFingerprint);advanced=true;
    }}
    return entries.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  }
  prepare(before,after,beforeFingerprint){
    const changedRules=[...new Set([...before.ruleSets.map(r=>r.id),...after.ruleSets.map(r=>r.id)])].filter(id=>!same(before.ruleSets.find(r=>r.id===id),after.ruleSets.find(r=>r.id===id)));
    const changedProfiles=[...new Set([...before.profiles.map(p=>p.id),...after.profiles.map(p=>p.id)])].filter(id=>{
      const a=before.profiles.find(p=>p.id===id),b=after.profiles.find(p=>p.id===id);
      return !same(a,b)||a?.ruleIds.some(r=>changedRules.includes(r))||b?.ruleIds.some(r=>changedRules.includes(r));
    });
    const record={version:1,id:'v-'+randomUUID(),createdAt:new Date().toISOString(),status:'prepared',before,after,
      beforeFingerprint,afterFingerprint:digest(Buffer.from(JSON.stringify(after,null,2))),
      changes:{profiles:changedProfiles,rules:changedRules,selection:before.selected!==after.selected}};
    record.digest=digest(Buffer.from(JSON.stringify(payload(record))));
    if(Buffer.byteLength(JSON.stringify(record),'utf8')>REVISION_LIMITS.bytes)throw problem('版本快照超过 32 MiB 预算');
    // Inspect prior records first; never overwrite a damaged/unknown journal.
    this.entries();atomicWrite(this.file(record.id),record);return record;
  }
  finish(record,committed){if(!record)return;record.status=committed?'committed':'aborted';atomicWrite(this.file(record.id),record);this.prune();}
  prune(){
    const entries=this.entries();let bytes=0,count=0;
    for(const r of entries){const size=fs.statSync(this.file(r.id)).size;if(r.status==='prepared')continue;
      count++;bytes+=size;if(count>REVISION_LIMITS.count||bytes>REVISION_LIMITS.bytes)fs.unlinkSync(this.file(r.id));}
  }
  list(profileId){
    const entries=this.entries();
    return {ok:true,limits:REVISION_LIMITS,pending:entries.filter(r=>r.status==='prepared').length,revisions:entries.filter(r=>r.status==='committed'&&(!profileId||r.changes.profiles.includes(profileId))).map(r=>({
      id:r.id,createdAt:r.createdAt,changes:r.changes,storeVersion:r.after.storeVersion,
      profiles:[...new Map([...r.before.profiles,...r.after.profiles].map(p=>[p.id,{id:p.id,name:p.name}])).values()],
      rules:[...new Map([...r.before.ruleSets,...r.after.ruleSets].map(rule=>[rule.id,{id:rule.id,name:rule.name}])).values()]}))};
  }
  get(id){this.file(id);const r=this.entries().find(r=>r.id===id);if(!r||r.status!=='committed')throw problem('版本不存在或尚未确认提交',404);return r;}
  graph(id,side,profileId){
    if(!['before','after'].includes(side))throw problem('版本快照方向无效');
    const store=normalizeStore(this.get(id)[side]),profile=store.profiles.find(p=>p.id===profileId);
    if(!profile)throw problem('此快照中没有该配置',404);
    return {profile,ruleSets:profile.ruleIds.map(id=>store.ruleSets.find(r=>r.id===id))};
  }
}

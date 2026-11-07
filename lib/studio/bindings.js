/** Explicit session -> frozen assets. Runtime reads memory; no automatic project routing. */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite,normalizeStore,problem,fileDigest } from '../store.js';
import { inputDigest } from './contracts.js';
const MAX_BYTES=8*1024*1024,MAX_BINDINGS=20;
function identity(sessionId,workspace){
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>200||typeof workspace!=='string'||workspace.length>2000)throw problem('会话或工作目录无效');
  return {sessionId,workspace};
}
export function frozenBinding(profile,rules,session){
  const graph=normalizeStore({schemaVersion:2,storeVersion:1,selected:profile.id,profiles:[profile],ruleSets:profile.ruleIds.map(id=>rules.find(r=>r.id===id))});
  const assets={...identity(session.sessionId,session.workspace),profile:graph.profiles[0],ruleSets:graph.ruleSets};
  return {...assets,hash:inputDigest(assets)};
}
export class BindingStore{
  constructor(directory){
    this.file=path.join(directory,'studio','bindings.json');this.data={version:1,revision:0,bindings:[]};this.error=null;
    try{if(fs.existsSync(this.file)){
      if(fs.statSync(this.file).size>MAX_BYTES)throw problem('绑定文件过大');
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!Array.isArray(data.bindings)||data.bindings.length>MAX_BINDINGS||new Set(data.bindings.map(b=>b.sessionId)).size!==data.bindings.length)throw problem('绑定格式无效');
      for(const item of data.bindings){const frozen=frozenBinding(item.profile,item.ruleSets,item);if(frozen.hash!==item.hash)throw problem('绑定快照哈希不一致');}
      this.data=data;
    }this.fingerprint=fileDigest(this.file);}catch{this.error='会话绑定记录不可用；已阻止覆盖，并暂停带会话身份的补充段，避免错误套用全局配置';}
  }
  resolve(sessionId){return this.data.bindings.find(b=>b.sessionId===sessionId)||null;}
  snapshot(){return {revision:this.data.revision,error:this.error,limit:MAX_BINDINGS,bindings:this.data.bindings.map(b=>({sessionId:b.sessionId,workspace:b.workspace,profileId:b.profile.id,profileName:b.profile.name,profileVersion:b.profile.version,ruleVersions:b.ruleSets.map(r=>({id:r.id,name:r.name,version:r.version})),hash:b.hash,updatedAt:b.updatedAt}))};}
  commit(request,draft){
    if(this.error)throw problem(this.error,409);
    if(request.expectedRevision!==this.data.revision||fileDigest(this.file)!==this.fingerprint)throw problem('会话绑定已变化，请重新载入并预览',409);
    let bindings=this.data.bindings.filter(b=>b.sessionId!==request.sessionId);
    if(request.action==='binding.save'){
      if(request.confirm!==true||!draft||request.hash!==draft.hash)throw problem('配置、规则或项目已变化，请重新预览绑定',409);
      if(bindings.length>=MAX_BINDINGS)throw problem('最多绑定 20 个会话，请先解除旧绑定');
      bindings.push({...draft,updatedAt:new Date().toISOString()});
    }
    const next={version:1,revision:this.data.revision+1,bindings};
    if(Buffer.byteLength(JSON.stringify(next),'utf8')>MAX_BYTES)throw problem('绑定快照超过存储预算',413);
    atomicWrite(this.file,next);this.data=next;this.fingerprint=fileDigest(this.file);return this.snapshot();
  }
}

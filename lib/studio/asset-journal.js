/** Crash-recoverable append import. All readers enter through the recovery gate. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite,fileDigest,problem} from '../store.js';
export const digestJSON=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)).digest('hex');
const uuid=/^[a-f0-9-]{36}$/;
const allowed=/^(?:profiles\.json|studio\/(?:suites\/s-|scenarios\/c-|imported-bindings\/h-|imported-evidence\/e-|revisions\/v-)[a-f0-9-]{36}\.json)$/;
const MAX_JOURNAL_BYTES=96*1024*1024;
const fileHash=data=>createHash('sha256').update(JSON.stringify(data,null,2),'utf8').digest('hex');
export function assetPath(root,...parts){
  const base=path.resolve(root),target=path.resolve(base,...parts),rel=path.relative(base,target);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw problem('资产路径越界',409);
  let cursor=base;for(const part of rel.split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);try{if(fs.lstatSync(cursor).isSymbolicLink())throw problem('资产路径经过链接，已阻止访问',409);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return target;
}
function location(root,relative){
  if(typeof relative!=='string'||!allowed.test(relative))throw problem('资产事务路径无效',409);
  const base=path.resolve(root),target=path.resolve(base,...relative.split('/')),rel=path.relative(base,target);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw problem('资产事务路径越界',409);
  let cursor=base;for(const part of rel.split(path.sep)){cursor=path.join(cursor,part);if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw problem('资产路径经过链接，已阻止写入',409);}
  return target;
}
function journalPath(root,id){if(typeof id!=='string'||!uuid.test(id))throw problem('导入事务 ID 无效');let current=path.resolve(root);for(const part of ['studio','imports','i-'+id,'journal.json']){current=path.join(current,part);if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw problem('事务目录经过链接，已阻止访问',409);}return current;}
function read(root,id){const file=journalPath(root,id);if(!fs.existsSync(file))return null;if(fs.statSync(file).size>MAX_JOURNAL_BYTES)throw problem('资产事务记录过大，已保留原文件',409);
  let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw problem('资产事务记录损坏，须先恢复备份',409);}
  const {digest,...body}=value;if(value.version!==1||value.id!==id||!['prepared','committed'].includes(value.phase)||digest!==digestJSON(body))throw problem('资产事务校验失败，已阻止读取不完整资产',409);return value;
}
function write(root,id,value){atomicWrite(journalPath(root,id),{...value,digest:digestJSON(value)});}
export function assetImportReceipt(root,id){const record=read(root,id);return record?.phase==='committed'?record:null;}
function finish(root,record,faultAfter){
  if(!Array.isArray(record.files)||!record.files.length||record.files.length>100||new Set(record.files.map(f=>f.path)).size!==record.files.length)throw problem('资产事务目标清单无效',409);
  for(const file of record.files){const target=location(root,file.path);if(fileHash(file.data)!==file.afterHash)throw problem('资产暂存内容校验失败',409);const current=fileDigest(target);if(current!==file.beforeHash&&current!==file.afterHash)throw problem('资产在导入期间被外部修改，已暂停恢复，请核对备份',409);}
  let writes=0;
  for(const file of record.files){const target=location(root,file.path),current=fileDigest(target);if(current===file.afterHash)continue;if(current!==file.beforeHash)throw problem('资产在提交期间变化，须恢复事务后再读取',409);
    atomicWrite(target,file.data);writes++;if(faultAfter&&writes===faultAfter)throw problem('模拟写盘中断：导入将在下次读取前恢复',503);
  }
  const completed={version:1,id:record.id,phase:'committed',bundleHash:record.bundleHash,createdAt:record.createdAt,completedAt:new Date().toISOString(),receipt:record.receipt,files:record.files.map(({path,afterHash})=>({path,afterHash}))};
  write(root,record.id,completed);return completed;
}
export function recoverAssetImports(root){
  const directory=assetPath(root,'studio','imports');if(!fs.existsSync(directory))return 0;let recovered=0;
  for(const name of fs.readdirSync(directory).sort())if(/^i-[a-f0-9-]{36}$/.test(name)){const record=read(root,name.slice(2));if(record?.phase==='prepared'){finish(root,record);recovered++;}}
  return recovered;
}
export function commitAssetImport(root,{id,bundleHash,files,receipt},options={}){
  const existing=assetImportReceipt(root,id);if(existing){if(existing.bundleHash!==bundleHash)throw problem('导入标识对应其他内容',409);return {...existing.receipt,alreadyApplied:true};}
  recoverAssetImports(root);
  const recovered=assetImportReceipt(root,id);if(recovered){if(recovered.bundleHash!==bundleHash)throw problem('导入标识对应其他内容',409);return {...recovered.receipt,alreadyApplied:true};}
  const entries=files.map(file=>({path:file.path,data:file.data,beforeHash:file.beforeHash,afterHash:fileHash(file.data)}));
  for(const file of entries){const target=location(root,file.path);if(fileDigest(target)!==file.beforeHash)throw problem('目标资产已变化，请重新预览导入',409);}
  const record={version:1,id,phase:'prepared',bundleHash,createdAt:new Date().toISOString(),files:entries,receipt};
  if(Buffer.byteLength(JSON.stringify(record),'utf8')>MAX_JOURNAL_BYTES)throw problem('导入事务超过暂存预算',413);
  write(root,id,record);return finish(root,record,options.faultAfter).receipt;
}

/** Explicit, bounded project-instruction reads. No workspace writes or implicit scan. */
import fs from 'node:fs';
import path from 'node:path';
import { problem } from '../store.js';
import { inputDigest } from './contracts.js';
export const WORKSPACE_LIMITS=Object.freeze({fileBytes:60000,totalBytes:90000,files:16,depth:32});
const names=['AGENTS.md','CLAUDE.md','AGENTS.local.md','CLAUDE.local.md'];
const inside=(root,target)=>{const rel=path.relative(root,target);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
function directory(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.length>2000)throw problem('请填写项目的绝对目录');
  try{const real=fs.realpathSync(value);if(fs.statSync(real).isDirectory())return real;}catch{}
  throw problem('项目目录不存在或无法读取');
}
function scopeOf(request){
  const cwd=directory(request.cwd),explicit=typeof request.root==='string'&&request.root.trim();
  let root=explicit?directory(request.root):cwd;
  if(!explicit){let cursor=cwd;for(let i=0;i<WORKSPACE_LIMITS.depth;i++){
    if(['.git','.hg','.svn'].some(name=>fs.existsSync(path.join(cursor,name)))){root=cursor;break;}
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }}
  if(!inside(root,cwd))throw problem('工作目录必须在所选项目内');
  const chain=[];let cursor=cwd;
  for(let i=0;i<WORKSPACE_LIMITS.depth;i++){
    chain.push(cursor);if(cursor===root)return {root,cwd,chain:chain.reverse()};
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
  throw problem('目录层级超过扫描限制，请选择更近的项目根目录');
}
function readFile(file,root){
  let fd;
  try{
    const real=fs.realpathSync(file);if(!inside(root,real))throw problem('文件实际位置超出项目边界');
    fd=fs.openSync(real,'r');const stat=fs.fstatSync(fd);
    if(!stat.isFile())throw problem('不是普通文件');
    if(stat.size>WORKSPACE_LIMITS.fileBytes)throw problem('文件超过 60,000 字节上限',413);
    const buffer=Buffer.alloc(WORKSPACE_LIMITS.fileBytes+1);let length=0,read;
    while(length<buffer.length&&(read=fs.readSync(fd,buffer,length,buffer.length-length,null)))length+=read;
    if(length>WORKSPACE_LIMITS.fileBytes)throw problem('文件超过读取上限',413);
    if(fs.realpathSync(file)!==real)throw problem('文件链接已变化，请重新预览',409);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));
    return {realPath:real,bytes:length,mtime:stat.mtimeMs,text,hash:inputDigest({path:file,realPath:real,text})};
  }catch(error){if(error.statusCode)throw error;throw problem('文件无法读取或不是有效 UTF-8 文本');}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function scanWorkspace(request){
  const {root,cwd,chain}=scopeOf(request),files=[];
  for(const dir of chain)for(const name of names){
    const file=path.join(dir,name);if(!fs.existsSync(file))continue;
    const base={path:file,name,scope:dir===cwd?'cwd':dir===root?'root':'ancestor',hostLoaded:'unknown'};
    try{const data=readFile(file,root);files.push({...base,...data,preview:data.text.slice(0,240),text:undefined,available:true});}
    catch(error){files.push({...base,available:false,error:error.message});}
  }
  return {ok:true,root,cwd,files,limits:WORKSPACE_LIMITS,note:'只读取项目根到当前目录的四种规范文件；宿主是否已加载未知，不会写回项目文件。'};
}
export function selectWorkspaceSource(request){
  if(!request||!Array.isArray(request.files)||!request.files.length||request.files.length>WORKSPACE_LIMITS.files||new Set(request.files.map(f=>f?.path)).size!==request.files.length)throw problem('请选择 1–16 个项目规范文件');
  const scan=scanWorkspace(request),files=[];let total=0;
  for(const chosen of request.files){
    const candidate=scan.files.find(f=>f.path===chosen?.path);
    if(!candidate?.available||candidate.hash!==chosen.hash)throw problem('所选项目文件已变化或不再可用，请重新扫描预览',409);
    const current=readFile(candidate.path,scan.root);
    if(current.hash!==chosen.hash)throw problem('项目文件在读取时变化，请重新预览',409);
    total+=current.bytes;if(total>WORKSPACE_LIMITS.totalBytes)throw problem('所选文件总计超过 90,000 字节，请减少选择',413);
    files.push({path:candidate.path,name:candidate.name,scope:candidate.scope,hostLoaded:'unknown',...current});
  }
  return {kind:'selected-workspace',root:scan.root,cwd:scan.cwd,files,capturedAt:new Date().toISOString()};
}

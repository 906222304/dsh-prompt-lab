import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, problem } from '../store.js';
import { inputDigest } from './contracts.js';

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const str=(v,label,max,required=false)=>{if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw problem(`${label}无效或过长`);return v;};
export const SUITE_LIMITS=Object.freeze({suites:20,cases:12,bytes:120000});
export function normalizeSuite(value){
  if(!object(value))throw problem('测试集格式无效');
  const name=str(value.name,'测试集名称',80,true).trim();
  if(!Array.isArray(value.cases)||!value.cases.length||value.cases.length>SUITE_LIMITS.cases)throw problem('测试集需要 1–12 个样例');
  const cases=value.cases.map((item,i)=>{
    if(!object(item)||!['train','validation'].includes(item.split))throw problem('每条样例须指定 train 或 validation 分组');
    const id=item.id??'case-'+(i+1);if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,60}$/.test(id))throw problem('样例 id 无效');
    const input=str(item.input,'样例输入',8000,true),reference=str(item.reference??'','参考答案/资料',4000),rubric=str(item.rubric??'','评分标准',2000);
    if(!Array.isArray(item.checks??[])||(item.checks??[]).length>12)throw problem('检查项最多 12 条');
    const checks=(item.checks??[]).map(c=>{
      if(!object(c)||!['contains','notContains','equals','startsWith','isJson','hasKeys','maxChars'].includes(c.type))throw problem('检查类型不支持');
      if(c.type==='isJson')return {type:c.type};
      if(c.type==='maxChars'){if(!Number.isSafeInteger(c.value)||c.value<1||c.value>64000)throw problem('长度上限无效');return {type:c.type,value:c.value};}
      if(c.type==='hasKeys'){if(!Array.isArray(c.value)||!c.value.length||c.value.length>20||c.value.some(k=>typeof k!=='string'||!k||k.length>100))throw problem('JSON 必需字段无效');return {type:c.type,value:[...new Set(c.value)]};}
      return {type:c.type,value:str(c.value,'检查内容',2000,true)};
    });
    if(!checks.length&&!rubric.trim())throw problem('样例至少需要检查项或评分标准，不能把无标准的输出当通过');
    const threshold=item.threshold??0.7;if(typeof threshold!=='number'||!Number.isFinite(threshold)||threshold<0||threshold>1)throw problem('评分阈值须在 0–1');
    return {id,split:item.split,input,reference,checks,rubric,threshold};
  });
  if(new Set(cases.map(c=>c.id)).size!==cases.length)throw problem('样例 id 不能重复');
  const result={name,cases};if(Buffer.byteLength(JSON.stringify(result),'utf8')>SUITE_LIMITS.bytes)throw problem('测试集超过输入预算',413);return result;
}
export class SuiteStore{
  constructor(directory){this.directory=path.join(directory,'studio','suites');}
  file(id){if(typeof id!=='string'||!/^s-[a-f0-9-]{36}$/.test(id))throw problem('测试集 id 无效');return path.join(this.directory,id+'.json');}
  get(id){const file=this.file(id);if(!fs.existsSync(file))throw problem('测试集不存在',404);
    if(fs.statSync(file).size>SUITE_LIMITS.bytes+10000)throw problem('测试集文件超过读取预算',409);
    const value=JSON.parse(fs.readFileSync(file,'utf8')),data=normalizeSuite(value);
    if(value.version!==1||value.id!==id||!Number.isSafeInteger(value.revision)||value.revision<1||value.hash!==inputDigest(data))throw problem('测试集损坏或格式未知，已保留原文件',409);
    return {...value,...data};
  }
  list(){if(!fs.existsSync(this.directory))return {ok:true,suites:[],limits:SUITE_LIMITS};const suites=[];let warning=null;
    for(const name of fs.readdirSync(this.directory))if(/^s-[a-f0-9-]{36}\.json$/.test(name))try{const s=this.get(name.slice(0,-5));suites.push({id:s.id,name:s.name,revision:s.revision,hash:s.hash,cases:s.cases.length,train:s.cases.filter(c=>c.split==='train').length,validation:s.cases.filter(c=>c.split==='validation').length,validationUses:s.validationUses||0,updatedAt:s.updatedAt,origin:s.origin});}catch{warning='部分测试集无法读取，原文件已保留';}
    return {ok:true,suites:suites.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)),limits:SUITE_LIMITS,warning};
  }
  save(request,origin='manual'){
    const data=normalizeSuite(request),old=request.id?this.get(request.id):null;
    if(old&&request.expectedRevision!==old.revision)throw problem('测试集已在其他窗口修改，请重新载入',409);
    if(!old&&this.list().suites.length>=SUITE_LIMITS.suites)throw problem('最多保存 20 个测试集，请先整理');
    const now=new Date().toISOString(),record={version:1,id:old?.id||'s-'+randomUUID(),revision:(old?.revision||0)+1,...data,hash:inputDigest(data),origin:old?.origin||origin,
      createdAt:old?.createdAt||now,updatedAt:now,validationUses:old?.validationUses||0};atomicWrite(this.file(record.id),record);return {ok:true,suite:record};
  }
  useValidation(suite){const current=this.get(suite.id);if(current.hash!==suite.hash)return;current.validationUses=(current.validationUses||0)+1;atomicWrite(this.file(current.id),current);}
  remove(id,revision){const s=this.get(id);if(s.revision!==revision)throw problem('测试集版本已变化',409);fs.unlinkSync(this.file(id));return {ok:true};}
}
export function checkOutput(output,checks){return checks.map(check=>{
  let pass=false,error=null;
  try{switch(check.type){
    case 'contains':pass=output.includes(check.value);break;
    case 'notContains':pass=!output.includes(check.value);break;
    case 'equals':pass=output.trim()===check.value.trim();break;
    case 'startsWith':pass=output.trimStart().startsWith(check.value);break;
    case 'maxChars':pass=output.length<=check.value;break;
    case 'isJson':JSON.parse(output);pass=true;break;
    case 'hasKeys':{const data=JSON.parse(output);pass=object(data)&&check.value.every(key=>Object.hasOwn(data,key));break;}
    default:error='不支持的检查';
  }}catch{error='输出不是合法 JSON';}
  return {...check,pass,reason:pass?'符合要求':error||'不符合要求'};
});}

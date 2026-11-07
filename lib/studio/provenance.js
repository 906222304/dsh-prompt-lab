/** Per-case failure provenance; assistant text remains an unverified claim. */
import { problem } from '../store.js';
import { inputDigest } from './contracts.js';
export function normalizeFailureSource(source,input,split){
  if(!source||source.kind!=='selected-session-failure'||typeof source.sessionId!=='string'||!source.sessionId||source.sessionId.length>200||!Number.isSafeInteger(source.capturedThroughSeq)||source.capturedThroughSeq<0)throw problem('失败样例来源无效');
  if(split!=='train')throw problem('历史失败已用于改写，只能作为训练/回归材料；请另备独立验证样例');
  if(source.inputHash!==inputDigest(input))throw problem('用户输入已修改，不能沿用原失败证据；请恢复原文或移除来源作为手工样例',409);
  if(source.confirmed!==true)throw problem('请先核对并确认失败样例来源与评分标准');
  if(!Array.isArray(source.events)||source.events.length<2||source.events.length>12||new Set(source.events.map(e=>e.seq)).size!==source.events.length)throw problem('来源消息无效');
  const events=source.events.map(e=>{
    if(!Number.isSafeInteger(e.seq)||e.seq<0||e.seq>source.capturedThroughSeq||!['user','assistant'].includes(e.role)||typeof e.text!=='string'||e.text.length>6000||typeof e.hash!=='string'||!/^[a-f0-9]{64}$/.test(e.hash))throw problem('来源消息格式无效');
    if(!e.truncated&&e.hash!==inputDigest(e.text))throw problem('来源文字与消息哈希不一致',409);
    return {seq:e.seq,role:e.role,text:e.text,hash:e.hash,truncated:e.truncated===true};
  });
  const user=events.filter(e=>e.role==='user').map(e=>e.text).join('\n\n'),failure=events.filter(e=>e.role==='assistant').map(e=>e.text).join('\n\n');
  if(!user||!failure||user!==input||failure!==source.failureOutput||failure.length>12000||typeof source.correction!=='string'||!source.correction.trim()||source.correction.length>2000)throw problem('失败原文或纠正意见不完整');
  return {kind:source.kind,sessionId:source.sessionId,capturedThroughSeq:source.capturedThroughSeq,events,inputHash:source.inputHash,failureOutput:failure,correction:source.correction,confidence:'claimed',authority:'operator-input',confirmed:true,...(typeof source.confirmedAt==='string'&&source.confirmedAt.length<40&&Number.isFinite(Date.parse(source.confirmedAt))?{confirmedAt:source.confirmedAt}:{})};
}

import { problem } from '../store.js';
import { inputDigest } from './contracts.js';
let reader=null;
export const currentSessionReader=()=>reader;
export function registerSessionReader(value){reader=value;return()=>{if(reader===value)reader=null;};}
const sessionId=value=>{if(typeof value!=='string'||!value||value.length>200)throw problem('会话 id 无效');return value;};
export function hostSessionReader(query){return {
  async list(){
    const rows=(await query.listSessions()).slice(0,60);
    let titles=[];if(typeof query.readTitleSnapshots==='function')try{titles=await query.readTitleSnapshots(rows.map(r=>r.header.id));}catch{}
    return rows.map((r,i)=>{const title=titles[i]?.status==='fulfilled'?titles[i].value.title:null;
      return {id:r.header.id,createdAt:r.header.createdAt,title:typeof title==='string'?title:typeof title?.title==='string'?title.title:typeof title?.text==='string'?title.text:'',workspace:r.header.cwd||r.header.meta?.cwd||'',live:r.live===true};});
  },
  async preview(id){
    const data=await query.readSurface(sessionId(id));
    const messages=data.events.filter(e=>['user/message','assistant/message'].includes(e.type)).map(e=>{
      const message=e.type==='user/message'?e.data:e.data.message;
      const full=(message?.content||[]).filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n');
      const text=full.slice(0,6000);return {seq:e.seq,role:e.type==='user/message'?'user':'assistant',text,hash:inputDigest(full),truncated:text.length!==full.length};
    }).filter(m=>m.text.trim()).slice(-60);
    return {sessionId:id,capturedThroughSeq:data.capturedThroughSeq,messages};
  },
};}
export async function selectSessionSource(request){
  if(!reader)throw problem('会话读取服务未就绪；可粘贴反馈材料',503);
  if(!Array.isArray(request.events)||!request.events.length||request.events.length>12||new Set(request.events.map(e=>e.seq)).size!==request.events.length)throw problem('请选择 1–12 条会话消息');
  const data=await reader.preview(sessionId(request.sessionId));
  const events=request.events.map(selection=>{
    if(!Number.isSafeInteger(selection.seq)||typeof selection.hash!=='string')throw problem('消息选择无效');
    const item=data.messages.find(m=>m.seq===selection.seq);
    if(!item||item.hash!==selection.hash)throw problem('所选会话消息已变化，请重新预览',409);return item;
  });
  const source={kind:'selected-session',sessionId:data.sessionId,capturedThroughSeq:data.capturedThroughSeq,events};
  if(Buffer.byteLength(JSON.stringify(source),'utf8')>60000)throw problem('所选消息超过材料预算，请减少选择',413);return source;
}

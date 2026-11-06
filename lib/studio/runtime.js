import { snapshot, ensureInitialized, studioStorageDirectory, applyStudioCandidate } from '../state.js';
import { Studio } from './jobs.js';
import { currentBackend, onBackendDisposed } from './model.js';
let engine, directory;
export function studio() {
  ensureInitialized();
  const current=studioStorageDirectory();
  if (!engine || directory!==current) { engine?.dispose(); directory=current;
    engine=new Studio({directory, snapshot, apply:applyStudioCandidate, backend:currentBackend}); }
  return engine;
}
onBackendDisposed(()=>engine?.dispose());
export async function dispatchStudio(req, query, body) {
  const value=studio();
  if (req.method==='GET') {
    if (query.get('kind')==='job') return {ok:true,job:value.get(query.get('id'))};
    return {ok:true,...await value.capabilities(query.get('provider'))};
  }
  if (body.action==='start') return {ok:true,job:value.start(body)};
  if (body.action==='cancel') return {ok:true,job:value.cancel(body.id)};
  if (body.action==='adopt') return value.adopt(body);
  if (body.action==='clear') return value.clear();
  if (body.action==='remove') return value.remove(body.id);
  throw Object.assign(new Error('创作动作无效'),{statusCode:400});
}

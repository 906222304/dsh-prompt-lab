import { snapshot, ensureInitialized, studioStorageDirectory, applyStudioCandidate,restoreStudioRevision,analyzeStudioRules,maintainStudioRules,previewSessionBinding,updateSessionBinding } from '../state.js';
import { Studio } from './jobs.js';
import { currentBackend, onBackendDisposed } from './model.js';
import { RevisionStore } from './revisions.js';
import { currentSessionReader,selectSessionSource } from './sessions.js';
import { problem } from '../store.js';
import { scanWorkspace,selectWorkspaceSource } from './workspace.js';
import { ScenarioStore } from './scenarios.js';
let engine, directory;
export function studio() {
  ensureInitialized();
  const current=studioStorageDirectory();
  if (!engine || directory!==current) { engine?.dispose(); directory=current;
    engine=new Studio({directory, snapshot, apply:applyStudioCandidate, backend:currentBackend}); }
  return engine;
}
onBackendDisposed(()=>{engine?.dispose();engine=undefined;});
export async function dispatchStudio(req, query, body) {
  const value=studio();
  if (req.method==='GET') {
    if(query.get('kind')==='scenarios')return new ScenarioStore(directory).list();
    if(query.get('kind')==='scenario')return new ScenarioStore(directory).preview(query.get('id'),snapshot(),value.suites);
    if (query.get('kind')==='job') return {ok:true,job:value.get(query.get('id'))};
    if(query.get('kind')==='suites')return value.suites.list();
    if(query.get('kind')==='suite')return {ok:true,suite:value.suites.get(query.get('id'))};
    if(query.get('kind')==='versions')return new RevisionStore(directory).list(query.get('profileId'));
    if(query.get('kind')==='revision')return {ok:true,revision:new RevisionStore(directory).get(query.get('id'))};
    if(query.get('kind')==='rules-analysis')return analyzeStudioRules();
    if(['sessions','session'].includes(query.get('kind'))){const reader=currentSessionReader();if(!reader)throw problem('会话服务未就绪，可使用粘贴反馈',503);
      return query.get('kind')==='sessions'?{ok:true,sessions:await reader.list()}:{ok:true,...await reader.preview(query.get('id'))};}
    return {ok:true,sessionAvailable:!!currentSessionReader(),...await value.capabilities(query.get('provider'))};
  }
  if(body.action==='scenario.save')return new ScenarioStore(directory).save(body,snapshot(),value.suites);
  if(body.action==='scenario.load')return new ScenarioStore(directory).load(body,snapshot(),value.suites,currentBackend()?.providers());
  if(body.action==='scenario.remove')return new ScenarioStore(directory).remove(body);
  if(body.action==='binding.remove')return updateSessionBinding(body);
  if(['binding.preview','binding.save'].includes(body.action)){
    const reader=currentSessionReader();if(!reader)throw problem('会话服务未就绪，无法核对绑定目标',503);
    const target=(await reader.list()).find(s=>s.id===body.sessionId);if(!target)throw problem('目标会话不在可核对列表中，请刷新会话列表',409);
    const session={sessionId:target.id,workspace:target.workspace||''};
    return body.action==='binding.preview'?previewSessionBinding(body,session):updateSessionBinding(body,session);
  }
  if(body.action==='workspace.scan')return scanWorkspace(body);
  if(body.action==='workspace.preview')return {ok:true,source:selectWorkspaceSource(body.selection)};
  if(body.action==='suite.save')return value.suites.save(body.suite);
  if(body.action==='suite.remove')return value.suites.remove(body.id,body.expectedRevision);
  if(body.action==='revision.restore')return restoreStudioRevision(body);
  if(body.action==='rules.maintain')return maintainStudioRules(body);
  if (body.action==='start') {
    const input={...body,selectedSession:null,selectedWorkspace:null};
    if(body.workspaceSelection)input.selectedWorkspace=selectWorkspaceSource(body.workspaceSelection);
    else if(body.sourceJobId)input.selectedWorkspace=value.get(body.sourceJobId).input.selectedWorkspace||null;
    if(['learn','regression'].includes(body.operation)){
      if(body.sessionSelection)input.selectedSession=await selectSessionSource(body.sessionSelection);
      else if(body.sourceJobId){const prior=value.get(body.sourceJobId);input.selectedSession=prior.input.selectedSession||null;}
    }
    return {ok:true,job:value.start(input)};
  }
  if (body.action==='cancel') return {ok:true,job:value.cancel(body.id)};
  if (body.action==='adopt') return value.adopt(body);
  if (body.action==='clear') return value.clear();
  if (body.action==='remove') return value.remove(body.id);
  throw Object.assign(new Error('创作动作无效'),{statusCode:400});
}

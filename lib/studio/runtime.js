import { snapshot, ensureInitialized, studioStorageDirectory, applyStudioCandidate,restoreStudioRevision,analyzeStudioRules,maintainStudioRules,previewSessionBinding,updateSessionBinding,reloadAssetState,sessionScopePreview } from '../state.js';
import { Studio } from './jobs.js';
import { currentBackend, onBackendDisposed } from './model.js';
import { RevisionStore } from './revisions.js';
import { currentSessionReader,selectSessionSource } from './sessions.js';
import { problem } from '../store.js';
import { scanWorkspace,selectWorkspaceSource } from './workspace.js';
import { ScenarioStore } from './scenarios.js';
import {exportAssetPackage,previewAssetImport,importAssetPackage,importedAssetRecords} from './asset-package.js';
let engine, directory;
export function studio() {
  ensureInitialized();
  const current=studioStorageDirectory();
  if (!engine || directory!==current) { engine?.dispose(); directory=current;
    engine=new Studio({directory, snapshot, apply:applyStudioCandidate, backend:currentBackend}); }
  return engine;
}
onBackendDisposed(()=>{engine?.dispose();engine=undefined;});
async function modelReadiness(routes){
  const backend=currentBackend(),providers=backend?.providers()||[],models=new Map();
  await Promise.all([...new Set(routes.map(r=>r.provider))].filter(id=>providers.some(p=>p.id===id)).map(async provider=>{let timer;try{models.set(provider,await Promise.race([backend.models(provider),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('模型目录超时')),8000);})]));}catch{models.set(provider,null);}finally{clearTimeout(timer);}}));
  return [...new Map(routes.map(r=>[r.provider+'\0'+r.model,r])).values()].map(r=>({provider:r.provider,model:r.model,available:!providers.some(p=>p.id===r.provider)?false:models.get(r.provider)===null?null:models.get(r.provider)?.some(m=>m.id===r.model)===true}));
}
export async function dispatchStudio(req, query, body) {
  const value=studio();
  if (req.method==='GET') {
    if(query.get('kind')==='imported-assets')return importedAssetRecords(directory);
    if(query.get('kind')==='scope'){const reader=currentSessionReader();if(!reader)throw problem('会话服务未就绪',503);const id=query.get('id'),target=reader.info?await reader.info(id):(await reader.list()).find(s=>s.id===id);if(!target)throw problem('目标会话不可读取',404);return sessionScopePreview(target);}
    if(query.get('kind')==='scenarios')return new ScenarioStore(directory).list();
    if(query.get('kind')==='scenario'){const r=new ScenarioStore(directory).preview(query.get('id'),snapshot(),value.suites),d=r.scenario.data,models=await modelReadiness([d.route,d.targetRoute,d.judgeRoute]);return {...r,models,canApply:r.canApply&&models.every(m=>m.available===true),reason:r.reason||(models.some(m=>m.available!==true)?'场景模型不可用或尚未核实，请核对供应商和模型，或另存更新场景':null)};}
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
  if(body.action==='assets.export')return {ok:true,bundle:exportAssetPackage(directory,snapshot(),body.options)};
  if(['assets.preview','assets.commit'].includes(body.action)){if(value.history().some(j=>['queued','running'].includes(j.status)))throw problem('请先等待或取消正在运行的创作任务，再导入资产',409);if(body.action==='assets.preview'){const preview=previewAssetImport(directory,snapshot(),body.bundle);return {...preview,preview:{...preview.preview,models:await modelReadiness(body.bundle.graph.scenarios.flatMap(n=>[n.route,n.targetRoute,n.judgeRoute]))}};}const receipt=importAssetPackage(directory,snapshot(),body.bundle,body.token);return {...reloadAssetState(),receipt};}
  if(body.action==='scenario.refresh.preview')return new ScenarioStore(directory).refreshPreview(body,snapshot(),value.suites);
  if(body.action==='scenario.refresh')return new ScenarioStore(directory).refresh(body,snapshot(),value.suites);
  if(body.action==='scenario.save')return new ScenarioStore(directory).save(body,snapshot(),value.suites);
  if(body.action==='scenario.load'){const store=new ScenarioStore(directory),d=store.get(body.id).data,models=await modelReadiness([d.route,d.targetRoute,d.judgeRoute]);if(models.some(m=>m.available!==true))throw problem('场景模型不可用或尚未核实，请核对供应商和模型设置',409);return store.load(body,snapshot(),value.suites,currentBackend()?.providers());}
  if(body.action==='scenario.remove')return new ScenarioStore(directory).remove(body);
  if(body.action==='binding.remove')return updateSessionBinding(body);
  if(['binding.preview','binding.save'].includes(body.action)){
    const reader=currentSessionReader();if(!reader)throw problem('会话服务未就绪，无法核对绑定目标',503);
    const target=reader.info?await reader.info(body.sessionId):(await reader.list()).find(s=>s.id===body.sessionId);if(!target)throw problem('目标会话不在可核对列表中，请刷新会话列表',409);
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
    input.targetSessionId=null;if(body.targetSessionId){const reader=currentSessionReader();if(!reader)throw problem('会话服务未就绪，无法核对创作目标',503);const target=reader.info?await reader.info(body.targetSessionId):(await reader.list()).find(s=>s.id===body.targetSessionId);if(!target)throw problem('目标会话已不可用',409);input.targetSessionId=target.id;}
    if(body.sourceJobId&&(value.get(body.sourceJobId).input.base?.targetSessionId||null)!==input.targetSessionId)throw problem('来源任务属于另一会话，请在原会话继续或另存方案后明确采用',409);
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

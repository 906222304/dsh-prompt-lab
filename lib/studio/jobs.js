import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, fileDigest, problem } from '../store.js';
import { LIMITS, TEMPLATE_VERSION, inputDigest, prepareInput, parseCandidate, routeOf } from './contracts.js';
import { composeRequest } from './templates.js';
import { SuiteStore } from './suites.js';
import { prepareExperiment, executeExperiment, experimentOperation, EXPERIMENT_LIMITS } from './experiments.js';

const terminal = job => !['queued', 'running'].includes(job.status);
const clone = value => JSON.parse(JSON.stringify(value));
const cleanError = error => String(error?.message || error).replace(/https?:\/\/\S+/g, '<URL>').replace(/(?:[A-Za-z]:\\|\/(?:home|Users)\/)[^\s"']+/g, '<路径>').slice(0, 600);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export class Studio {
  constructor({ directory, snapshot, apply, backend, limits = {} }) {
    this.instanceId=randomUUID();this.directory = directory; this.root = path.join(directory, 'studio'); this.snapshot = snapshot; this.apply = apply; this.backend = backend;
    this.limits = { ...LIMITS, ...limits }; this.suites=new SuiteStore(directory);this.jobs = new Map(); this.controllers = new Map(); this.error = null;
    try {
      if (fs.existsSync(this.settingsFile())) this.settings = read(this.settingsFile());
      else this.settings = { version: 1, model: null };
      if (this.settings.version !== 1 || (this.settings.model !== null && !this.settings.model)) throw new Error('AI 设置格式不可用，已阻止覆盖');
      if (this.settings.model) this.settings.model = routeOf(this.settings.model);
      const jobsDirectory = path.join(this.root, 'jobs');
      if (fs.existsSync(jobsDirectory)) for (const name of fs.readdirSync(jobsDirectory)) {
        if (!/^j-[a-f0-9-]{36}\.json$/.test(name)) continue;
        try {
          const job = read(path.join(jobsDirectory, name));
          if (job.id !== name.slice(0,-5) || job.version !== 1 || !['queued','running','succeeded','failed','cancelled','timed_out','interrupted','budget_exhausted'].includes(job.status)) throw new Error('任务格式无效');
          if (!terminal(job)) { job.status = 'interrupted'; job.error = '宿主或服务已重新加载，任务已中断；未自动继续调用'; job.updatedAt = new Date().toISOString(); this.persist(job); }
          this.jobs.set(job.id, job);
        } catch { this.error = '部分 AI 历史记录不可用，原文件已保留；请检查 studio/jobs'; }
      }
      this.prune();
    } catch (error) { this.error = 'AI 本地记录不可用，已阻止覆盖：' + cleanError(error); }
  }
  settingsFile() { return path.join(this.root, 'settings.json'); }
  jobFile(id) { return path.join(this.root, 'jobs', id + '.json'); }
  persist(job) { atomicWrite(this.jobFile(job.id), job); }
  get(id) {
    if (typeof id !== 'string' || !/^j-[a-f0-9-]{36}$/.test(id)) throw problem('任务 id 无效');
    const job = this.jobs.get(id); if (!job) throw problem('任务不存在或已清除', 404);
    return clone(job);
  }
  history() { return [...this.jobs.values()].reverse().sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(j => ({ id:j.id, status:j.status, operation:j.input.operation,
    createdAt:j.createdAt, name:j.candidate?.content.name || j.input.goal.slice(0,50) || '整理规则', error:j.error || null })); }
  async capabilities(provider) {
    const model = this.backend();
    if (!model) return { instanceId:this.instanceId,available:false, storageError:this.error, limits:this.limits, experimentLimits:EXPERIMENT_LIMITS, history:this.history(), reason:'AI 服务尚未就绪；配置管理和注入仍可使用' };
    let defaultRoute=null;
    try { defaultRoute=routeOf(model.defaultRoute()); } catch { /* A valid explicit choice can work without a configured default. */ }
    let route = this.settings?.model || defaultRoute;
    const providers = model.providers();
    let models = [], catalogError = null;
    try {
      const selectedProvider = provider || route?.provider || providers[0]?.id;
      if (!providers.some(p => p.id === selectedProvider)) throw problem('供应商已不可用');
      let timer;
      try { models = await Promise.race([model.models(selectedProvider), new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('模型目录加载超时，可继续使用已保存模型')),8000); })]); }
      finally { clearTimeout(timer); }
      if (!route) route={provider:selectedProvider,model:models[0]?.id||''};
    } catch (error) { catalogError = cleanError(error); }
    return { instanceId:this.instanceId,available:true, defaultRoute, savedRoute:this.settings?.model, route, providers, models, catalogError, storageError:this.error, limits:this.limits, experimentLimits:EXPERIMENT_LIMITS, history:this.history() };
  }
  start(request) {
    if (this.error) throw problem(this.error, 409);
    const model = this.backend(); if (!model) throw problem('AI 服务未就绪', 503);
    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(request.requestId)) throw problem('请求去重标识无效');
    const input = experimentOperation(request.operation)?prepareExperiment(request,this.snapshot(),id=>this.get(id),this.suites):prepareInput(request, this.snapshot());
    const route = routeOf(request.route || this.settings.model || model.defaultRoute());
    if (!model.providers().some(p => p.id === route.provider)) throw problem('供应商已不可用，请重新选择模型', 409);
    for(const selected of [input.targetRoute,input.judgeRoute].filter(Boolean))if(!model.providers().some(p=>p.id===selected.provider))throw problem('测试或评分供应商已不可用',409);
    // Validation-use counters are telemetry, not a change to the requested frozen suite.
    const digestInput=input.suite?{...input,suite:{...input.suite,validationUses:undefined}}:input;
    const digest = inputDigest({ input:digestInput, route });
    const duplicate = [...this.jobs.values()].find(j => j.requestId === request.requestId);
    if (duplicate) {
      if (duplicate.inputDigest !== digest) throw problem('相同请求标识对应不同内容，请重新生成', 409);
      return this.get(duplicate.id);
    }
    if ([...this.jobs.values()].some(j => !terminal(j))) throw problem('已有创作任务正在运行，请等待或取消', 409);
    if (request.route) { const settings = { version:1, model:route }; atomicWrite(this.settingsFile(), settings); this.settings = settings; }
    const job = { version:1,instanceId:this.instanceId, id:'j-'+randomUUID(), requestId:request.requestId, inputDigest:digest, status:'queued',
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), templateVersion:TEMPLATE_VERSION, input, route,
      usage:{ calls:0, inputTokens:null, outputTokens:null, cost:null, inputBytes:0, reservedOutputTokens:0 }, reportedUsage:{inputTokens:0,outputTokens:0}, progressChars:0, candidate:null, error:null };
    this.persist(job); this.jobs.set(job.id, job);
    const controller = new AbortController(); this.controllers.set(job.id, controller);
    queueMicrotask(() => this.run(job, model, controller));
    try { this.prune(); } catch { /* Retention cleanup must not turn an already dispatched request into a failed submission. */ }
    return this.get(job.id);
  }
  async run(job, model, controller) {
    const signal = controller.signal;
    const experimental=experimentOperation(job.input.operation),budget=job.input.budget||{maxCalls:this.limits.maxCalls,maxInputTotal:this.limits.maxInputBytes*this.limits.maxCalls,maxOutputTotal:this.limits.maxOutputTokens*this.limits.maxCalls,timeoutMs:this.limits.timeoutMs};
    const progress=()=>{signal.throwIfAborted();job.updatedAt=new Date().toISOString();if(this.jobs.get(job.id)===job)this.persist(job);};
    const actualRoutes=new Map();
    const call=async options=>{
      signal.throwIfAborted();
      const bytes=Buffer.byteLength(options.system+options.user,'utf8');
      if(bytes>this.limits.maxInputBytes)throw problem('请求超过输入预算，请减少材料',413);
      if(job.usage.calls>=budget.maxCalls||job.usage.inputBytes+bytes>budget.maxInputTotal||job.usage.reservedOutputTokens+options.maxTokens>budget.maxOutputTotal){
        throw Object.assign(problem('任务达到调用、输入或输出预留预算；保留已有结果，不采用未完成候选',409),{code:'BUDGET_EXHAUSTED'});
      }
      job.usage.calls++;job.usage.inputBytes+=bytes;job.usage.reservedOutputTokens+=options.maxTokens;progress();
      const started=Date.now();let cancel,response;
      try{response=await Promise.race([Promise.resolve().then(()=>model.generate({...options,signal,onProgress:chars=>{if(!terminal(job))job.progressChars=chars;}})),
        new Promise((_,reject)=>{cancel=()=>reject(Object.assign(new Error(job.error||'任务已中止'),{name:'AbortError'}));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();})]);}
      finally{signal.removeEventListener('abort',cancel);}
      signal.throwIfAborted();
      for(const key of ['inputTokens','outputTokens']){
        const value=response.usage?.[key];
        if(Number.isFinite(value)&&value>=0)job.reportedUsage[key]++;
        job.usage[key]=Number.isFinite(value)&&value>=0&&job.reportedUsage[key]===job.usage.calls?(job.usage[key]??0)+value:null;
      }
      const actual=routeOf(response.route||options.route),expected=routeOf(options.route),parameters=response.parameters||{maxTokens:options.maxTokens};
      if(experimental){
        const prior=actualRoutes.get(options.purpose);
        const actualConfig={route:actual,parameters};
        if(actual.provider!==expected.provider||actual.model!==expected.model||(expected.reasoningEffort&&expected.reasoningEffort!==actual.reasoningEffort)||(expected.temperature!==undefined&&expected.temperature!==actual.temperature)||(prior&&inputDigest(prior)!==inputDigest(actualConfig)))throw Object.assign(problem('实际模型或参数发生变化，停止同条件试跑',502),{code:'MODEL_ROUTE_CHANGED'});
        actualRoutes.set(options.purpose,actualConfig);
      }else job.route=actual;
      job.calls||=[];job.calls.push({purpose:options.purpose,route:actual,parameters,maxTokens:options.maxTokens,inputBytes:bytes,latencyMs:Date.now()-started,usage:response.usage||null});progress();
      return {...response,route:actual};
    };
    const timer = setTimeout(() => { if (terminal(job)) return; job.status='timed_out'; controller.abort(new Error('任务超过时间预算')); }, budget.timeoutMs);
    try {
      if (terminal(job)) return;
      job.status='running'; this.persist(job);
      if(experimental){await executeExperiment(job,{call,progress,suites:this.suites});signal.throwIfAborted();job.status='succeeded';progress();return;}
      let repair;
      for (let attempt = 0; attempt < this.limits.maxCalls; attempt++) {
        signal.throwIfAborted();
        const request = composeRequest(job.input, repair);
        const response=await call({route:job.route,...request,maxTokens:this.limits.maxOutputTokens,purpose:'prompt-lab-studio'});
        let content;
        try { content=parseCandidate(response.text,job.input); }
        catch (error) { if (attempt+1>=this.limits.maxCalls) throw error; repair=response.text; continue; }
        job.candidate = { id:job.id, operation:job.input.operation, base:job.input.base, content, verified:false,
          sources:{ label:job.input.sourceLabel, materials:job.input.materials,selectedSession:job.input.selectedSession, sourceRules:job.input.sourceRules.map(({id,version,name})=>({id,version,name})) } };
        job.status='succeeded'; break;
      }
      job.updatedAt=new Date().toISOString(); if(this.jobs.get(job.id)===job)this.persist(job);
    } catch (error) {
      if (!['cancelled','timed_out','interrupted'].includes(job.status)) job.status=error.code==='BUDGET_EXHAUSTED'?'budget_exhausted':'failed';
      job.error=cleanError(error); job.candidate=null; job.updatedAt=new Date().toISOString();
      try { if(this.jobs.get(job.id)===job)this.persist(job); } catch { job.error+='；本地记录写入失败，原配置未改变'; }
    } finally { clearTimeout(timer); this.controllers.delete(job.id); try { this.prune(); } catch { /* Keep usable results if retention cleanup is unavailable. */ } }
  }
  cancel(id, status='cancelled') {
    const job=this.jobs.get(this.get(id).id); if (terminal(job)) return this.get(id);
    job.status=status; job.error=status==='interrupted'?'AI 服务已重新加载，任务中断':'任务已取消；已派发调用仍可能计费'; job.updatedAt=new Date().toISOString();
    this.controllers.get(id)?.abort(new Error(job.error)); this.persist(job); return this.get(id);
  }
  dispose() { for (const j of this.jobs.values()) if (!terminal(j)) { try { this.cancel(j.id,'interrupted'); } catch { this.controllers.get(j.id)?.abort(); } } }
  adopt(request) {
    const job=this.jobs.get(this.get(request.id).id);
    if (job.status!=='succeeded' || !job.candidate) throw problem('此任务没有可采用候选',409);
    if(job.input.operation==='optimize'&&(request.mode!=='profile'||!Array.isArray(request.indices)||request.indices.length!==job.candidate.content.ruleSuggestions.length||request.indices.some((index,i)=>index!==i)))throw problem('优化结果必须按已试跑的完整规则顺序另存；更改规则选择后请重新试跑',409);
    const app=job.application;
    if (app) {
      const state=this.snapshot();
      const committed=app.status==='committed' || (app.editedId ? state.profiles.some(p=>p.id===app.editedId) : app.createdRuleIds.length>0 && app.createdRuleIds.every(id=>state.ruleSets.some(r=>r.id===id)));
      if (committed) return { ...state, editedId:app.editedId, editedRuleId:app.createdRuleIds[0]||app.reusedRuleIds[0]||null, alreadyApplied:true };
      const unchanged=fileDigest(path.join(this.directory,'profiles.json'))===app.beforeFingerprint;
      if (!unchanged) throw problem('上次采用结果需要核对，已阻止重复创建；请检查配置列表',409);
      delete job.application;
    }
    const result=this.apply(job.candidate,request,receipt=>{
      job.application={...receipt,status:'prepared',at:new Date().toISOString()}; this.persist(job);
    });
    job.application.status='committed';
    try { this.persist(job); } catch { result.studioWarning='方案已保存，采用记录将在下次读取时核对恢复'; }
    return result;
  }
  clear() {
    if ([...this.jobs.values()].some(j=>!terminal(j))) throw problem('请先取消正在运行的任务',409);
    const directory=path.join(this.root,'jobs');
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) if (/^j-[a-f0-9-]{36}\.json$/.test(name)) fs.unlinkSync(path.join(directory,name));
    this.jobs.clear(); if (this.error?.startsWith('部分 AI 历史')) this.error=null; return {ok:true};
  }
  remove(id) {
    const job=this.get(id);if(!terminal(job))throw problem('请先取消运行中的任务',409);
    fs.unlinkSync(this.jobFile(job.id));this.jobs.delete(job.id);return {ok:true};
  }
  prune() {
    const retained=[...this.jobs.values()].reverse().filter(terminal).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    for (const job of retained.slice(this.limits.history)) { fs.unlinkSync(this.jobFile(job.id)); this.jobs.delete(job.id); }
  }
}

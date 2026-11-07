import { randomUUID } from 'node:crypto';
import { problem } from '../store.js';
import { routeOf } from './contracts.js';

let backend = null;
const listeners = new Set();
export function currentBackend() { return backend; }
export function onBackendDisposed(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function registerBackend(value) {
  if (backend) for (const fn of listeners) fn();
  backend = value;
  return () => { if (backend !== value) return; backend = null; for (const fn of listeners) fn(); };
}
export function hostBackend(ctx) {
  return {
    defaultRoute: () => routeOf(ctx.agentDefaultModel.currentSelection()),
    providers: () => ctx.llm.listProviders().map(p => ({ id: p.id, name: p.name || p.id })),
    models: async provider => (await ctx.llm.listModels(provider)).map(m => ({ id: m.id, name: m.name })),
    async generate({ route, system, user, maxTokens, signal, onProgress, purpose='prompt-lab-studio' }) {
      const call = await ctx.llm.prepareCall({ ...route, maxTokens }, signal);
      signal.throwIfAborted();
      if(Number.isFinite(call.config.maxTokens)&&call.config.maxTokens>maxTokens)throw problem('宿主协商后的输出上限超过本次预算，未派发请求',502);
      const partials = new Map(); let finish = null, usage = null, size = 0;
      const message = Object.freeze({ id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'prompt-lab-studio' }),
        content: Object.freeze([Object.freeze({ type: 'text', text: user })]) });
      for await (const chunk of call.stream({ ...call.config, system, messages: Object.freeze([message]), tools: [], purpose, signal })) {
        signal.throwIfAborted();
        if (chunk.type === 'text-delta') {
          const item = partials.get(chunk.index) || { text: '', closed: false };
          if (!item.closed) { item.text += chunk.text; size += chunk.text.length; partials.set(chunk.index, item); onProgress?.(size); }
        } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          partials.set(chunk.index, { text: chunk.block.text, closed: true });
        } else if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) {
          throw problem('辅助创作返回了工具请求，已拒绝执行', 502);
        } else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') finish = chunk.reason;
        if (size > 200000 || [...partials.values()].reduce((n,p) => n+p.text.length,0) > 200000) throw problem('模型输出超过候选预算', 502);
      }
      signal.throwIfAborted();
      if (!finish || finish.kind !== 'stop') {
        const kind = finish?.kind || 'incomplete';
        throw problem(kind === 'max-tokens' ? '模型输出被 Token 上限截断，请精简需求后重试' : `模型调用未正常完成（${kind}）`, 502);
      }
      const text = [...partials.entries()].sort((a,b) => a[0]-b[0]).map(([,p]) => p.text).join('');
      if (!text.trim()) throw problem('模型未返回可用文本', 502);
      const count = value => Number.isFinite(value) && value >= 0 ? value : null;
      return { text, route: routeOf(call.config), parameters:{maxTokens:call.config.maxTokens??maxTokens},usage: { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens), cost: null } };
    },
  };
}

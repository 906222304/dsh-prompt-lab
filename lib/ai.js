/** Optional model service: its absence never blocks profile management or injection. */
import { registerBackend, hostBackend } from './studio/model.js';
import { registerSessionReader, hostSessionReader } from './studio/sessions.js';
export const name = 'dsh-prompt-lab-ai';
export const inject = ['llm', 'agentDefaultModel'];
export function apply(ctx) {
  if (['prepareCall','listProviders','listModels'].some(key=>typeof ctx.llm?.[key]!=='function') || typeof ctx.agentDefaultModel?.currentSelection !== 'function') return;
  ctx.effect(() => registerBackend(hostBackend(ctx)));
  if(typeof ctx.inject==='function')ctx.inject(['sessionQuery'],child=>child.effect(()=>registerSessionReader(hostSessionReader(child.sessionQuery))));
}
export default { name, inject, apply };

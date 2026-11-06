import { createHash } from 'node:crypto';
import { problem, MAX_PROFILE_TEXT } from '../store.js';

export const TEMPLATE_VERSION = 'studio-1';
export const LIMITS = Object.freeze({ timeoutMs: 90000, maxOutputTokens: 4000, maxCalls: 2, maxInputBytes: 120000, history: 20, rules: 12 });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw problem(`${label}格式无效或超过长度限制`);
  return value.trim();
};
const lines = (value, label) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw problem(`${label}须为最多 12 项的列表`);
  return value.map(item => text(item, label, 1200, true));
};
export const draftKey = draft => JSON.stringify([draft.id, draft.version, draft.prompt, draft.rules, draft.ruleIds, draft.promptEnabled, draft.rulesEnabled]);
export const inputDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function routeOf(value) {
  if (!object(value)) throw problem('请选择可用模型');
  const provider = text(value.provider, '供应商', 160, true), model = text(value.model, '模型', 240, true);
  return { provider, model, ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort.length < 50 ? { reasoningEffort: value.reasoningEffort } : {}) };
}
export function prepareInput(input, state) {
  if (!object(input) || !['generate', 'revise', 'extract'].includes(input.operation)) throw problem('创作动作无效');
  const goal = text(input.goal ?? '', '需求或反馈', 6000);
  const materials = text(input.materials ?? '', '所选材料', 60000);
  const sourceLabel = text(input.sourceLabel ?? '用户选定材料', '材料来源', 100, true);
  if (!goal && !materials) throw problem('请描述需求或带入需要整理的材料');
  const profile = state.profiles.find(p => p.id === input.profileId);
  if (!profile) throw problem('原配置不存在，请刷新', 409);
  if (input.profileVersion !== profile.version) throw problem('原配置已变化，请载入最新版本后生成；草稿仍保留', 409);
  let draft = null;
  if (input.includeDraft === true) {
    if (!object(input.draft) || !Array.isArray(input.draft.ruleIds) || input.draft.ruleIds.length > 50 || new Set(input.draft.ruleIds).size !== input.draft.ruleIds.length) throw problem('草稿引用无效');
    if (input.draft.ruleIds.some(id=>typeof id!=='string') || ['promptEnabled','rulesEnabled'].some(key=>input.draft[key]!==undefined&&typeof input.draft[key]!=='boolean')) throw problem('草稿开关或引用格式无效');
    draft = { id: profile.id, version: profile.version,
      prompt: (text(input.draft.prompt, '草稿正文', MAX_PROFILE_TEXT), input.draft.prompt), rules: (text(input.draft.rules, '草稿附加规则', MAX_PROFILE_TEXT), input.draft.rules),
      ruleIds: [...input.draft.ruleIds], promptEnabled: input.draft.promptEnabled !== false, rulesEnabled: input.draft.rulesEnabled !== false };
  }
  if (input.operation === 'revise' && !draft && !input.previousCandidate) throw problem('优化需要带入草稿或前一候选');
  const sourceRuleIds = input.sourceRuleIds ?? [];
  if (!Array.isArray(sourceRuleIds) || sourceRuleIds.length > 50 || new Set(sourceRuleIds).size !== sourceRuleIds.length || sourceRuleIds.some(id => typeof id !== 'string')) throw problem('所选规则无效');
  const ids = [...new Set([...(draft?.ruleIds || []), ...sourceRuleIds])];
  const sourceRules = ids.map(id => {
    const rule = state.ruleSets.find(r => r.id === id);
    if (!rule) throw problem('引用规则已不存在，请刷新', 409);
    return { id: rule.id, version: rule.version, name: rule.name, text: rule.text, enabled: rule.enabled };
  });
  const result = { operation: input.operation, goal, materials, sourceLabel, sourceRules,
    base: { profileId: profile.id, profileVersion: profile.version, storeVersion: state.storage.storeVersion,
      draft, draftKey: draft ? draftKey(draft) : null, ruleVersions: Object.fromEntries(sourceRules.map(r => [r.id, r.version])) },
    previousCandidate: input.previousCandidate ?? null };
  // Previous candidates are bounded editable data, never an instruction or an asset write.
  if (result.previousCandidate !== null) {
    if (!object(result.previousCandidate)) throw problem('前一候选无效');
    result.previousCandidate = parseCandidate(JSON.stringify(result.previousCandidate), result);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.maxInputBytes) throw problem('材料超过本次输入预算，请减少所选内容', 413);
  return result;
}
export function parseCandidate(raw, input) {
  let parsed;
  try { parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw problem('模型没有返回完整 JSON 候选'); }
  if (!object(parsed)) throw problem('候选须为 JSON 对象');
  const name = text(parsed.name, '候选名称', 80, true);
  const prompt = text(parsed.prompt ?? '', '候选正文', MAX_PROFILE_TEXT, input.operation !== 'extract');
  const rules = text(parsed.rules ?? '', '候选附加规则', MAX_PROFILE_TEXT);
  if (!Array.isArray(parsed.ruleSuggestions) || parsed.ruleSuggestions.length > LIMITS.rules) throw problem('规则建议须为最多 12 项的列表');
  const suggestions = parsed.ruleSuggestions.map(item => {
    if (!object(item) || !['create', 'reuse', 'copy'].includes(item.action)) throw problem('规则建议动作无效');
    const existing = item.action === 'create' ? null : input.sourceRules.find(r => r.id === item.existingRuleId);
    if (item.action !== 'create' && !existing) throw problem('模型引用了未选定的规则');
    return { action: item.action, ...(existing ? { existingRuleId: existing.id, existingVersion: existing.version } : {}),
      name: item.action === 'reuse' ? existing.name : text(item.name, '建议名称', 80, true),
      text: item.action === 'reuse' ? existing.text : text(item.text, '规则正文', MAX_PROFILE_TEXT, true),
      reason: text(item.reason ?? '', '建议理由', 1200), source: text(item.source ?? '', '模型提取依据', 1200),
      scope: text(item.scope ?? '仅关联本方案', '适用范围', 200),
      conflict: text(item.conflict ?? '', '重复或冲突提示', 1200), ...(existing ? { existingEnabled:existing.enabled } : {}) };
  });
  const ruleSuggestions=[],seen=new Set();
  for (let item of suggestions) {
    const key=item.text.replace(/\s+/g,' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const same=input.sourceRules.find(r=>r.text.replace(/\s+/g,' ').trim()===key);
    if (same && item.action!=='reuse') item={...item,action:'reuse',existingRuleId:same.id,existingVersion:same.version,existingEnabled:same.enabled,
      name:same.name,text:same.text,conflict:[item.conflict,'与选定的已有规则完全一致，采用时直接引用'].filter(Boolean).join('；')};
    ruleSuggestions.push(item);
  }
  if (input.operation === 'extract' && !ruleSuggestions.length) throw problem('没有提取到可采用规则；请补充材料或要求');
  const questions=lines(parsed.questions,'待补充项');if(questions.length>2)throw problem('必要追问最多两项');
  return { name, prompt, rules, ruleSuggestions, changes: lines(parsed.changes, '修改说明'),
    assumptions: lines(parsed.assumptions, '待核实假设'), questions,
    retainedRuleIds: [...(input.base.draft?.ruleIds || [])] };
}

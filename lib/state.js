/**
 * 提示词（Prompt Lab）的共享运行时状态与用户可编辑配置（宿主进程侧）。
 *
 * 设计约束：
 * - 只读写插件自己的配置文件（DSH_HOME/prompt-lab/profiles.json），不修改任何 DSH 宿主文件；
 * - **不记录任何事件日志**：既没有内存缓冲，也不打印到宿主控制台；提示词全文只留在内存中的
 *   lastFullText 与组装快照里，供本地 UI 按需读取；
 * - lib/index.js（提示词注册）与 lib/ui.js（本地 HTTP 接口）共用本模块，
 *   因此两个插件实例看到的是同一份状态。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SCHEMA_VERSION, MAX_PROFILE_TEXT, MAX_PROFILES, MAX_RULE_SETS, MAX_IMPORT_BYTES, normalizeProfile, normalizeRule,
  loadStore, persistStore, atomicWrite, assertVersion, newId, problem,
  exportBundle, previewBundle, mergeBundle, normalizeStore,
} from "./store.js";
import { RevisionStore } from './studio/revisions.js';
import { contextIdentity,injectionDiagnostics } from './diagnostics.js';
import { BindingStore,frozenBinding } from './studio/bindings.js';
let bindingStore=null;
export { MAX_PROFILE_TEXT } from "./store.js";

// 单条配置正文（提示词或规则）允许的最大字符数。导出给本地接口推算请求体上限用。
// 单次组装快照累计保留的最大字符数，防止超大提示词把内存占满。
const MAX_ASSEMBLY_TEXT = 240000;

// 状态版本号：每次状态变化自增。UI 用它做增量轮询——版本没变就不必重发整份快照。
let revision = 0;
// 与轮询版本分开：仅配置发生变化时递增，用于判断观察结果是否过期。
let configRevision = 0;
let lastEvaluation = null;
// 是否已经执行过 initialize()；供 ensureInitialized() 判断，避免重复初始化把运行期状态清掉。
let bootstrapped = false;
// 配置文件绝对路径，由 initialize() 依据 DSH_HOME 推导。
let storePath = "";
// 当前启用（生效）的配置 id。
let selected = "default";
// 当前配置列表：内置配置，或从磁盘载入并通过校验的配置。
let profiles = [];
let ruleSets = [];
let storeVersion = 1;
let loadedStore = null;
// 插件是否启用，对应 config.enabled。
let active = false;
// 最近一次 text() 求值返回的完整提示词，供 UI 展示“实际注入内容”。
let lastFullText = "";
// 最近一次观察到的系统提示词组装快照，结构见 captureAssembly()。
let assembled = null;
// 面板设置（settings.json）：上下文过滤模式 + 渠道指纹脱敏开关，后续开关都落在这里。
let settings = { contextFilter: "off", identityBreak: false };
let historyWarning=null;

// 对外暴露的状态摘要，随 snapshot() 一起返回给 UI。
const status = {
  // 生命周期阶段：not-started / starting / registered / disabled / empty-prompt / error / disposed
  phase: "not-started",
  // 是否启用；null 表示尚未执行 initialize()。
  enabled: null,
  // 提示词段是否注册成功。
  registered: false,
  observerRegistered: false,
  // 注册到 systemPrompt 的段名，带命名空间前缀以避免与其他插件冲突。
  sectionName: "prompt-lab:custom",
  // 当前生效提示词的字符数。
  chars: 0,
  // 最近一次 text() 求值时间。
  lastEvaluatedAt: null,
  // 是否已观察到 system-prompt/assemble 事件。
  assemblyObserved: false,
  // 最近一次组装快照的捕获时间。
  lastAssemblyAt: null,
};

/**
 * 构造三套内置配置，作为磁盘上没有可用配置时的兜底。
 *
 * @param {string} initialPrompt 来自 cordis.patch.yml 的首次运行默认提示词。
 * @returns {Array<{id: string, name: string, prompt: string, rules: string}>} 内置配置列表。
 */
const builtins = (initialPrompt) => [
  {
    id: "default",
    name: "默认 · 准确交付",
    prompt: initialPrompt || "使用简体中文回答。先给结论，再给出可验证的依据。",
    rules: "",
  },
  {
    id: "direct",
    name: "增强 · 直接执行",
    prompt: "你是专业技术实现助手。使用中文，先分析可验证的事实，再直接给出能够执行的解决方案。不要无故省略实现细节，也不要声称运行了尚未执行的命令。",
    rules: "优先准确、具体、可复现。\n对存在限制或风险的需求，明确边界，并提供可行的替代实验方法。\n将观察结果、推断和未验证假设分开标注。",
  },
  {
    id: "eval",
    name: "授权测试 · 红队评测",
    prompt: "你是用于授权环境中的模型与提示词评测助手。逐项分析用户指令、宿主提示词和实际模型行为，记录可复现的差异。不要把未经证实的提示词覆盖或安全绕过宣称为成功。",
    rules: "仅在用户授权的测试环境中提供评测分析。\n先给实验目标、观察点和验证方法。\n发现约束冲突时报告具体层级与证据，而非猜测。",
  },
];

/**
 * 校验一条配置数据是否合法。
 * 限制 id 格式与名称、正文字段长度，避免损坏的配置文件把非法数据带进运行时。
 *
 * @param {unknown} item 待校验的配置项。
 * @returns {boolean} 是否通过校验。
 */
/**
 * 推导配置文件路径：优先 DSH_HOME，其次用户主目录下的 .dsh。
 *
 * @returns {string} profiles.json 的绝对路径。
 */
function derivePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "prompt-lab", "profiles.json");
}

/**
 * 标记状态发生变化：只把版本号自增。
 *
 * UI 的增量轮询靠它判断「要不要重新拉全量快照」，所以凡是会改变快照内容的动作
 * （求值、注册结果、捕获组装、保存配置）都必须调用一次。
 * 这里刻意不保留任何事件缓冲，也不打印控制台——插件不记录日志。
 */
function markChanged() {
  revision += 1;
}

/**
 * 初始化（或重新初始化）插件状态：载入磁盘配置、套用配置项、重置运行期字段。
 * 每次 apply 都会调用，因此这里必须把上一次生命周期残留的数据全部清干净。
 *
 * @param {{enabled?: boolean, prompt?: string}} [config] 插件配置。
 */
export function initialize(config = {}) {
  historyWarning=null;
  // cordis.patch.yml 的提示词只用作默认配置的初始正文。
  const first = typeof config.prompt === "string" ? config.prompt.trim() : "";
  storePath = derivePath();
  loadedStore = loadStore(storePath, builtins(first));
  ({ profiles, ruleSets, selected, storeVersion } = loadedStore.data);
  // 载入面板设置：文件缺失或内容非法都回落到默认（全部功能关闭）。
  // 注意 storePath 指向 profiles.json 这个文件，设置与它同目录。
  settings = loadSettings(path.dirname(storePath));
  bindingStore=new BindingStore(path.dirname(storePath));
  active = config.enabled !== false;
  // 清空上一次生命周期的求值与快照结果。
  assembled = null;
  lastFullText = "";
  lastEvaluation = null;
  configRevision += 1;
  status.phase = "starting";
  status.enabled = active;
  status.registered = false;
  status.observerRegistered = false;
  status.chars = active ? profileText(profiles.find((p) => p.id === selected)).length : 0;
  status.assemblyObserved = false;
  status.lastAssemblyAt = null;
  status.lastEvaluatedAt = null;
  bootstrapped = true;
  markChanged();
}

/**
 * 仅在尚未初始化时执行 initialize()，返回是否真的做了一次初始化。
 *
 * 用途：`dsh-prompt-lab/ui`（本地接口组件）与 `dsh-prompt-lab`（提示词注入组件）是两个
 * 独立的 Cordis 实例，谁先起来并不确定。只开接口组件时（例如注入组件被单独关闭），
 * 状态从未初始化，面板会看到空配置列表；这里补一次初始化即可让接口单独可用。
 * 已经初始化过则直接返回 false，绝不重置运行期状态（求值文本、组装快照）。
 *
 * @param {{enabled?: boolean, prompt?: string}} [config] 插件配置。
 * @returns {boolean} 本次是否执行了初始化。
 */
export function ensureInitialized(config = {}) {
  if (bootstrapped) return false;
  initialize(config);
  return true;
}

// ── 面板设置（settings.json）──────────────────────────────────────────────

/** 上下文过滤模式的合法取值：off 原样 / strip 整段去除 / redact 保留结构只遮数值。 */
export const CONTEXT_FILTER_MODES = ["off", "strip", "redact"];

/** 设置的默认值：全部功能关闭，行为与未装本插件时一致。 */
const DEFAULT_SETTINGS = Object.freeze({ contextFilter: "off", identityBreak: false });

/**
 * 推导设置文件路径：与 profiles.json 同目录，便于一起备份迁移。
 *
 * @param {string} [home] 已知的主目录；缺省时按 derivePath() 反推。
 * @returns {string} settings.json 的绝对路径。
 */
function settingsPathOf(home) {
  const base = home || path.dirname(storePath || derivePath());
  return path.join(base, "settings.json");
}

/**
 * 从磁盘读取设置并做字段级校验；任何异常或非法值都回落到默认，不让坏文件影响启动。
 *
 * @param {string} home 主目录。
 * @returns {{contextFilter: string, identityBreak: boolean}} 合法化的设置对象（浅拷贝）。
 */
function loadSettings(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPathOf(home), "utf8"));
    return {
      contextFilter: CONTEXT_FILTER_MODES.includes(parsed?.contextFilter) ? parsed.contextFilter : "off",
      identityBreak: parsed?.identityBreak === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 原子化写回设置（临时文件 + rename，权限 0600），与 profiles.json 同一套纪律。
 *
 * @param {{contextFilter: string, identityBreak: boolean}} value 要落盘的设置对象。
 */
function persistSettings(value) {
  atomicWrite(settingsPathOf(), value);
}

/**
 * 处理面板的设置修改请求。支持部分更新：给哪个字段就校验并写哪个。
 * - contextFilter：必须是 CONTEXT_FILTER_MODES 之一；
 * - identityBreak：必须是布尔（渠道指纹脱敏开关）。
 * 先在内存中校验，再落盘；落盘失败直接抛出，运行期状态保持不变。
 *
 * @param {{contextFilter?: string, identityBreak?: boolean}} input 请求体。
 * @returns {object} 更新后的状态快照。
 */
export function updateSettings(input) {
  const next = { ...settings };
  if ("contextFilter" in (input || {})) {
    if (!CONTEXT_FILTER_MODES.includes(input.contextFilter)) {
      throw new Error("invalid contextFilter (off | strip | redact)");
    }
    next.contextFilter = input.contextFilter;
  }
  if ("identityBreak" in (input || {})) {
    if (typeof input.identityBreak !== "boolean") {
      throw new Error("identityBreak must be boolean");
    }
    next.identityBreak = input.identityBreak;
  }
  persistSettings(next);
  settings = next;
  configRevision += 1;
  markChanged();
  return snapshot();
}

/** 当前上下文过滤模式（注入侧的观察者每次组装都会读取）。 */
export function getContextFilter() {
  return settings.contextFilter;
}

/** 渠道指纹脱敏开关（与上下文过滤独立，可叠加）。 */
export function getIdentityBreak() {
  return settings.identityBreak === true;
}

export function getConfigRevision() {
  return configRevision;
}

export function observerSucceeded() {
  status.observerRegistered = true;
  markChanged();
}

/**
 * 把一条配置拼成最终注入文本：提示词正文 + 可选的“当前规则集”段落。
 *
 * @param {{prompt?: string, rules?: string}|undefined} profile 配置项。
 * @returns {string} 注入文本；没有提示词正文时返回空串（视为不注入）。
 */
function profileText(profile, rules = ruleSets) {
  const parts = profileParts(profile, rules);
  return [parts.prompt, parts.rules].filter(Boolean).join("\n\n");
}

function profileParts(profile, ruleSource = ruleSets) {
  if (!profile) return { prompt: "", rules: "" };
  const prompt = profile.promptEnabled ? profile.prompt.trim() : "";
  const attached = profile.rules.trim();
  const shared = profile.ruleIds.map(id => ruleSource.find(item => item.id === id))
    .filter(item => item?.enabled).map(item => `## ${item.name}\n${item.text.trim()}`);
  const rules = profile.rulesEnabled && (!profile.promptEnabled || profile.prompt.trim())
    ? [attached && `## 当前规则集\n${attached}`, ...shared].filter(Boolean).join("\n\n") : "";
  return { prompt, rules };
}

/**
 * 求值当前配置的注入文本——systemPrompt 段的 text() 回调实际执行的就是这里，
 * 因此每次组装系统提示词都会重新读取最新配置。
 *
 * @param {unknown} context 组装上下文：优先读取 agent.session.id 以匹配会话固定快照。
 * @returns {string} 本次应注入的提示词文本。
 */
export function evaluate(context, section = "combined") {
  if (!active) return "";
  const identity=contextIdentity(context),binding=bindingStore?.resolve(identity.sessionId);
  if(identity.sessionId&&bindingStore?.error)return '';
  const profile = binding?.profile || profiles.find((p) => p.id === selected);
  const rules=binding?.ruleSets || ruleSets;
  const text = profileText(profile,rules);
  lastFullText = text;
  status.chars = text.length;
  status.lastEvaluatedAt = new Date().toISOString();
  const returned = section === "combined" ? text : profileParts(profile,rules)[section];
  lastEvaluation = { ...identity, binding:binding?{sessionId:binding.sessionId,workspace:binding.workspace,profileId:profile.id,profileVersion:profile.version,hash:binding.hash}:null, text: returned, section, selected:profile.id, configRevision, evaluatedAt: status.lastEvaluatedAt };
  if (status.registered) status.phase = text ? "registered" : "empty-prompt";
  // 只标记「状态已变化」：全文留在 lastFullText 里供本地 UI 读取，不写任何日志。
  markChanged();
  return returned;
}

/** 标记提示词段注册成功。 */
export function registerSucceeded() {
  status.phase = status.chars ? "registered" : "empty-prompt";
  status.registered = true;
  markChanged();
}

/**
 * 标记本次未注册提示词段。
 *
 * @param {"disabled"|"empty"} reason 跳过原因：被显式关闭，或提示词为空。
 */
export function skipped(reason) {
  status.phase = reason === "disabled" ? "disabled" : "empty-prompt";
  markChanged();
}

/**
 * 标记注册失败并把状态置为错误。
 *
 * @param {unknown} error 捕获到的异常（仅用于保持调用点一致，不做记录）。
 */
export function failed(error) {
  status.phase = "error";
  markChanged();
}

/** 插件卸载时的收尾：重置状态并停用注入。 */
export function disposed() {
  status.phase = "disposed";
  status.registered = false;
  status.observerRegistered = false;
  status.enabled = false;
  active = false;
  configRevision += 1;
  markChanged();
}

/**
 * 捕获一次系统提示词组装快照（观察者回调中调用）。
 *
 * 会按 MAX_ASSEMBLY_TEXT 做总量截断，并在每条段上标注是否被截断；
 * 该快照只是事件观察结果，不代表模型 API 的最终请求正文。
 * contexts 一并记录（过滤后的最终形态），供面板核对上下文过滤是否生效。
 *
 * @param {{sections?: Array<{name?: string, order?: number, text?: unknown}>,
 *          contexts?: Array<{name?: string, text?: unknown}>}} assembly 组装结果。
 * @param {{contextFilter?: string, contextsRemoved?: number,
 *          identityBroken?: number, configRevision?: number,
 *          processingFailed?: boolean}} [meta] 本次应用的配置版本、过滤模式与处理计数。
 */
export function captureAssembly(assembly, meta = {}, context = {}) {
  if (!assembly || !Array.isArray(assembly.sections)) return;
  let total = 0;
  const sections = assembly.sections.map((section, index) => {
    const full = String(section?.text ?? "");
    // 剩余额度：跨段累计，额度用尽后后续段落的 text 为空串但仍保留字数统计。
    const remaining = Math.max(0, MAX_ASSEMBLY_TEXT - total);
    const text = full.slice(0, remaining);
    total += text.length;
    return {
      index,
      name: String(section?.name || `section-${index}`),
      // order 无法解析为有限数时记为 null，避免把 NaN 传给 UI。
      order: Number.isFinite(section?.order) ? section.order : null,
      chars: full.length,
      retainedChars: text.length,
      text,
      truncated: text.length !== full.length,
    };
  });
  // 动态上下文（过滤后）：每条只留名字与正文，字数上限与 sections 共享额度。
  const contexts = (Array.isArray(assembly.contexts) ? assembly.contexts : []).map((entry, index) => {
    const full = String(entry?.text ?? "");
    const remaining = Math.max(0, MAX_ASSEMBLY_TEXT - total);
    const text = full.slice(0, remaining);
    total += text.length;
    return {
      index,
      name: String(entry?.name || `context-${index}`),
      chars: full.length,
      retainedChars: text.length,
      text,
      truncated: text.length !== full.length,
    };
  });
  assembled = {
    capturedAt: new Date().toISOString(),
    scope: contextIdentity(context).sessionId ? 'session-assembly' : 'process',
    ...contextIdentity(context),
    configRevision: meta.configRevision ?? configRevision,
    processingFailed: meta.processingFailed === true,
    sections,
    sectionCount: sections.length,
    truncated: sections.some((item) => item.truncated) || contexts.some((item) => item.truncated),
    contexts,
    contextCount: contexts.length,
    contextFilter: CONTEXT_FILTER_MODES.includes(meta.contextFilter) ? meta.contextFilter : "off",
    contextsRemoved: Number.isFinite(meta.contextsRemoved) ? meta.contextsRemoved : 0,
    identityBroken: Number.isFinite(meta.identityBroken) ? meta.identityBroken : 0,
    note: "system-prompt/assemble 事件观察快照；可能仍有后续处理，不等于模型 API 最终请求",
  };
  status.assemblyObserved = true;
  status.lastAssemblyAt = assembled.capturedAt;
  markChanged();
}

/**
 * 生成给 UI 的只读快照。
 * 返回的状态、配置与组装快照都做了浅拷贝，调用方修改不会影响内部状态。
 *
 * 快照里没有任何事件历史（插件不记录日志）：只有当前状态、配置列表和最近一次组装结果。
 *
 * @returns {object} 状态快照对象。
 */
export function snapshot() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    // 状态版本号：客户端把它带回来做增量轮询（`GET /prompt-lab/api?since=<revision>`）。
    revision,
    configRevision,
    historyWarning,
    sessionBindings:bindingStore?.snapshot()||null,
    diagnostics:injectionDiagnostics({profiles,ruleSets,selected,status,configRevision,storeVersion,evaluation:lastEvaluation,assembly:assembled}),
    version: "0.6.3",
    limits: { profiles: MAX_PROFILES, ruleSets: MAX_RULE_SETS, text: MAX_PROFILE_TEXT, importBytes: MAX_IMPORT_BYTES },
    storage: { schemaVersion: SCHEMA_VERSION, storeVersion, needsMigration: loadedStore?.sourceVersion !== SCHEMA_VERSION,
      error: loadedStore?.error ?? null, backup: loadedStore?.backup ?? null },
    status: { ...status, selected },
    profiles: profiles.map((p) => ({ ...p, ruleIds: [...p.ruleIds] })),
    ruleSets: ruleSets.map(item => ({ ...item, usedBy: profiles.filter(p => p.ruleIds.includes(item.id)).map(p => ({ id: p.id, name: p.name })) })),
    selected,
    configuredPrompt: profileText(profiles.find((p) => p.id === selected)),
    evaluation: lastEvaluation && { ...lastEvaluation, stale: lastEvaluation.configRevision !== configRevision },
    // 优先返回最近一次真实求值结果；尚未求值时用当前配置现算一份，便于 UI 预览。
    effectivePrompt: lastFullText || (active ? profileText(profiles.find((p) => p.id === selected)) : ""),
    settings: { ...settings },
    assembly: assembled && {
      ...assembled,
      stale: assembled.configRevision !== configRevision,
      sections: assembled.sections.map((s) => ({ ...s })),
      contexts: assembled.contexts.map((c) => ({ ...c })),
    },
  };
}

/**
 * 原子化落盘：先写同目录临时文件，再 rename 覆盖，避免写入中断产生半截配置。
 * 文件权限设为 0600，因为其中可能含有自定义提示词。
 *
 * @param {Array<object>} nextProfiles 完整的配置列表。
 * @param {string} nextSelected 要记录的选中配置 id。
 */
function currentStore() {
  return { schemaVersion: SCHEMA_VERSION, storeVersion, selected, profiles, ruleSets };
}

function commit(next) {
  next=normalizeStore(next);
  const history=new RevisionStore(path.dirname(storePath||derivePath()));let ticket=null;
  try{ticket=history.prepare(currentStore(),next,loadedStore.fingerprint);historyWarning=null;}
  catch{historyWarning='版本记录暂不可用；本次保存将不承诺可回退，请保留导出备份。';}
  let saved;
  try{saved = persistStore(storePath || derivePath(), next, loadedStore);}
  catch(error){try{history.finish(ticket,false);}catch{}throw error;}
  loadedStore = saved;
  ({ profiles, ruleSets, selected, storeVersion } = saved.data);
  lastFullText = "";
  configRevision += 1;
  status.chars = active ? profileText(profiles.find(p => p.id === selected)).length : 0;
  if (status.registered) status.phase = status.chars ? "registered" : "empty-prompt";
  markChanged();
  try{history.finish(ticket,true);}catch{historyWarning='配置已保存，版本提交标记待恢复；可打开版本记录核对。';}
  return snapshot();
}

/**
 * 处理 UI 的配置修改请求（保存或启用）。
 *
 * 先构造新的配置数组并在内存中校验，确认无误后才落盘；
 * 落盘失败会直接抛出，此时运行期状态保持不变，UI 也会收到错误。
 *
 * @param {{action?: string, id?: string, prompt?: string, rules?: string}} input 请求体。
 * @returns {object} 更新后的状态快照。
 */
export function updateProfile(input, { requireVersion = false } = {}) {
  const action = String(input?.action || "").replace(/^profile\./, "");
  const next = { ...currentStore(), storeVersion: storeVersion + 1, profiles: profiles.map(p => ({ ...p, ruleIds: [...p.ruleIds] })) };
  if (action === "create") {
    if (profiles.length >= MAX_PROFILES) throw problem("最多 20 套配置");
    const item = normalizeProfile({ id: newId("p", new Set(profiles.map(p => p.id))), name: input.name,
      prompt: input.prompt ?? "使用简体中文回答。", rules: input.rules ?? "" });
    if (!item.prompt.trim()) throw problem("提示词正文不能为空");
    next.profiles.push(item);
    return { ...commit(next), editedId: item.id };
  }
  const index = profiles.findIndex(p => p.id === input?.id);
  if (index < 0) throw problem("配置不存在，请刷新列表");
  const previous = profiles[index];
  assertVersion(previous, input.expectedVersion, action === "activate" ? false : requireVersion);
  if (action === "activate") next.selected = previous.id;
  else if (action === "duplicate") {
    if (profiles.length >= MAX_PROFILES) throw problem("最多 20 套配置");
    const item = normalizeProfile({ ...previous, id: newId("p", new Set(profiles.map(p => p.id))), version: 1,
      name: input.name ?? `${previous.name.slice(0,76)} 副本` });
    next.profiles.push(item);
    return { ...commit(next), editedId: item.id };
  } else if (action === "delete") {
    if (input.confirm !== true) throw problem("删除配置需要确认");
    if (profiles.length === 1) throw problem("不能删除最后一套配置");
    next.profiles.splice(index, 1);
    if (selected === previous.id) {
      if (!next.profiles.some(p => p.id === input.fallbackId)) throw problem("删除启用配置须指定有效的回退配置");
      next.selected = input.fallbackId;
    }
  } else if (action === "save" || action === "rename") {
    const item = normalizeProfile({ ...previous,
      ...(action === "rename" ? { name: input.name } : { prompt: input.prompt, rules: input.rules,
        ruleIds: input.ruleIds ?? previous.ruleIds, promptEnabled: input.promptEnabled ?? previous.promptEnabled,
        rulesEnabled: input.rulesEnabled ?? previous.rulesEnabled }), version: previous.version + 1 });
    if (item.promptEnabled && !item.prompt.trim()) throw problem("提示词正文不能为空");
    next.profiles[index] = item;
  } else throw problem("未知的配置动作");
  return commit(next);
}

export function updateRule(input, { requireVersion = false } = {}) {
  const action = String(input?.action || "").replace(/^rule\./, "");
  const next = { ...currentStore(), storeVersion: storeVersion + 1, ruleSets: ruleSets.map(r => ({ ...r })) };
  if (action === "create") {
    if (ruleSets.length >= MAX_RULE_SETS) throw problem("最多 50 套规则");
    const item = normalizeRule({ id: newId("r", new Set(ruleSets.map(r => r.id))), name: input.name, text: input.text ?? "请补充规则内容。", enabled: input.enabled ?? true });
    next.ruleSets.push(item);
    return { ...commit(next), editedRuleId: item.id };
  }
  const index = ruleSets.findIndex(r => r.id === input?.id);
  if (index < 0) throw problem("规则集不存在，请刷新列表");
  const previous = ruleSets[index];
  assertVersion(previous, input.expectedVersion, requireVersion);
  if (action === "duplicate") {
    if (ruleSets.length >= MAX_RULE_SETS) throw problem("最多 50 套规则");
    const item = normalizeRule({ ...previous, id: newId("r", new Set(ruleSets.map(r => r.id))), version: 1,
      name: input.name ?? `${previous.name.slice(0,76)} 副本` });
    next.ruleSets.push(item);
    return { ...commit(next), editedRuleId: item.id };
  } else if (action === "delete") {
    const usedBy = profiles.filter(p => p.ruleIds.includes(previous.id));
    if (usedBy.length) throw problem(`规则仍被配置引用，请先解除引用：${usedBy.map(p => p.name).join("、")}`, 409);
    if (input.confirm !== true) throw problem("删除规则需要确认");
    next.ruleSets.splice(index, 1);
  } else if (action === "save" || action === "rename") {
    next.ruleSets[index] = normalizeRule({ ...previous, name: input.name ?? previous.name,
      text: input.text ?? previous.text, enabled: input.enabled ?? previous.enabled, version: previous.version + 1 });
  } else throw problem("未知的规则动作");
  return commit(next);
}

export function exportData(kind, id) { return exportBundle(currentStore(), kind, id); }
export function previewImport(bundle) { return previewBundle(currentStore(), bundle); }
export function importData(bundle, expectedStoreVersion) { return commit(mergeBundle(currentStore(), bundle, expectedStoreVersion)); }

/** Studio writes profiles + new rules in one store transaction; generation never calls this. */
export function applyStudioCandidate(candidate, input, beforeCommit) {
  const store = currentStore();
  if (input.expectedStoreVersion !== storeVersion) throw problem('采用前数据已变化，请刷新后重新比较；候选已保留', 409);
  const base = candidate.base;
  const original = profiles.find(p => p.id === base.profileId);
  if (!original || original.version !== base.profileVersion) throw problem('生成依据的配置已变化，请重新生成或比较；候选已保留', 409);
  for (const [id, version] of Object.entries(base.ruleVersions)) {
    if (ruleSets.find(r => r.id === id)?.version !== version) throw problem('生成依据的共享规则已变化；候选已保留', 409);
  }
  if (!['profile', 'rules'].includes(input.mode)) throw problem('采用方式无效');
  if (!Array.isArray(input.indices) || new Set(input.indices).size !== input.indices.length || input.indices.some(i => !Number.isInteger(i) || i < 0 || i >= candidate.content.ruleSuggestions.length)) throw problem('所选规则无效');
  if (input.mode === 'profile' && !candidate.content.prompt.trim()) throw problem('规则候选没有方案正文，请保存为规则');
  if (input.mode === 'rules' && !input.indices.length) throw problem('至少选择一条规则');
  if (input.mode === 'profile' && profiles.length >= MAX_PROFILES) throw problem('最多 20 套配置；候选已保留，请先整理旧配置');
  const next = { ...store, storeVersion: storeVersion + 1, profiles: [...profiles], ruleSets: [...ruleSets] };
  const ruleIds = input.mode === 'profile' ? [...candidate.content.retainedRuleIds] : [];
  const createdRuleIds = [];
  const insertRule=(id,suggestion)=>{
    const replaces=suggestion.replacesRuleIds||(suggestion.action==='copy'?[suggestion.existingRuleId]:[]);
    const at=ruleIds.findIndex(existing=>replaces.includes(existing));
    for(let i=ruleIds.length-1;i>=0;i--)if(replaces.includes(ruleIds[i]))ruleIds.splice(i,1);
    if(!ruleIds.includes(id))ruleIds.splice(at<0?ruleIds.length:at,0,id);
  };
  for (const index of input.indices) {
    const suggestion = candidate.content.ruleSuggestions[index];
    if (suggestion.action === 'reuse') {
      insertRule(suggestion.existingRuleId,suggestion);
      continue;
    }
    if (next.ruleSets.length >= MAX_RULE_SETS) throw problem('规则数超过 50；未保存任何方案或规则，候选已保留');
    const rule = normalizeRule({ id: newId('r', new Set(next.ruleSets.map(r => r.id))), name: suggestion.name, text: suggestion.text, enabled: true });
    next.ruleSets.push(rule); createdRuleIds.push(rule.id);
    insertRule(rule.id,suggestion);
  }
  let editedId = null;
  if (input.mode === 'profile') {
    const profile = normalizeProfile({ id: newId('p', new Set(profiles.map(p => p.id))), name: input.name ?? candidate.content.name,
      prompt: candidate.content.prompt, rules: candidate.content.rules, ruleIds: [...new Set(ruleIds)],
      promptEnabled: true, rulesEnabled: base.draft?.rulesEnabled !== false });
    next.profiles.push(profile); editedId = profile.id;
  }
  const receipt = { editedId, createdRuleIds, reusedRuleIds: ruleIds.filter(id => !createdRuleIds.includes(id)),
    beforeFingerprint: loadedStore.fingerprint, beforeStoreVersion: storeVersion, mode: input.mode };
  beforeCommit(receipt);
  const result = editedId || createdRuleIds.length ? commit(next) : snapshot();
  return { ...result, editedId, editedRuleId: createdRuleIds[0] || ruleIds[0] || null, studioReceipt: receipt };
}
export function studioStorageDirectory() { return path.dirname(storePath || derivePath()); }
export function restoreStudioRevision(input){
  if(input.expectedStoreVersion!==storeVersion)throw problem('回退前数据已变化，请重新核对',409);
  const history=new RevisionStore(studioStorageDirectory()),record=history.get(input.revisionId);
  if(!['before','after'].includes(input.side))throw problem('快照方向无效');
  const old=normalizeStore(record[input.side]),next={...currentStore(),storeVersion:storeVersion+1,profiles:profiles.map(p=>({...p,ruleIds:[...p.ruleIds]})),ruleSets:[...ruleSets]};
  const restoreRule=rule=>{
    const identical=next.ruleSets.find(r=>r.id===rule.id&&r.name===rule.name&&r.text===rule.text&&r.enabled===rule.enabled);
    if(identical)return identical.id;
    if(next.ruleSets.length>=MAX_RULE_SETS)throw problem('恢复将超过规则上限，未修改数据');
    const copied=normalizeRule({...rule,id:newId('r',new Set(next.ruleSets.map(r=>r.id))),version:1});next.ruleSets.push(copied);return copied.id;
  };
  if(input.ruleId){
    const rule=old.ruleSets.find(r=>r.id===input.ruleId);if(!rule)throw problem('快照没有该规则');
    if(next.ruleSets.length>=MAX_RULE_SETS)throw problem('恢复将超过规则上限，未修改数据');
    const copied=normalizeRule({...rule,id:newId('r',new Set(next.ruleSets.map(r=>r.id))),version:1});next.ruleSets.push(copied);return {...commit(next),editedRuleId:copied.id};
  }
  const profile=old.profiles.find(p=>p.id===input.profileId);if(!profile)throw problem('快照没有该配置');
  let id;
  if(input.mode==='replace'){
    if(input.confirm!==true)throw problem('替换保存配置需要明确确认');
    const index=next.profiles.findIndex(p=>p.id===input.targetId);if(index<0)throw problem('目标配置不存在',409);
    assertVersion(next.profiles[index],input.expectedVersion,true);id=next.profiles[index].id;
    next.profiles[index]=normalizeProfile({...profile,id,version:next.profiles[index].version+1,ruleIds:profile.ruleIds.map(ruleId=>restoreRule(old.ruleSets.find(r=>r.id===ruleId)))});
  }else if(input.mode==='copy'){
    if(next.profiles.length>=MAX_PROFILES)throw problem('恢复将超过 20 套配置，未修改数据');
    id=newId('p',new Set(next.profiles.map(p=>p.id)));next.profiles.push(normalizeProfile({...profile,id,version:1,name:input.name||`${profile.name.slice(0,72)} 恢复`,ruleIds:profile.ruleIds.map(ruleId=>restoreRule(old.ruleSets.find(r=>r.id===ruleId)))}));
  }else throw problem('恢复方式无效');
  return {...commit(next),editedId:id};
}
export function analyzeStudioRules(){
  const key=text=>text.replace(/\s+/g,' ').trim(),groups=new Map();
  for(const rule of ruleSets){const k=key(rule.text);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(rule.id);}
  return {ok:true,storeVersion,duplicates:[...groups.values()].filter(ids=>ids.length>1),rules:ruleSets.map(r=>({...r,usedBy:profiles.filter(p=>p.ruleIds.includes(r.id)).map(p=>({id:p.id,name:p.name}))}))};
}
export function maintainStudioRules(input){
  if(input.expectedStoreVersion!==storeVersion)throw problem('规则引用已变化，请重新核对',409);
  if(input.confirm!==true||!['delete','disable'].includes(input.mode)||!Array.isArray(input.ids)||!input.ids.length||new Set(input.ids).size!==input.ids.length)throw problem('规则维护需要选择项目并明确确认');
  const chosen=input.ids.map(id=>{const rule=ruleSets.find(r=>r.id===id);if(!rule)throw problem('规则不存在',409);assertVersion(rule,input.versions?.[id],true);return rule;});
  if(input.mode==='delete'&&profiles.some(p=>p.ruleIds.some(id=>input.ids.includes(id))))throw problem('所选规则仍被配置引用，不能删除',409);
  const next={...currentStore(),storeVersion:storeVersion+1,ruleSets:input.mode==='delete'?ruleSets.filter(r=>!input.ids.includes(r.id)):ruleSets.map(r=>chosen.includes(r)?{...r,enabled:false,version:r.version+1}:r)};
  return commit(next);
}

/** 仅供单元测试使用：把模块级状态复位到初始值。 */
export function resetForTests() {
  active = false;
  storePath = "";
  selected = "default";
  profiles = [];
  ruleSets = [];
  storeVersion = 1;
  loadedStore = null;
  assembled = null;
  lastFullText = "";
  revision = 0;
  configRevision = 0;
  lastEvaluation = null;
  bootstrapped = false;
  bindingStore=null;
  settings = { contextFilter: "off", identityBreak: false };
  status.phase = "not-started";
  status.registered = false;
  status.observerRegistered = false;
  status.enabled = null;
  status.chars = 0;
  status.lastEvaluatedAt = null;
  status.assemblyObserved = false;
  status.lastAssemblyAt = null;
}

/** Preview and commit a session pin without changing global activation or asset files. */
export function previewSessionBinding(request,session){
  ensureInitialized();const profile=profiles.find(p=>p.id===request.profileId);
  if(!profile)throw problem('所选配置不存在',409);
  return {ok:true,draft:frozenBinding(profile,ruleSets,session),revision:bindingStore.snapshot().revision};
}
export function updateSessionBinding(request,session){
  ensureInitialized();const draft=request.action==='binding.save'?previewSessionBinding(request,session).draft:null;
  bindingStore.commit(request,draft);configRevision++;markChanged();return snapshot();
}

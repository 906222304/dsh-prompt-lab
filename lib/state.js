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

// 单条配置正文（提示词或规则）允许的最大字符数。导出给本地接口推算请求体上限用。
export const MAX_PROFILE_TEXT = 64000;
// 单次组装快照累计保留的最大字符数，防止超大提示词把内存占满。
const MAX_ASSEMBLY_TEXT = 240000;

// 状态版本号：每次状态变化自增。UI 用它做增量轮询——版本没变就不必重发整份快照。
let revision = 0;
// 是否已经执行过 initialize()；供 ensureInitialized() 判断，避免重复初始化把运行期状态清掉。
let bootstrapped = false;
// 配置文件绝对路径，由 initialize() 依据 DSH_HOME 推导。
let storePath = "";
// 当前启用（生效）的配置 id。
let selected = "default";
// 当前配置列表：内置配置，或从磁盘载入并通过校验的配置。
let profiles = [];
// 插件是否启用，对应 config.enabled。
let active = false;
// 最近一次 text() 求值返回的完整提示词，供 UI 展示“实际注入内容”。
let lastFullText = "";
// 最近一次观察到的系统提示词组装快照，结构见 captureAssembly()。
let assembled = null;
// 面板设置（settings.json）：上下文过滤模式 + 渠道指纹脱敏开关，后续开关都落在这里。
let settings = { contextFilter: "off", identityBreak: false };

// 对外暴露的状态摘要，随 snapshot() 一起返回给 UI。
const status = {
  // 生命周期阶段：not-started / starting / registered / disabled / empty-prompt / error / disposed
  phase: "not-started",
  // 是否启用；null 表示尚未执行 initialize()。
  enabled: null,
  // 提示词段是否注册成功。
  registered: false,
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
function validProfile(item) {
  return Boolean(item && typeof item.id === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(item.id)
    && typeof item.name === "string" && item.name.length >= 1 && item.name.length <= 80
    && typeof item.prompt === "string" && item.prompt.length <= MAX_PROFILE_TEXT
    && typeof item.rules === "string" && item.rules.length <= MAX_PROFILE_TEXT);
}

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
  // cordis.patch.yml 的提示词只用作默认配置的初始正文。
  const first = typeof config.prompt === "string" ? config.prompt.trim() : "";
  storePath = derivePath();
  profiles = builtins(first);
  selected = "default";
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    // 逐层校验：条数上限、逐项合法性、id 不重复，任一不满足就整体回退到内置配置。
    if (Array.isArray(parsed.profiles) && parsed.profiles.length >= 1
        && parsed.profiles.length <= 20 && parsed.profiles.every(validProfile)
        && new Set(parsed.profiles.map((x) => x.id)).size === parsed.profiles.length) {
      profiles = parsed.profiles.map((item) => ({ ...item }));
      // 只有磁盘上记录的选中项确实存在时才沿用，否则保持默认。
      if (profiles.some((p) => p.id === parsed.selected)) selected = parsed.selected;
    }
    // 数据不合法时什么都不做：上面 profiles 已经是 builtins() 的兜底结果。
  } catch {
    // 首次运行没有配置文件（ENOENT）或读取失败：同样沿用内置配置。
  }
  // 载入面板设置：文件缺失或内容非法都回落到默认（全部功能关闭）。
  // 注意 storePath 指向 profiles.json 这个文件，设置与它同目录。
  settings = loadSettings(path.dirname(storePath));
  active = config.enabled !== false;
  // 清空上一次生命周期的求值与快照结果。
  assembled = null;
  lastFullText = "";
  status.phase = "starting";
  status.enabled = active;
  status.registered = false;
  status.chars = 0;
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
  const dest = settingsPathOf();
  const base = path.dirname(dest);
  fs.mkdirSync(base, { recursive: true });
  const temporary = dest + `.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, dest);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* ignore */ }
  }
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

/**
 * 把一条配置拼成最终注入文本：提示词正文 + 可选的“当前规则集”段落。
 *
 * @param {{prompt?: string, rules?: string}|undefined} profile 配置项。
 * @returns {string} 注入文本；没有提示词正文时返回空串（视为不注入）。
 */
function profileText(profile) {
  if (!profile) return "";
  const prompt = profile.prompt.trim();
  const rules = profile.rules.trim();
  if (!prompt) return "";
  return rules ? `${prompt}\n\n## 当前规则集\n${rules}` : prompt;
}

/**
 * 求值当前配置的注入文本——systemPrompt 段的 text() 回调实际执行的就是这里，
 * 因此每次组装系统提示词都会重新读取最新配置。
 *
 * @param {unknown} context 组装上下文（当前未使用，保留以匹配宿主回调签名）。
 * @returns {string} 本次应注入的提示词文本。
 */
export function evaluate(context) {
  if (!active) return "";
  const profile = profiles.find((p) => p.id === selected);
  const text = profileText(profile);
  lastFullText = text;
  status.chars = text.length;
  status.lastEvaluatedAt = new Date().toISOString();
  // 只标记「状态已变化」：全文留在 lastFullText 里供本地 UI 读取，不写任何日志。
  markChanged();
  return text;
}

/** 标记提示词段注册成功。 */
export function registerSucceeded() {
  status.phase = "registered";
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
  active = false;
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
 *          identityBroken?: number}} [meta] 本次应用的过滤模式与处理计数。
 */
export function captureAssembly(assembly, meta = {}) {
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
      text,
    };
  });
  assembled = {
    capturedAt: new Date().toISOString(),
    sections,
    sectionCount: sections.length,
    truncated: sections.some((item) => item.truncated),
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
    status: { ...status, selected },
    profiles: profiles.map((p) => ({ ...p })),
    selected,
    // 优先返回最近一次真实求值结果；尚未求值时用当前配置现算一份，便于 UI 预览。
    effectivePrompt: lastFullText || (active ? profileText(profiles.find((p) => p.id === selected)) : ""),
    settings: { ...settings },
    assembly: assembled && {
      ...assembled,
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
function persist(nextProfiles, nextSelected) {
  const dest = storePath || derivePath();
  const base = path.dirname(dest);
  fs.mkdirSync(base, { recursive: true });
  // 带 pid 的临时名可避免多个实例互相覆盖。
  const temporary = dest + `.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ selected: nextSelected, profiles: nextProfiles }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, dest);
  } finally {
    // 失败时清理临时文件，避免残留垃圾；清理失败不影响主错误抛出。
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* ignore */ }
  }
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
export function updateProfile(input) {
  if (!active) throw new Error("prompt-lab is disabled");
  const { action, id } = input || {};
  if (typeof id !== "string") throw new Error("missing profile id");
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error("unknown profile: " + id);
  // 基于副本修改，保证校验失败时原状态不受影响。
  const nextProfiles = profiles.map((p) => ({ ...p }));
  let nextSelected = selected;
  if (action === "activate") {
    nextSelected = id;
  } else if (action === "save") {
    const { prompt, rules } = input;
    if (typeof prompt !== "string" || typeof rules !== "string") throw new Error("prompt and rules must be strings");
    const profile = { ...nextProfiles[idx], prompt, rules };
    // 空正文或超出长度上限都视为非法，直接拒绝。
    if (!validProfile(profile) || !prompt.trim()) throw new Error("invalid or empty prompt, or profile text too large");
    nextProfiles[idx] = profile;
  } else {
    throw new Error("unknown action");
  }
  // 落盘失败时不改变运行期状态。
  persist(nextProfiles, nextSelected);
  profiles = nextProfiles;
  selected = nextSelected;
  // 新提示词要到下一次求值才生效；不要声称它已经被发送。
  lastFullText = "";
  assembled = null;
  status.assemblyObserved = false;
  status.lastAssemblyAt = null;
  status.chars = profileText(profiles.find((p) => p.id === selected)).length;
  markChanged();
  return snapshot();
}

/** 仅供单元测试使用：把模块级状态复位到初始值。 */
export function resetForTests() {
  active = false;
  storePath = "";
  selected = "default";
  profiles = [];
  assembled = null;
  lastFullText = "";
  revision = 0;
  bootstrapped = false;
  settings = { contextFilter: "off", identityBreak: false };
  status.phase = "not-started";
  status.registered = false;
  status.enabled = null;
}

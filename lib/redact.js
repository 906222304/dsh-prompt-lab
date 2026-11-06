/**
 * 运行时上下文过滤与渠道指纹脱敏：对组装结果（sections + contexts）做请求路径上的后处理。
 *
 * 背景：宿主每轮请求都会把 `assembly.contexts`（工作目录、文件沙箱策略、审批策略、
 * Harness 源码路径、Web GUI 地址等贡献）渲染成一段
 * “Current runtime context. This snapshot supersedes earlier runtime-context snapshots. …”
 * 追加进模型上下文，同时出现在轨迹（Trajectory）的请求记录里。本模块在
 * `system-prompt/assemble` 事件里对返回结果做后处理：
 * - strip  ：contexts 整组清空（模型与轨迹都不再出现这段）；
 * - redact ：保留每条贡献的结构与功能句，只把路径 / URL / 时间戳换成占位符；
 * - off    ：原样返回（同一引用，零改写）。
 *
 * 渠道指纹脱敏（identityBreak）：WorkBuddy 国内网关对 system/assistant 消息做
 * 大小写不敏感的**精确子串匹配**，命中“已知第三方 agent 身份句”清单即回 400/11128
 * （dsh-connect-workbuddy #113/#125 与 5.8.1 的实测；magpie#205 同机制）。
 * DSH 提示词里有三处这样的 span——coding-agent 身份句（带模型名）、Harness 身份句、
 * Web GUI 说明段——任一处原样上线都会被拒，且**三处全改才 200**。
 * 修法照抄 5.8.1 的 breakIdentityClauses：在命中的 span 内部**每个词界后插一个
 * U+200B 零宽空格**——网关的子串匹配失配，模型读到的每个词不变（真实 10,818 字
 * 提示只 +0.26% 字节）。清单是实测快照，网关加词条时需要同步补 IDENTITY_SPANS。
 *
 * 约束：绝不原地修改传入的 assembly（宿主可能复用同一对象），一律返回新对象；
 * off 或输入不合法时返回原引用，保证与未启用本功能时行为逐字节一致。
 */

// 脱敏用的替换表：顺序即优先级。带引号的形态放前面（宿主用 JSON.stringify 渲染值，
// 引号内允许空格，例如 "D:\app\tool\DeepSeek Harness\resources\..."），裸形态兜底。
const MASK_RULES = [
  // 带引号的 URL，如 "http://127.0.0.1:61133"
  [/"https?:\/\/[^"]*"/g, '"<URL>"'],
  // 裸 URL（含端口）
  [/https?:\/\/[^\s"'<>]+/g, "<URL>"],
  // 带引号的 Windows 路径（可含空格），如 "D:\app\tool\DeepSeek Harness\x"
  [/"(?:[A-Za-z]:\\{1,2}|\\\\)[^"]*"/g, '"<路径>"'],
  // 裸 Windows 路径，如 D:\private\x
  [/(?:[A-Za-z]:\\{1,2}|\\\\)[^\s"'<>]+/g, "<路径>"],
  // 带引号的 Unix 路径，如 "/home/y/.dsh"
  [/"\/(?:home|Users|root|var|opt|app|tmp|etc|mnt|srv)\/[^"]*"/g, '"<路径>"'],
  // 裸 Unix 路径
  [/\/(?:home|Users|root|var|opt|app|tmp|etc|mnt|srv)\/[^\s"'<>]+/g, "<路径>"],
  // ISO 时间戳，如 2026-10-28T12:39:09+08:00
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?/g, "<时间>"],
];

/**
 * 对单段文本做脱敏：按 MASK_RULES 依次替换。
 * 只动“值”，不动句子结构，因此 approval/delegation 这类功能句原样保留。
 *
 * @param {string} text 待脱敏文本。
 * @returns {string} 脱敏后的文本；没有可命中内容时返回原字符串。
 */
export function maskText(text) {
  let out = String(text ?? "");
  for (const [pattern, replacement] of MASK_RULES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * 对一份组装结果应用上下文过滤。纯函数：不修改入参。
 *
 * @param {{contexts?: unknown}} assembly 组装结果（只关心 contexts 字段）。
 * @param {"off"|"strip"|"redact"} mode 过滤模式。
 * @returns {object} off 或无可过滤内容时返回原引用；否则返回 contexts 处理过的新对象。
 */
export function applyContextFilter(assembly, mode) {
  if (mode !== "strip" && mode !== "redact") return assembly;
  if (!assembly || typeof assembly !== "object") return assembly;
  if (!Array.isArray(assembly.contexts) || assembly.contexts.length === 0) return assembly;
  if (mode === "strip") {
    return { ...assembly, contexts: [] };
  }
  return {
    ...assembly,
    contexts: assembly.contexts.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const text = typeof entry.text === "string" ? entry.text : String(entry.text ?? "");
      return { ...entry, text: maskText(text) };
    }),
  };
}

// ── 渠道指纹脱敏（identityBreak）───────────────────────────────────────────

// 零宽空格（U+200B）：插在词界后破坏网关的精确子串匹配，模型读取与分词几乎不受影响。
// 注意：这里是一个不可见的字面字符，代码评审看不出来——tests 里有一条用例专门钉住
// 它的码点必须是 0x200B，谁改坏这个字符测试立刻红。
const ZWSP = "​";

/**
 * 已知的网关拦截 span 清单（大小写不敏感）。来源：dsh-connect-workbuddy
 * #113/#125 与 4.13.0/4.15.0/5.8.1 的真实网关矩阵实测。
 * 这是快照：网关新增词条时在此追加，模式只锚定句首固定词，模型名等可变部分放宽。
 */
const IDENTITY_SPANS = [
  // coding-agent 身份句（首行，模型名可变）：
  // "…powered by the workbuddy/cn:deepseek-v4.1-flash model." / "…powered by the model." 都要命中，
  // 因此变量段不强制独立空格——懒惰匹配到最近的 "model." 为止。
  /You are a coding agent powered by [^\n]{0,120}?model\./gi,
  // harness:identity 身份句
  /You are an AI agent powered by DeepSeek Harness\.?/gi,
  // Web GUI 说明段（约 221 字 span 的开头固定词；只要破坏前缀，整段子串即失配）
  /You are interacting with the user through the DeepSeek Harness Web GUI/gi,
  // Harness 来源 / Web GUI 地址说明行（harness-source / web-surface 贡献）
  /DeepSeek Harness implementation checkout/gi,
  /DeepSeek Harness Web GUI URL/gi,
];

/**
 * 破坏一段命中 span：在每个词界（空白串前）后插入 U+200B。
 * 只动匹配到的 span 内部，span 外的文本一个字符都不动。
 *
 * @param {string} text 全文。
 * @returns {string} 处理后的全文；没有命中时返回原字符串。
 */
export function breakIdentityText(text) {
  let out = String(text ?? "");
  for (const pattern of IDENTITY_SPANS) {
    out = out.replace(pattern, (span) => span.replace(/\s+/g, (m) => ZWSP + m));
  }
  return out;
}

/**
 * 对一份组装结果的 sections 与 contexts 应用渠道指纹脱敏。纯函数：不修改入参。
 *
 * @param {object} assembly 组装结果。
 * @returns {{assembly: object, broken: number}} broken 为命中的 section/context 条数；
 *   没有任何命中时 assembly 是原引用、broken 为 0。
 */
export function applyIdentityBreak(assembly) {
  if (!assembly || typeof assembly !== "object") return { assembly, broken: 0 };
  let broken = 0;

  let sections = assembly.sections;
  if (Array.isArray(sections)) {
    const next = sections.map((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string") return entry;
      const text = breakIdentityText(entry.text);
      return text === entry.text ? entry : (broken += 1, { ...entry, text });
    });
    if (broken > 0) sections = next;
  }

  let contexts = assembly.contexts;
  if (Array.isArray(contexts)) {
    const before = broken;
    const next = contexts.map((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string") return entry;
      const text = breakIdentityText(entry.text);
      return text === entry.text ? entry : (broken += 1, { ...entry, text });
    });
    if (broken > before) contexts = next;
  }

  if (broken === 0) return { assembly, broken: 0 };
  return { assembly: { ...assembly, sections, contexts }, broken };
}

/**
 * 提示词（Prompt Lab）的本地 HTTP 接口（宿主进程侧）。
 *
 * 面向 DSH 桌面 UI 的本地读写桥：GET 返回状态快照，POST 保存 / 启用配置。
 * 这是与 lib/index.js 相互独立的 Cordis 实例：它只依赖 webServer，
 * 绝不依赖 systemPrompt，否则在纯 Web 场景下会因缺少依赖而无法加载。
 */
import { snapshot, updateProfile, updateSettings, updateRule, exportData, previewImport, importData,
  ensureInitialized, MAX_PROFILE_TEXT } from "./state.js";
import { MAX_IMPORT_BYTES } from "./store.js";
import {ASSET_LIMITS} from "./studio/asset-package.js";
import { dispatchStudio } from "./studio/runtime.js";

export const name = "dsh-prompt-lab-ui";
// 只依赖 webServer，用于注册本地接口路由。
export const inject = ["webServer"];

// 字段长度按 JS UTF-16 单元计数；每单元 JSON 最坏可写成 6 字节的 \uXXXX。
// 为正文和规则各预留完整转义空间，另留元数据余量；仍在解析后校验字段长度。
export const MAX_REQUEST_BYTES = MAX_PROFILE_TEXT * 2 * 6 + 20000;

/**
 * 以 JSON 形式返回响应。
 * 统一设置响应头：禁止缓存、禁止内容嗅探，并显式给出内容长度。
 *
 * @param {import("node:http").ServerResponse} res HTTP 响应对象。
 * @param {number} code HTTP 状态码。
 * @param {unknown} value 需要序列化为 JSON 的任意值。
 */
function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 判断请求是否来自本机回环地址。
 *
 * @param {string} remote socket 对端地址。
 * @returns {boolean} 是否为回环地址（含 IPv4-mapped IPv6 形式）。
 */
function isLoopback(remote) {
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

/**
 * 请求准入校验：回环地址 + 受信任 Host + 自定义请求头 + 同源 Origin。
 *
 * 自定义头 x-prompt-lab-ui 是关键一环：跨站表单无法在不触发 CORS 预检的情况下携带它，
 * 因此可以挡住 CSRF；Origin 校验则进一步限制为同源或桌面 webview。
 *
 * @param {import("node:http").IncomingMessage} req HTTP 请求对象。
 * @returns {boolean} 是否允许处理该请求。
 */
function allowed(req) {
  const remote = req.socket?.remoteAddress || "";
  if (!isLoopback(remote)) return false;
  const host = String(req.headers.host || "");
  // Host 必须是本机名，防止 DNS rebinding 把外部域名解析到 127.0.0.1。
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return false;
  // 跨站表单请求在无 CORS 预检的情况下无法携带这个自定义头。
  if (req.headers["x-prompt-lab-ui"] !== "1") return false;
  const origin = req.headers.origin;
  // 无 Origin 头（如同源导航、命令行工具）视为可信。
  if (origin === undefined || origin === "") return true;
  // null 与 app: 来自桌面 webview。
  if (origin === "null" || /^app:/i.test(origin)) return true; // 桌面 webview
  try { return new URL(origin).host === host; } catch { return false; }
}

/**
 * 读取并解析请求体 JSON，带大小上限与一次性结束保证。
 *
 * @param {import("node:http").IncomingMessage} req HTTP 请求对象。
 * @returns {Promise<unknown>} 解析后的 JSON 值。
 */
function readJson(req, limit = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // done 保证 resolve/reject 只发生一次，并让后续 data 事件直接短路。
    let done = false;
    const fail = (error) => { if (!done) { done = true; reject(error); } };
    req.on("data", (chunk) => {
      if (done) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        fail(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", fail);
    req.on("aborted", () => fail(new Error("request aborted")));
  });
}

/**
 * 读取查询串里的 `since` 版本号，用于增量轮询。
 *
 * @param {import("node:http").IncomingMessage} req HTTP 请求对象。
 * @returns {number} 客户端持有的版本号；缺失或非法时返回 0，表示要全量快照。
 */
function readSince(req) {
  try {
    const value = Number(new URL(String(req.url || "/"), "http://localhost").searchParams.get("since"));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  } catch { return 0; }
}

/**
 * 路由处理函数：GET 返回状态快照（带 `since` 时只回「未变化」），POST 修改配置。
 * 参数类错误返回 400，写盘类错误返回 500，便于 UI 区分“配置不合法”和“落盘失败”。
 *
 * @param {import("node:http").IncomingMessage} req HTTP 请求对象。
 * @param {import("node:http").ServerResponse} res HTTP 响应对象。
 */
export async function handler(req, res) {
  if (!allowed(req)) {
    json(res, 403, { ok: false, error: "This inspector accepts only local desktop UI requests" });
    return;
  }
  try{ensureInitialized();}catch(error){json(res,error.statusCode||503,{ok:false,error:error.message});return;}
  if (req.method === "GET") {
    const query = new URL(String(req.url || "/"), "http://localhost");
    if (["/prompt-lab/api/studio","/prompt-lab/api/assets"].includes(query.pathname)) {
      try { json(res,200,await dispatchStudio(req,query.searchParams)); }
      catch(error) { json(res,error.statusCode||500,{ok:false,error:String(error.message)}); }
      return;
    }
    if (query.pathname === "/prompt-lab/api/export") {
      try { json(res, 200, { ok: true, bundle: exportData(query.searchParams.get("kind") || "all", query.searchParams.get("id")) }); }
      catch (error) { json(res, error.statusCode || 400, { ok: false, error: error.message }); }
      return;
    }
    const current = snapshot();
    const since = readSince(req);
    // 增量轮询：客户端带来的版本号与当前一致，说明状态没变，只回一个极小的响应，
    // 不必每 3 秒把组装快照里的全文重复下发一遍。
    if (since > 0 && since === current.revision) {
      json(res, 200, { ok: true, unchanged: true, revision: current.revision });
      return;
    }
    json(res, 200, current);
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "GET or POST only" });
    return;
  }
  // 只接受 JSON 请求体，其他 content-type 一律拒绝。
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
    json(res, 415, { ok: false, error: "application/json required" });
    return;
  }
  try {
    const importing = new URL(String(req.url || "/"), "http://localhost").pathname === "/prompt-lab/api/import";
    const fullAssets=new URL(String(req.url||"/"),"http://localhost").pathname === "/prompt-lab/api/assets";
    const request = await readJson(req, fullAssets?ASSET_LIMITS.bytes+65536:importing ? MAX_IMPORT_BYTES : MAX_REQUEST_BYTES);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("JSON object required");
    const endpoint=new URL(String(req.url||"/"),"http://localhost");
    if (["/prompt-lab/api/studio","/prompt-lab/api/assets"].includes(endpoint.pathname)) { json(res,200,await dispatchStudio(req,endpoint.searchParams,request)); return; }
    // 设置类动作（面板开关）与配置类动作分开发：settings.update 只改 settings.json。
    let result;
    if (importing) {
      if (request.action === "preview") result = { ok: true, preview: previewImport(request.bundle) };
      else if (request.action === "commit") result = importData(request.bundle, request.expectedStoreVersion);
      else throw new Error("导入动作须为 preview 或 commit");
    } else if (request.action === "settings.update") result = updateSettings(request);
    else if (String(request.action).startsWith("rule.")) result = updateRule(request, { requireVersion: true });
    else result = updateProfile(request, { requireVersion: true });
    json(res, 200, result);
  } catch (err) {
    const message = String(err?.message || err);
    // 权限/只读文件系统类错误说明是环境问题，用 500 与参数错误区分开。
    json(res, err?.statusCode || (err?.code ? 500 : 400), { ok: false, error: message });
  }
}

/**
 * Cordis 插件入口：注册 /prompt-lab/api 路由。
 * 通过 effect 注册，插件卸载时 Cordis 会自动移除该路由。
 *
 * @param {object} ctx Cordis 上下文，需提供 webServer 服务与 effect 生命周期钩子。
 */
export function apply(ctx) {
  // 本组件可能先于注入组件启动、甚至在注入组件被单独关闭时单独运行：
  // 先确保共享状态至少初始化过一次，否则面板会看到一片空的配置列表。
  // 已经初始化过时 ensureInitialized() 是空操作，不会清掉求值结果与组装快照。
  ensureInitialized();
  for (const path of ["/prompt-lab/api", "/prompt-lab/api/export", "/prompt-lab/api/import", "/prompt-lab/api/studio", "/prompt-lab/api/assets"]) {
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }));
  }
  console.info("[prompt-lab] UI registered: /prompt-lab/api");
}

// 默认导出与具名导出内容一致，兼容两种 Cordis 插件加载方式。
export default { name, inject, apply };

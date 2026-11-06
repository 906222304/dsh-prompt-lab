/**
 * Prompt Lab 的单元测试（node:test，无需第三方测试框架）。
 *
 * 覆盖面：提示词段注册与动态求值、配置保存/启用与落盘、组装观察者、
 * 本地 HTTP 接口的权限校验与读写行为、以及前端模块的插槽注册。
 * 运行方式：npm test（即 node --test tests/*.test.mjs）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { apply as applyPrompt } from '../lib/index.js';
import { apply as applyUi, handler } from '../lib/ui.js';
import { snapshot, updateProfile, updateSettings, initialize, ensureInitialized, resetForTests } from '../lib/state.js';
import { applyContextFilter, maskText, applyIdentityBreak, breakIdentityText } from '../lib/redact.js';

// 用临时目录充当 DSH_HOME，避免测试写入真实用户配置。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-prompt-lab-'));
process.env.DSH_HOME = dir;
// 插件包根目录，用于读取 client.js 源码做前端侧验证。
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 记录宿主回调：section 注册结果与系统事件监听器。
const callbacks = {};
// 记录 ctx.effect 注册的清理函数。
const effects = [];
// 最小可用的宿主上下文替身。
const ctx = {
  systemPrompt: { section: (data) => { callbacks.section = data; return () => {}; } },
  on: (name, callback) => { callbacks[name] = callback; return () => {}; },
  effect: (callback) => effects.push(callback),
};

test('registers a real text callback and exposes the evaluated prompt', () => {
  applyPrompt(ctx, { enabled: true, prompt: '标记：可验证' });
  assert.equal(callbacks.section.name, 'prompt-lab:custom');
  // text() 是真实回调，返回值应与传入的默认提示词一致。
  assert.equal(callbacks.section.text().trim(), '标记：可验证');
  const s = snapshot();
  assert.equal(s.status.registered, true);
  // 求值结果只保存在内存（effectivePrompt）；快照里没有任何事件历史，插件也不写日志。
  assert.equal(s.effectivePrompt, '标记：可验证');
  assert.equal(s.logs, undefined);
});

test('save and activate rule set, dynamic callback uses current profile', () => {
  updateProfile({ action: 'save', id: 'direct', prompt: '身份标记 ABC', rules: '先列出验证条件。' });
  updateProfile({ action: 'activate', id: 'direct' });
  // 切换配置后，同一个 text() 回调应返回新配置的拼装结果。
  assert.equal(callbacks.section.text(), '身份标记 ABC\n\n## 当前规则集\n先列出验证条件。');
  assert.equal(snapshot().selected, 'direct');
  assert(fs.existsSync(path.join(dir, 'prompt-lab', 'profiles.json')));
});

test('saved profiles survive reload and bad edits do not change state', () => {
  initialize({ enabled: true, prompt: 'fallback' });
  // 重新初始化后，磁盘上的配置与选中项应被恢复。
  assert.equal(snapshot().selected, 'direct');
  assert.equal(snapshot().effectivePrompt.includes('身份标记 ABC'), true);
  // 空提示词会被拒绝，且不影响已有状态。
  assert.throws(() => updateProfile({ action: 'save', id: 'direct', prompt: '', rules: '' }));
  assert.equal(snapshot().profiles.find(x => x.id === 'direct').prompt, '身份标记 ABC');
});

test('captures an observer snapshot without changing assembled result', async () => {
  applyPrompt(ctx, { enabled: true, prompt: '标记' });
  const original = { sections: [{ name: 'official:identity', text: '官方段', order: 10 },
    { name: 'prompt-lab:custom', text: '标记', order: 5100 }], contexts: [], tools: [] };
  const result = await callbacks['system-prompt/assemble'](original, {}, async () => original);
  // 观察者必须原样返回结果，不能改变下游拿到的数据。
  assert.equal(result, original);
  assert.equal(snapshot().assembly.sections[0].text, '官方段');
  assert.equal(snapshot().assembly.sections[1].name, 'prompt-lab:custom');
});

// ── 上下文过滤（“Current runtime context” 那段）─────────────────────────

test('applyContextFilter passes through unless strip/redact has work to do', () => {
  const empty = { sections: [], contexts: [] };
  const one = { sections: [], contexts: [{ name: 'web-surface', text: 'url http://127.0.0.1:1' }] };
  // 关闭、无可过滤内容、非法输入：都返回原引用，保证零改写。
  assert.equal(applyContextFilter(one, 'off'), one);
  assert.equal(applyContextFilter(empty, 'strip'), empty);
  assert.equal(applyContextFilter(null, 'strip'), null);
});

test('applyContextFilter strip empties contexts without mutating the input', () => {
  const one = { sections: [{ name: 's', text: 't' }], contexts: [{ name: 'cwd', text: 'D:\\a' }] };
  const out = applyContextFilter(one, 'strip');
  assert.notEqual(out, one);
  assert.deepEqual(out.contexts, []);
  assert.equal(out.sections, one.sections);
  // 入参保持原样：宿主可能复用同一个 assembly 对象。
  assert.equal(one.contexts.length, 1);
});

test('maskText masks paths, urls and timestamps but keeps functional sentences', () => {
  const masked = maskText('目录 "D:\\private\\x"，界面 http://127.0.0.1:61133，时间 2026-10-28T12:39:09+08:00。');
  assert.equal(masked.includes('D:\\'), false);
  assert.equal(masked.includes('127.0.0.1'), false);
  assert.equal(masked.includes('2026-10-28'), false);
  assert.ok(masked.includes('<路径>') && masked.includes('<URL>') && masked.includes('<时间>'));
  // 带空格的引号路径（宿主源码路径就是这种形态）要整段遮完，不能只遮到第一个空格。
  const spaced = maskText('checkout: "D:\\app\\tool\\DeepSeek Harness\\resources\\app.asar\\dsh\\".');
  assert.equal(spaced.includes('Harness'), false);
  assert.equal(spaced.includes('app.asar'), false);
  assert.ok(spaced.includes('"<路径>"'));
  // 功能句（审批/委派说明）不含敏感值，应原样保留。
  assert.equal(maskText('Tools run without approval prompts.'), 'Tools run without approval prompts.');
});

// ── 渠道指纹脱敏（WorkBuddy 400/11128 的三处身份 span）────────────────────

test('breakIdentityText inserts U+200B at word boundaries inside matched spans only', () => {
  // 用真实请求的首行做夹具：这是网关拦的那句（带模型名）。
  const line = 'You are a coding agent powered by the workbuddy/cn:deepseek-v4.1-flash model.\n后面是普通正文，一个字符都不能动。';
  const out = breakIdentityText(line);
  // ① 插入的必须是 U+200B（钉住源码里那个不可见常量的码点，谁改坏谁红）。
  const zwspCount = [...out].filter((c) => c.codePointAt(0) === 0x200b).length;
  assert.ok(zwspCount > 0, '应当插入零宽空格');
  // ② 原句不再逐字出现（网关的精确子串匹配失配）。
  assert.equal(out.includes('You are a coding agent powered by the'), false);
  // ③ 去掉 U+200B 后与原文完全一致（模型读词不变，可逆）。
  assert.equal(out.replace(/\u200b/g, ''), line);
  // ④ span 外的正文原样保留。
  assert.ok(out.endsWith('后面是普通正文，一个字符都不能动。'));
  // ⑤ 没有命中时返回原字符串。
  assert.equal(breakIdentityText('普通文本，没有身份句。'), '普通文本，没有身份句。');
});

test('breakIdentityText covers all three known gateway spans', () => {
  const samples = [
    'You are a coding agent powered by the zhipu/glm-5.3 model.',
    'You are a coding agent powered by the model.',
    'You are an AI agent powered by DeepSeek Harness.',
    'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:61133.',
    'The DeepSeek Harness implementation checkout is at "D:\\app\\tool".',
    'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1".',
  ];
  for (const s of samples) {
    const out = breakIdentityText(s);
    assert.notEqual(out, s, `未命中：${s}`);
    assert.equal(out.replace(/\u200b/g, ''), s, `破坏后应可还原：${s}`);
  }
});

test('applyIdentityBreak covers sections and contexts without mutating input', () => {
  const clean = { sections: [{ name: 'a', text: '普通段' }], contexts: [{ name: 'b', text: '普通上下文' }] };
  // 无命中：原引用、broken=0。
  assert.equal(applyIdentityBreak(clean).assembly, clean);
  assert.equal(applyIdentityBreak(clean).broken, 0);
  assert.equal(applyIdentityBreak(null).assembly, null);

  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are a coding agent powered by the workbuddy/cn:deepseek-v4.1-flash model.' },
      { name: 'plain', text: '普通段' },
    ],
    contexts: [{ name: 'web-surface', text: 'You are interacting with the user through the DeepSeek Harness Web GUI at http://127.0.0.1:1.' }],
  };
  const { assembly: out, broken } = applyIdentityBreak(assembly);
  assert.equal(broken, 2);
  assert.notEqual(out, assembly);
  // 命中条目被替换、未命中条目原引用共享。
  assert.notEqual(out.sections[0], assembly.sections[0]);
  assert.equal(out.sections[1], assembly.sections[1]);
  assert.notEqual(out.contexts[0], assembly.contexts[0]);
  // 入参未被改动。
  assert.equal(assembly.sections[0].text.includes('\u200b'), false);
  assert.equal(assembly.contexts[0].text.includes('\u200b'), false);
});

test('assemble observer breaks identity spans when identityBreak is on', async () => {
  applyPrompt(ctx, { enabled: true, prompt: '标记' });
  const assembly = {
    sections: [
      { name: 'harness:identity', text: 'You are a coding agent powered by the workbuddy/cn:deepseek-v4.1-flash model.' },
      { name: 'official:identity', text: '官方段', order: 10 },
    ],
    contexts: [],
    tools: [],
  };
  const fire = () => callbacks['system-prompt/assemble'](assembly, {}, async () => assembly);

  // 默认关：同一引用，零改写。
  updateSettings({ identityBreak: false });
  assert.equal(await fire(), assembly);

  // 开启：span 内插零宽、其余段共享、入参不动、快照记录命中数。
  updateSettings({ identityBreak: true });
  const out = await fire();
  assert.notEqual(out, assembly);
  assert.equal(out.sections[0].text.includes('\u200b'), true);
  assert.equal(out.sections[0].text.replace(/\u200b/g, ''), assembly.sections[0].text);
  assert.equal(out.sections[1], assembly.sections[1]);
  assert.equal(assembly.sections[0].text.includes('\u200b'), false);
  assert.equal(snapshot().assembly.identityBroken, 1);

  // 可与上下文过滤叠加：strip + identityBreak 同时生效。
  updateSettings({ contextFilter: 'strip' });
  const both = await fire();
  assert.deepEqual(both.contexts, []);
  assert.equal(both.sections[0].text.includes('\u200b'), true);

  // 收尾还原，避免影响后续用例。
  updateSettings({ contextFilter: 'off', identityBreak: false });
});

test('assemble observer rewrites contexts per the saved mode', async () => {
  applyPrompt(ctx, { enabled: true, prompt: '标记' });
  const assembly = {
    sections: [{ name: 'official:identity', text: '官方段', order: 10 }],
    contexts: [
      { name: 'harness-source', text: 'Current DeepSeek Harness implementation checkout: "D:\\app\\tool\\x".' },
      { name: 'web-surface', text: 'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:61133".' },
    ],
    tools: [],
  };
  const fire = () => callbacks['system-prompt/assemble'](assembly, {}, async () => assembly);

  // off：同一引用，零改写。
  updateSettings({ contextFilter: 'off' });
  assert.equal(await fire(), assembly);

  // strip：contexts 清空，sections 原样共享，入参未被改。
  updateSettings({ contextFilter: 'strip' });
  const stripped = await fire();
  assert.notEqual(stripped, assembly);
  assert.deepEqual(stripped.contexts, []);
  assert.equal(stripped.sections, assembly.sections);
  assert.equal(assembly.contexts.length, 2);
  assert.equal(snapshot().assembly.contextsRemoved, 2);

  // redact：条数不变、句子结构保留、具体值被遮，入参仍是原文。
  updateSettings({ contextFilter: 'redact' });
  const redacted = await fire();
  assert.equal(redacted.contexts.length, 2);
  assert.equal(redacted.contexts[0].text.includes('D:\\app'), false);
  assert.equal(redacted.contexts[0].text.includes('implementation checkout'), true);
  assert.equal(redacted.contexts[1].text.includes('127.0.0.1'), false);
  assert.equal(assembly.contexts[0].text.includes('D:\\app'), true);

  // 收尾还原，避免影响后续用例。
  updateSettings({ contextFilter: 'off' });
});

test('settings persist to settings.json and reload on initialize', () => {
  updateSettings({ contextFilter: 'redact', identityBreak: true });
  assert.equal(snapshot().settings.contextFilter, 'redact');
  assert.equal(snapshot().settings.identityBreak, true);
  assert(fs.existsSync(path.join(dir, 'prompt-lab', 'settings.json')));
  // 重新初始化（等价于插件重载）后从磁盘恢复两个字段。
  initialize({ enabled: true, prompt: 'fallback' });
  assert.equal(snapshot().settings.contextFilter, 'redact');
  assert.equal(snapshot().settings.identityBreak, true);
  // 非法值被拒（枚举外的模式 / 非布尔开关），不影响已保存状态。
  assert.throws(() => updateSettings({ contextFilter: 'nope' }));
  assert.throws(() => updateSettings({ identityBreak: 'yes' }));
  assert.equal(snapshot().settings.contextFilter, 'redact');
  assert.equal(snapshot().settings.identityBreak, true);
  updateSettings({ contextFilter: 'off', identityBreak: false });
});

/**
 * 构造一个最小可用的请求替身（Readable 流 + 必要头部）。
 *
 * @param {string} method HTTP 方法。
 * @param {unknown} data 请求体数据，undefined 表示无请求体。
 * @param {{headers?: object, socket?: object, url?: string}} [overrides] 覆盖头部、socket 或 URL（查询串）。
 * @returns {object} 请求替身。
 */
function fakeRequest(method, data, overrides = {}) {
  const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
  Object.assign(req, { method, url: '/prompt-lab/api', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:43120', 'x-prompt-lab-ui': '1',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) } });
  if (overrides.headers) req.headers = { ...req.headers, ...overrides.headers };
  if (overrides.socket) req.socket = overrides.socket;
  if (overrides.url) req.url = overrides.url;
  return req;
}
/**
 * 构造一个最小响应替身并驱动 handler，返回状态码与解析后的 JSON 体。
 *
 * @param {string} method HTTP 方法。
 * @param {unknown} data 请求体。
 * @param {{headers?: object, socket?: object}} [overrides] 用于权限用例的覆盖项。
 * @returns {Promise<{status: number, body: object}>} 响应结果。
 */
async function dispatch(method, data, overrides = {}) {
  const response = { status: null, headers: {}, body: '', writeHead(status, headers) {
    this.status = status; this.headers = headers;
  }, end(text) { this.body = text || ''; } };
  await handler(fakeRequest(method, data, overrides), response);
  return { status: response.status, body: JSON.parse(response.body) };
}

test('HTTP GET exposes actual prompt and assembly; POST edits profile', async () => {
  // 自带一份组装结果，不依赖前面用例是否触发过事件（中间的 initialize 会清快照）。
  const sample = { sections: [{ name: 'official:identity', text: '官方段', order: 10 },
    { name: 'prompt-lab:custom', text: '标记', order: 5100 }], contexts: [], tools: [] };
  await callbacks['system-prompt/assemble'](sample, {}, async () => sample);
  const before = await dispatch('GET');
  assert.equal(before.status, 200);
  assert(before.body.effectivePrompt.length > 0);
  assert(before.body.assembly.sections.length === 2);
  const after = await dispatch('POST', { action: 'save', id: 'default', prompt: '新内容', rules: '约束A' });
  assert.equal(after.status, 200);
  assert.equal(after.body.profiles.find(p => p.id === 'default').prompt, '新内容');
});

// 设置走同一条 POST 通道：settings.update 只改 settings.json，非法值返回 400。
test('POST settings.update switches the context filter via the local API', async () => {
  const ok = await dispatch('POST', { action: 'settings.update', contextFilter: 'strip' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.contextFilter, 'strip');
  const bad = await dispatch('POST', { action: 'settings.update', contextFilter: 'bogus' });
  assert.equal(bad.status, 400);
  // identityBreak 同通道：布尔合法、字符串 400。
  const flag = await dispatch('POST', { action: 'settings.update', identityBreak: true });
  assert.equal(flag.status, 200);
  assert.equal(flag.body.settings.identityBreak, true);
  const flagBad = await dispatch('POST', { action: 'settings.update', identityBreak: 'on' });
  assert.equal(flagBad.status, 400);
  // 还原，避免影响后续用例。
  await dispatch('POST', { action: 'settings.update', contextFilter: 'off', identityBreak: false });
});

test('local API rejects remote, forged origins and requests without UI header', async () => {
  // 非回环来源、伪造 Origin、缺少自定义头都应被拒绝。
  assert.equal((await dispatch('GET', undefined, { socket: { remoteAddress: '192.168.1.8' } })).status, 403);
  assert.equal((await dispatch('GET', undefined, { headers: { origin: 'https://bad.example' } })).status, 403);
  assert.equal((await dispatch('GET', undefined, { headers: { 'x-prompt-lab-ui': '' } })).status, 403);
  // 桌面 webview 的 origin: null 属于可信来源。
  assert.equal((await dispatch('POST', { action: 'activate', id: 'eval' }, { headers: { origin: 'null' } })).status, 200);
});

// 增量轮询：客户端带上已知版本号后，状态没变时只回一个极小响应，不再重发整份快照。
test('GET honours the since revision and skips unchanged snapshots', async () => {
  const full = (await dispatch('GET')).body;
  assert.equal(typeof full.revision, 'number');
  // 版本一致 → unchanged：响应里不再带 profiles / assembly 这些大字段。
  const same = await dispatch('GET', undefined, { url: '/prompt-lab/api?since=' + full.revision });
  assert.equal(same.status, 200);
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.revision, full.revision);
  assert.equal(same.body.profiles, undefined);
  // 版本落后（或缺失）→ 回完整快照，客户端据此覆盖界面。
  const stale = await dispatch('GET', undefined, { url: '/prompt-lab/api?since=' + Math.max(0, full.revision - 1) });
  assert.equal(stale.body.unchanged, undefined);
  assert.equal(Array.isArray(stale.body.profiles), true);
});

// 状态版本号必须单调递增，否则增量轮询会漏掉更新。
test('every state change bumps the snapshot revision', () => {
  const before = snapshot().revision;
  updateProfile({ action: 'activate', id: 'direct' });
  assert(snapshot().revision > before);
});

// ensureInitialized：已初始化后是空操作（绝不清掉求值结果与组装快照）。
test('ensureInitialized is a no-op once the state is initialized', () => {
  const before = snapshot();
  assert.equal(ensureInitialized(), false);
  const after = snapshot();
  assert.equal(after.revision, before.revision);
  assert.equal(after.selected, before.selected);
  assert.equal(after.assembly, before.assembly);
});

// 浏览器端模块的第一层校验：Node 侧路由注册成功，且前端模块的插槽契约没有变。
test('UI plugin and frontend module register known DSH slots', () => {
  const routes = [];
  applyUi({ effect: (install) => { install(); }, webServer: { register: (route) => { routes.push(route); return () => {}; } } });
  assert.equal(routes[0].path, '/prompt-lab/api');
  // 在 vm 沙箱里加载前端模块：client.js 顶层会调用 window.__ModuleLoader__.load，
  // 这里把它换成收集器，拿到 bundle 后再手动调用 factory 与 apply。
  let frontend;
  const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  const style = { setAttribute() {}, remove() {} };
  const sandbox = { window: { __ModuleLoader__: { load(bundle) { frontend = bundle; } } },
    document: { createElement: () => style, head: { appendChild() {} } } };
  vm.runInNewContext(source, sandbox);
  assert.equal(frontend.id, 'dsh-prompt-lab');
  // React 必须从宿主的模块表里取，而不是插件自带。
  const frontPlugin = frontend.factory((name) => {
    assert.equal(name, 'react');
    return { createElement: () => ({}), useState() {}, useEffect() {}, Fragment: Symbol('fragment') };
  });
  // 插槽替身：只记录 inject 的目标名，并同步执行注册回调（宿主也是声明就绪后立即执行）。
  const slots = [];
  frontPlugin.apply({ effect: () => {}, slots: { inject(name, fn) {
    slots.push(name); fn(); }, register() {} } });
  // 唯一挂载点：会话页签（与「对话」「轨迹」并排）；右下角浮标已移除，不应再出现。
  assert.deepEqual(slots, ['conversation.view']);
});

// 浏览器端模块的第二层校验：注册选项与渲染出来的结构。
// 用最小 React 替身渲染一次，断言根容器类名、内部页签，以及浮标时代残留的类名不再出现。
test('frontend registers the conversation View tab with its options', () => {
  // createElement 只做记录，不参与任何真实渲染：这样能离线检查树结构，不依赖浏览器。
  const h = (type, props, ...children) => ({ type, props: props || {}, children });
  const sandbox = {
    window: {
      __ModuleLoader__: { load(bundle) { sandbox.bundle = bundle; } },
    },
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
    // fetch 只是占位：React 替身没有真的跑 effect，渲染期间不会发请求；
    // 万一被调用就抛错，能立刻发现「渲染期偷偷请求接口」这类回归。
    fetch: async () => { throw new Error('render must not call the API'); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'client.js'), 'utf8'), sandbox);
  const reactStub = {
    createElement: h,
    Fragment: Symbol('fragment'),
    // 所有 state 都用各自初值；setState 是空实现，不驱动重渲染。
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // useRef 只需要一个跨渲染稳定的可变槽位（轮询的在途标记、版本号、退避都放这里）。
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
  };
  const frontPlugin = sandbox.bundle.factory((name) => {
    if (name !== 'react') throw new Error('unexpected module ' + name);
    return reactStub;
  });
  /** 渲染插槽注册的渲染函数，返回它产出的元素树。 */
  const renderTree = (component) => {
    const element = component();
    return element.type(element.props);
  };
  /** 收集树中所有满足条件的元素。 */
  const collect = (node, match, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (typeof node.type === 'string' && match(node)) out.push(node);
    for (const child of node.children || []) collect(child, match, out);
    return out;
  };
  const hasClass = (node, cls) => String(node.props.className || '').split(' ').includes(cls);

  // 捕获 apply 期间注册到插槽的选项与渲染函数（顺序即注册顺序）。
  const registrations = [];
  frontPlugin.apply({
    effect: () => {},
    slots: {
      inject(name, fn) { fn(); },
      register(options, component) { registrations.push({ options, component }); },
    },
  });
  // 沙箱里创建的对象原型不同，先转成宿主侧的纯数据再比较；现在只有一个挂载点。
  assert.deepEqual(JSON.parse(JSON.stringify(registrations.map((r) => r.options))), [
    { name: 'conversation.view', id: 'prompt-lab', order: 20, label: '提示词' },
  ]);

  // 根节点填满会话视图区；不再有浮标、固定定位卡片或位置下拉。
  const tree = renderTree(registrations[0].component);
  assert.equal(tree.type, 'section');
  assert.equal(tree.props.className, 'pl-view');
  assert.equal(collect(tree, (n) => hasClass(n, 'pl-button-float') || hasClass(n, 'pl-dock')).length, 0);
  assert.equal(collect(tree, (n) => n.props['aria-label'] === '面板停靠位置').length, 0);
  // 三个内部页签：提示词与规则 / 组装快照 / 设置。
  assert.deepEqual(
    collect(tree, (n) => hasClass(n, 'pl-tab')).map((n) => n.children[0]),
    ['提示词与规则', '组装快照', '设置'],
  );
  // 日志行结构与「自动刷新」勾选框都不应再出现在树里。
  assert.equal(collect(tree, (n) => hasClass(n, 'pl-row')).length, 0);
  assert.equal(collect(tree, (n) => n.children.includes(' 自动刷新')).length, 0);
});

test('disabled switch does not register a new section', () => {
  let called = false;
  applyPrompt({ systemPrompt: { section() { called = true; } } }, { enabled: false });
  assert.equal(called, false);
  assert.equal(snapshot().status.phase, 'disabled');
});

// 只启用接口组件、注入组件被单独关掉时，进程内状态从未初始化：
// ensureInitialized() 必须补一次，否则面板拿到的是空配置列表。
test('ensureInitialized initializes a fresh process', () => {
  // resetForTests() 等价于「进程刚启动、还没有任何 apply 跑过」。
  resetForTests();
  assert.equal(snapshot().status.phase, 'not-started');
  assert.equal(ensureInitialized(), true);
  const fresh = snapshot();
  assert(fresh.profiles.length >= 1);
  assert.equal(fresh.status.phase, 'starting');
  // 第二次调用不再重复初始化。
  assert.equal(ensureInitialized(), false);
});

test('cleanup temp test directory', () => {
  // 放在最后执行，清理本次测试创建的临时 DSH_HOME。
  fs.rmSync(dir, { recursive: true, force: true });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const initial = (revision = 1, prompt = '已保存') => ({
  ok: true, revision, configRevision: revision, selected: 'default',
  generatedAt: '2026-11-06T00:00:00Z',
  status: { phase: 'registered', observerRegistered: true },
  profiles: [{ id: 'default', name: '默认', prompt, rules: '' }, { id: 'other', name: '其他', prompt: '其他已保存', rules: '' }],
  configuredPrompt: prompt, settings: { contextFilter: 'off', identityBreak: false }, assembly: null,
});
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return (node.children || []).flat(Infinity).map(text).join('');
}
function collect(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  for (const child of (node.children || []).flat(Infinity)) collect(child, predicate, result);
  return result;
}

// 运行真实 Panel、effect、事件处理器和可控异步 fetch，不依赖第三方测试框架。
function panelHarness() {
  let bundle, Panel, tree, hooks = [], cursor = 0, pending = false, effects = [], cleanups = [];
  const requests = [], intervals = new Map(), listeners = new Map(), confirmations = [];
  let timerId = 0;
  const sandbox = {
    window: {
      __ModuleLoader__: { load(value) { bundle = value; } },
      setInterval(fn) { intervals.set(++timerId, fn); return timerId; },
      clearInterval(id) { intervals.delete(id); },
      addEventListener(name, fn) { listeners.set(name, fn); },
      removeEventListener(name) { listeners.delete(name); },
      confirm(message) { confirmations.push(message); return sandbox.confirmResult; },
    },
    confirmResult: false,
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
    fetch(url, options) {
      return new Promise((resolve, reject) => requests.push({ url, options, reject,
        respond(data, ok = true) { resolve({ ok, status: ok ? 200 : 400, json: async () => data }); },
      }));
    },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: Symbol('fragment'),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; pending = true; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(fn, dependencies) {
      const index = cursor++;
      if (!(index in hooks) || dependencies.some((value, i) => value !== hooks[index][i])) {
        hooks[index] = dependencies;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); });
      }
    },
  };
  vm.runInNewContext(source, sandbox);
  bundle.factory(name => { assert.equal(name, 'react'); return react; }).apply({
    effect() {}, slots: { inject(name, install) { install(); }, register(options, component) { Panel = component().type; } },
  });
  function render() {
    cursor = 0; pending = false; tree = Panel();
    const queued = effects; effects = []; queued.forEach(run => run());
  }
  const api = {
    requests, intervals, listeners, confirmations,
    set confirmResult(value) { sandbox.confirmResult = value; },
    get tree() { return tree; },
    get allText() { return text(tree); },
    find(predicate) { return collect(tree, predicate)[0]; },
    button(label) { return api.find(n => n.type === 'button' && text(n) === label); },
    textarea() { return api.find(n => n.type === 'textarea'); },
    selector() { return api.find(n => n.type === 'select'); },
    async flush() {
      for (let i = 0; i < 4; i++) {
        await new Promise(setImmediate);
        if (pending) render();
      }
    },
    async start(snapshot = initial()) { api.mount(); requests.at(-1).respond(snapshot); await api.flush(); },
    mount() { hooks = []; cleanups = []; effects = []; render(); },
    unmount() { cleanups.forEach(dispose => dispose?.()); },
    tick() { intervals.forEach(fn => fn()); },
    edit(value) { api.textarea().props.onChange({ target: { value } }); },
  };
  return api;
}

test('polling keeps drafts and switching requires an explicit discard choice', async () => {
  const h = panelHarness();
  await h.start();
  h.edit('未保存'); await h.flush();
  h.tick(); h.requests.at(-1).respond(initial(2, '外部改动')); await h.flush();
  assert.equal(h.textarea().props.value, '未保存');
  h.selector().props.onChange({ target: { value: 'other' } }); await h.flush();
  assert.equal(h.textarea().props.value, '未保存');
  assert.equal(h.confirmations.length, 1);
  h.confirmResult = true;
  h.selector().props.onChange({ target: { value: 'other' } }); await h.flush();
  assert.equal(h.textarea().props.value, '其他已保存');
  h.unmount();
});

test('draft survives host tab unmount and guards page close', async () => {
  const h = panelHarness();
  await h.start();
  h.edit('回来继续编辑'); await h.flush();
  let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  h.listeners.get('beforeunload')(event);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, '');
  h.unmount();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners.size, 0);
  h.mount();
  h.requests.at(-1).respond(initial()); await h.flush();
  assert.equal(h.textarea().props.value, '回来继续编辑');
  h.unmount();
});

test('activating an edited inactive profile confirms discarding and sends no draft', async () => {
  const h = panelHarness();
  await h.start();
  h.selector().props.onChange({ target: { value: 'other' } }); await h.flush();
  h.edit('未保存的其他配置'); await h.flush();
  h.button('启用这套配置').props.onClick(); await h.flush();
  assert.equal(h.requests.length, 1);
  h.confirmResult = true;
  h.button('启用这套配置').props.onClick(); await h.flush();
  const post = h.requests.at(-1);
  assert.deepEqual(JSON.parse(post.options.body), { action: 'activate', id: 'other', expectedVersion: 1 });
  assert.equal(h.textarea().props.disabled, true);
  post.respond({ ...initial(2), selected: 'other' }); await h.flush();
  assert.equal(h.textarea().props.value, '其他已保存');
  h.unmount();
});

test('GET started before a save cannot overwrite the POST result', async () => {
  const h = panelHarness();
  await h.start();
  h.edit('新保存'); await h.flush();
  h.tick(); const oldGet = h.requests.at(-1);
  const save = h.button('保存配置').props.onClick;
  save(); save(); await h.flush();
  assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1);
  h.requests.at(-1).respond(initial(3, '新保存')); await h.flush();
  oldGet.respond(initial(2, '旧内容')); await h.flush();
  assert.equal(h.textarea().props.value, '新保存');
  assert.ok(h.allText.includes('草稿与载入版本一致'));
  assert.ok(!h.allText.includes('旧内容'));
  h.tick();
  assert.ok(h.requests.at(-1).url.includes('since=3'));
  h.requests.at(-1).respond({ ok: true, unchanged: true, revision: 3 }); await h.flush();
  h.unmount();
});

test('stale GET errors are ignored and failed saves retain the draft', async () => {
  const h = panelHarness();
  await h.start();
  h.edit('不能丢失'); await h.flush();
  h.tick(); const oldGet = h.requests.at(-1);
  h.button('保存配置').props.onClick(); await h.flush();
  h.requests.at(-1).respond({ ok: false, error: '写入失败' }, false); await h.flush();
  oldGet.reject(new Error('old poll failed')); await h.flush();
  assert.equal(h.textarea().props.value, '不能丢失');
  assert.ok(h.allText.includes('写入失败'));
  assert.ok(!h.allText.includes('old poll failed'));
  h.unmount();
});

test('late responses after unmount do not erase the retained draft', async () => {
  const h = panelHarness();
  await h.start();
  h.edit('离开时的草稿'); await h.flush();
  h.button('保存配置').props.onClick();
  const post = h.requests.at(-1);
  h.unmount();
  post.respond(initial(2, '离开时的草稿')); await h.flush();
  h.mount(); h.requests.at(-1).respond(initial(2, '离开时的草稿')); await h.flush();
  assert.equal(h.textarea().props.value, '离开时的草稿');
  h.unmount();
});

test('manual refresh bypasses backoff and reports stale process snapshots accurately', async () => {
  const h = panelHarness();
  await h.start();
  h.tick(); h.requests.at(-1).reject(new Error('offline')); await h.flush();
  const count = h.requests.length;
  h.tick(); assert.equal(h.requests.length, count);
  h.button('↻').props.onClick();
  const sample = initial(2);
  sample.assembly = { scope: 'process', stale: true, configRevision: 1,
    capturedAt: 'time', sectionCount: 1,
    sections: [{ name: 'prompt-lab:custom', retainedChars: 2, chars: 9, text: 'ab', truncated: true }], truncated: true,
    contexts: [{ index: 0, name: 'cwd', retainedChars: 2, chars: 9, text: 'ab', truncated: true }],
  };
  h.requests.at(-1).respond(sample); await h.flush();
  h.button('设置').props.onClick(); await h.flush();
  assert.ok(h.allText.includes('可能来自其他会话'));
  assert.ok(h.allText.includes('待新请求验证'));
  assert.ok(h.allText.includes('2/9 字（已截断）'));
  assert.ok(!h.allText.includes('offline'));
  h.unmount();
});

test('configuration tools are disclosed and searching preserves the current draft', async () => {
  const h = panelHarness();
  await h.start();
  assert.equal(h.button('新建配置'), undefined);
  h.button('管理配置').props.onClick(); await h.flush();
  assert.ok(h.button('新建配置'));
  h.edit('保留这份草稿'); await h.flush();
  h.find(n => n.props['aria-label'] === '搜索配置').props.onChange({ target: { value: '其他' } });
  await h.flush();
  assert.equal(h.find(n => n.props['data-profile-id'] === 'default'), undefined);
  assert.ok(h.find(n => n.props['data-profile-id'] === 'other'));
  assert.equal(h.textarea().props.value, '保留这份草稿');
  h.find(n => n.props['aria-label'] === '管理配置操作').props.onKeyDown({ key: 'Escape' }); await h.flush();
  assert.equal(h.button('新建配置'), undefined);
  assert.equal(h.textarea().props.value, '保留这份草稿');
  h.unmount();
});

test('diagnostics start collapsed in settings and show only Prompt Lab observations', async () => {
  const h = panelHarness(), sample = initial();
  sample.assembly = { scope: 'process', stale: false, configRevision: 1, capturedAt: 'time',
    sections: [
      { name: 'official:identity', text: '其他插件正文', retainedChars: 6, chars: 6 },
      { name: 'prompt-lab:custom', text: '本插件正文', retainedChars: 5, chars: 5 },
      { name: 'prompt-lab:rules', text: '本插件规则', retainedChars: 5, chars: 5 },
    ], contexts: [{ name: 'cwd', text: '其他上下文原文' }], contextFilter: 'strip', contextsRemoved: 3, contextCount: 0, identityBroken: 2 };
  await h.start(sample);
  assert.equal(h.button('组装快照'), undefined);
  assert.equal(h.find(n => n.props['aria-label'] === 'Prompt Lab 诊断'), undefined);
  h.button('设置').props.onClick(); await h.flush();
  assert.equal(h.find(n => n.props['aria-label'] === 'Prompt Lab 诊断').props.open, undefined);
  for (const value of ['本插件正文', '本插件规则', '去除 3 条', '命中 2 处']) assert.ok(h.allText.includes(value));
  for (const value of ['其他插件正文', '其他上下文原文']) assert.ok(!h.allText.includes(value));
  h.unmount();
});

test('diagnostics distinguish missing observations from failed processing', async () => {
  for (const failed of [false, true]) {
    const h = panelHarness(), sample = initial();
    if (failed) sample.assembly = { capturedAt: 'time', configRevision: 1, processingFailed: true, sections: [], contexts: [] };
    await h.start(sample); h.button('设置').props.onClick(); await h.flush();
    assert.ok(h.allText.includes(failed ? '不能确认过滤已生效' : '尚未观察到组装'));
    assert.ok(!h.allText.includes('本次上下文过滤'));
    h.unmount();
  }
});

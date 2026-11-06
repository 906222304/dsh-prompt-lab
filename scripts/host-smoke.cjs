/** Isolated smoke check against an installed DSH, run with its Node/Electron runtime. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

async function main() {
  const modules = process.argv[2] || process.env.DSH_HOST_MODULES;
  if (!modules || !path.isAbsolute(modules)) throw new Error('Pass the absolute DSH node_modules directory as the first argument');
  const fromHost = createRequire(path.join(modules, 'prompt-lab-smoke.cjs'));
  const { Context } = fromHost('@deepseek-ai/cordis');
  const { SystemPrompt } = fromHost('@deepseek-ai/dsh-system-prompt');
  const version = fromHost('@deepseek-ai/dsh-system-prompt/package.json').version;
  const plugin = require('../lib/index.js');
  const state = require('../lib/state.js');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lab-host-smoke-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = temporary;
  const ctx = new Context();
  let service, injection;
  try {
    service = ctx.plugin(SystemPrompt, {});
    await new Promise(setImmediate);
    ctx.systemPrompt.context({ name: 'smoke:cwd', order: 1, text: 'cwd "D:\\smoke". Approval required.' });
    injection = ctx.plugin(plugin, { prompt: 'host smoke initial' });
    await new Promise(setImmediate);
    assert.equal(state.snapshot().evaluation, null);
    let assembly = await ctx.systemPrompt.assemble({ sessionId: 'smoke-a' });
    assert.equal(assembly.sections.find(s => s.name === 'prompt-lab:custom').text, 'host smoke initial');
    assert.equal(state.snapshot().status.observerRegistered, true);
    state.updateProfile({ action: 'save', id: 'default', prompt: 'host smoke saved', rules: '' });
    assert.equal(state.snapshot().assembly.stale, true);
    state.updateSettings({ contextFilter: 'redact' });
    assembly = await ctx.systemPrompt.assemble({ sessionId: 'smoke-b' });
    assert.equal(assembly.sections.find(s => s.name === 'prompt-lab:custom').text, 'host smoke saved');
    assert.equal(assembly.contexts[0].text.includes('D:\\smoke'), false);
    assert.equal(assembly.contexts[0].text.includes('Approval required.'), true);
    assert.equal(state.snapshot().assembly.stale, false);
    assert.equal(state.snapshot().assembly.scope, 'process');
    await injection.dispose(); injection = null;
    assert.equal(state.snapshot().status.observerRegistered, false);
    assembly = await ctx.systemPrompt.assemble();
    assert.equal(assembly.sections.some(s => s.name === 'prompt-lab:custom'), false);
    assert.equal(assembly.contexts[0].text.includes('D:\\smoke'), true);
    injection = ctx.plugin(plugin, { enabled: false });
    await new Promise(setImmediate);
    state.updateSettings({ contextFilter: 'strip' });
    assembly = await ctx.systemPrompt.assemble();
    assert.equal(assembly.sections.some(s => s.name === 'prompt-lab:custom'), false);
    assert.deepEqual(assembly.contexts, []);
    assert.equal(state.snapshot().status.observerRegistered, true);
    await injection.dispose(); injection = null;
    assert.equal((await ctx.systemPrompt.assemble()).contexts.length, 1);
    console.log(JSON.stringify({ ok: true, hostVersion: version, node: process.version,
      checks: ['dynamic section', 'saved profile', 'redact', 'process snapshot', 'disabled injection with strip', 'dispose restores host'] }));
  } finally {
    await injection?.dispose();
    await service?.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('prompt-lab-host-smoke-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

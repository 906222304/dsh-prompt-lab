import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';
import { initialize, snapshot, resetForTests, updateProfile, updateSettings, captureAssembly } from '../lib/state.js';
import { handler, MAX_REQUEST_BYTES } from '../lib/ui.js';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lab-stability-'));
const originalHome = process.env.DSH_HOME;
let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  process.env.DSH_HOME = home;
  resetForTests();
});
after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('prompt-lab-stability-'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function host(config = {}) {
  const callbacks = {};
  const cleanups = [];
  apply({
    systemPrompt: { section(section) { callbacks.section = section; } },
    on(name, callback) { callbacks[name] = callback; },
    effect(install) { cleanups.push(install()); },
  }, config);
  return { section: callbacks.section, assemble: callbacks['system-prompt/assemble'], cleanups };
}
function writeProfiles(profiles, selected) {
  fs.mkdirSync(path.join(home, 'prompt-lab'), { recursive: true });
  fs.writeFileSync(path.join(home, 'prompt-lab', 'profiles.json'), JSON.stringify({ profiles, selected }));
}
const profile = (id = 'custom', prompt = '正文') => ({ id, name: id, prompt, rules: '' });

async function request(data, raw) {
  if (data?.action === 'save' && data.expectedVersion === undefined) {
    data = { ...data, expectedVersion: snapshot().profiles.find(p => p.id === data.id)?.version };
  }
  const body = raw ?? JSON.stringify(data);
  const bytes = Buffer.from(body);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(bytes.subarray(offset, offset + 8192));
  const req = Object.assign(Readable.from(chunks), {
    method: 'POST', url: '/prompt-lab/api', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost:1234', 'x-prompt-lab-ui': '1', 'content-type': 'application/json' },
  });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  await handler(req, res);
  return res;
}

test('disabled injection still observes, filters, edits and disposes', async () => {
  const h = host({ enabled: false });
  assert.equal(h.section, undefined);
  assert.equal(snapshot().status.observerRegistered, true);
  assert.equal(snapshot().evaluation, null);
  updateSettings({ contextFilter: 'strip' });
  updateProfile({ action: 'save', id: 'default', prompt: 'disabled draft', rules: '' });
  const input = { sections: [], contexts: [{ name: 'cwd', text: 'D:\\fixture' }] };
  const result = await h.assemble(input, {}, async () => input);
  assert.deepEqual(result.contexts, []);
  assert.equal(input.contexts.length, 1);
  assert.equal(snapshot().status.enabled, false);
  assert.equal(snapshot().configuredPrompt, 'disabled draft');
  assert.equal(snapshot().effectivePrompt, '');
  h.cleanups.forEach(dispose => dispose());
  assert.equal(snapshot().status.phase, 'disposed');
  assert.equal(snapshot().status.observerRegistered, false);
});

test('empty stored prompt retains a dynamic section and recovers without reapply', () => {
  writeProfiles([profile('custom', '')], 'custom');
  const h = host();
  assert.equal(snapshot().status.phase, 'empty-prompt');
  assert.equal(snapshot().status.registered, true);
  assert.equal(snapshot().evaluation, null);
  assert.equal(h.section.text(), '');
  updateProfile({ action: 'save', id: 'custom', prompt: '恢复', rules: '' });
  assert.equal(h.section.text(), '恢复');
  assert.equal(snapshot().status.phase, 'registered');
});

test('assemble supports observed three-argument and compatible two-argument callbacks', async () => {
  const h = host();
  const original = { sections: [{ name: 'original', text: 'before' }], contexts: [] };
  const downstream = { sections: [{ name: 'next', text: 'after' }], contexts: [] };
  for (const count of [2, 3]) {
    let calls = 0;
    const next = async () => { calls += 1; return downstream; };
    const result = await h.assemble(...(count === 2 ? [original, next] : [original, {}, next]));
    assert.equal(calls, 1);
    assert.equal(result, downstream);
    assert.equal(snapshot().assembly.sections[0].text, 'after');
  }
  assert.equal(await h.assemble(original), original);
});

test('downstream assembly errors propagate and do not replace the last snapshot', async () => {
  const h = host();
  const assembly = { sections: [], contexts: [] };
  await h.assemble(assembly);
  const before = snapshot().assembly;
  const failure = new Error('host assembly failed');
  await assert.rejects(h.assemble(assembly, {}, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(snapshot().assembly, before);
});

test('plugin processing failures return the downstream result and mark the fallback snapshot', async () => {
  const h = host();
  updateSettings({ contextFilter: 'redact' });
  let firstRead = true;
  const input = { sections: [], contexts: [{ name: 'fixture', get text() {
    if (firstRead) { firstRead = false; throw new Error('fixture text provider failed'); }
    return 'unprocessed';
  } }] };
  assert.equal(await h.assemble(input, {}, async () => input), input);
  assert.equal(snapshot().assembly.processingFailed, true);
  assert.equal(snapshot().assembly.contexts[0].text, 'unprocessed');
});

test('invalid or missing selected id falls back to first stored profile', () => {
  for (const selected of [undefined, 'removed']) {
    writeProfiles([profile('mine'), profile('other')], selected);
    initialize();
    assert.equal(snapshot().selected, 'mine');
    assert.equal(snapshot().configuredPrompt, '正文');
  }
});

test('contexts report partial and total truncation within the shared budget', () => {
  initialize();
  const input = { sections: [{ name: 's', text: 'x'.repeat(239998) }],
    contexts: [{ name: 'first', text: 'abcd' }, { name: 'last', text: 'ef' }] };
  captureAssembly(input);
  const s = snapshot();
  assert.equal(s.assembly.truncated, true);
  assert.equal(s.assembly.sections[0].retainedChars, 239998);
  assert.equal(s.assembly.contexts[0].retainedChars, 2);
  assert.equal(s.assembly.contexts[0].chars, 4);
  assert.equal(s.assembly.contexts[0].truncated, true);
  assert.equal(s.assembly.contexts[1].text, '');
  assert.equal(s.assembly.contexts[1].truncated, true);
  assert.equal(input.contexts[0].text, 'abcd');
  s.assembly.contexts[0].text = 'mutated copy';
  assert.equal(snapshot().assembly.contexts[0].text, 'ab');
  captureAssembly({ sections: [], contexts: [{ name: 'c', text: 'ok' }] });
  assert.equal(snapshot().assembly.truncated, false);
});

test('saved preview, callback evaluation and process snapshot retain distinct revisions', async () => {
  const h = host({ prompt: 'initial' });
  assert.equal(snapshot().evaluation, null);
  h.section.text();
  await h.assemble({ sections: [{ name: 's', text: 'initial' }], contexts: [] });
  const before = snapshot();
  assert.equal(before.assembly.scope, 'process');
  assert.equal(before.assembly.stale, false);
  updateProfile({ action: 'save', id: 'default', prompt: 'new', rules: '' });
  let s = snapshot();
  assert.equal(s.configuredPrompt, 'new');
  assert.equal(s.evaluation.text, 'initial');
  assert.equal(s.evaluation.stale, true);
  assert.equal(s.assembly.sections[0].text, 'initial');
  assert.equal(s.assembly.stale, true);
  h.section.text();
  s = snapshot();
  assert.equal(s.evaluation.text, 'new');
  assert.equal(s.evaluation.stale, false);
  assert.equal(s.assembly.stale, true);
  await h.assemble({ sections: [], contexts: [] });
  assert.equal(snapshot().assembly.stale, false);
  updateSettings({ contextFilter: 'redact' });
  assert.equal(snapshot().assembly.stale, true);
});

test('configuration changed while next is pending leaves the observation stale', async () => {
  const h = host();
  let resolve;
  const waiting = new Promise(done => { resolve = done; });
  const result = h.assemble({ sections: [], contexts: [] }, {}, () => waiting);
  updateSettings({ contextFilter: 'strip' });
  resolve({ sections: [], contexts: [] });
  await result;
  assert.equal(snapshot().assembly.stale, true);
});

test('maximum Chinese, emoji and escaped control text fits the HTTP budget', async () => {
  initialize();
  for (const text of ['中'.repeat(64000), '😀'.repeat(32000), 'a' + '\u0000'.repeat(63999)]) {
    const res = await request({ action: 'save', id: 'default', prompt: text, rules: text });
    assert.equal(res.status, 200);
    assert.equal(res.body.profiles[0].prompt, text);
  }
  const escaped = JSON.stringify({ action: 'save', id: 'default', expectedVersion: snapshot().profiles[0].version, prompt: '中'.repeat(64000), rules: '中'.repeat(64000) }).replace(/中/g, '\\u4e2d');
  assert.equal((await request(null, escaped)).status, 200);
});

test('oversized bodies return 413 and oversized fields or JSON primitives return 400', async () => {
  initialize();
  const before = snapshot();
  assert.equal((await request(null, 'x'.repeat(MAX_REQUEST_BYTES + 1))).status, 413);
  assert.equal((await request({ action: 'save', id: 'default', prompt: 'x'.repeat(64001), rules: '' })).status, 400);
  for (const input of [null, [], 'text', 1]) assert.equal((await request(input)).status, 400);
  assert.deepEqual(snapshot().profiles, before.profiles);
  assert.equal(snapshot().revision, before.revision);
});

test('failed disk writes preserve configuration, evaluation and observation', async () => {
  const h = host();
  h.section.text();
  await h.assemble({ sections: [], contexts: [] });
  const before = snapshot();
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync = () => { throw Object.assign(new Error('EPERM fixture'), { code: 'EPERM' }); };
    assert.equal((await request({ action: 'save', id: 'default', prompt: 'lost', rules: '' })).status, 500);
    assert.equal((await request({ action: 'settings.update', contextFilter: 'strip' })).status, 500);
  } finally { fs.writeFileSync = write; }
  const current = snapshot();
  for (const key of ['profiles', 'selected', 'settings', 'configRevision', 'revision', 'evaluation', 'assembly'])
    assert.deepEqual(current[key], before[key]);
});

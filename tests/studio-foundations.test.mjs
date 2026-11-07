import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, resetForTests, snapshot, updateProfile, updateRule, restoreStudioRevision, maintainStudioRules, studioStorageDirectory } from '../lib/state.js';
import { RevisionStore } from '../lib/studio/revisions.js';
import { SuiteStore, checkOutput } from '../lib/studio/suites.js';
import { hostSessionReader, registerSessionReader, selectSessionSource } from '../lib/studio/sessions.js';

const originalHome = process.env.DSH_HOME;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-lab-foundations-'));
beforeEach(() => {
  process.env.DSH_HOME = fs.mkdtempSync(path.join(root, 'case-'));
  resetForTests(); initialize();
});
after(() => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('prompt-lab-foundations-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('restoring an old profile copies frozen shared rules and preserves current activation', () => {
  const selected = snapshot().selected;
  const ruleId = updateRule({ action: 'create', name: '规则', text: '旧正文' }).editedRuleId;
  const profileId = updateProfile({ action: 'create', name: '方案', prompt: '旧提示词' }).editedId;
  const profile = snapshot().profiles.find(p => p.id === profileId);
  updateProfile({ action: 'save', ...profile, ruleIds: [ruleId], promptEnabled: false, expectedVersion: profile.version });
  const history = new RevisionStore(studioStorageDirectory());
  const frozenId = history.list(profileId).revisions.find(r => r.storeVersion === snapshot().storage.storeVersion).id;
  const rule = snapshot().ruleSets.find(r => r.id === ruleId);
  updateRule({ action: 'save', ...rule, text: '新正文', expectedVersion: rule.version });
  const result = restoreStudioRevision({ revisionId: frozenId, side: 'after', profileId, mode: 'copy', expectedStoreVersion: snapshot().storage.storeVersion });
  const restored = result.profiles.find(p => p.id === result.editedId);
  assert.equal(restored.promptEnabled, false);
  assert.equal(restored.prompt, '旧提示词');
  assert.notEqual(restored.ruleIds[0], ruleId);
  assert.equal(result.ruleSets.find(r => r.id === restored.ruleIds[0]).text, '旧正文');
  assert.equal(result.ruleSets.find(r => r.id === ruleId).text, '新正文');
  assert.equal(result.selected, selected);
});

test('batch maintenance refuses deletion of a referenced rule without modifying assets', () => {
  const id = updateRule({ action: 'create', name: '引用规则', text: '保留' }).editedRuleId;
  const p = snapshot().profiles[0];
  updateProfile({ action: 'save', ...p, ruleIds: [id], expectedVersion: p.version });
  const before = snapshot();
  assert.throws(() => maintainStudioRules({ mode: 'delete', ids: [id], versions: { [id]: 1 }, confirm: true, expectedStoreVersion: before.storage.storeVersion }), e => e.statusCode === 409);
  assert.deepEqual(snapshot().ruleSets, before.ruleSets);
  assert.equal(snapshot().storage.storeVersion, before.storage.storeVersion);
});

test('suite edits reject stale revisions and checks reject malformed JSON', () => {
  const store = new SuiteStore(studioStorageDirectory());
  const input = { name: '基础样例', cases: [{ id: 'one', split: 'train', input: '返回 JSON', checks: [{ type: 'hasKeys', value: ['ok'] }] }] };
  const first = store.save(input).suite;
  const second = store.save({ ...input, id: first.id, expectedRevision: first.revision, name: '新名称' }).suite;
  assert.throws(() => store.save({ ...input, id: first.id, expectedRevision: first.revision }), e => e.statusCode === 409);
  assert.equal(store.get(first.id).name, second.name);
  assert.equal(checkOutput('{invalid', first.cases[0].checks)[0].pass, false);
  assert.equal(checkOutput('{"ok":true}', first.cases[0].checks)[0].pass, true);
});

test('session selection excludes reasoning and tools and rejects changed selected messages', async () => {
  let text = '用户修正';
  const reader = hostSessionReader({ readSurface: async () => ({ capturedThroughSeq: 3, events: [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text }] } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '可见回答' }] } } },
    { seq: 3, type: 'tool/result', data: { text: '工具秘密' } },
  ] }) });
  const dispose = registerSessionReader(reader);
  try {
    const preview = await reader.preview('synthetic-session');
    assert.equal(preview.messages.length, 2);
    assert.equal(preview.messages[1].text, '可见回答');
    const selection = { sessionId: preview.sessionId, events: [{ seq: 1, hash: preview.messages[0].hash }] };
    const source = await selectSessionSource(selection);
    assert.equal(source.events.length, 1);
    assert.equal(source.events[0].text, text);
    text = '修正已变化';
    await assert.rejects(selectSessionSource(selection), e => e.statusCode === 409);
  } finally { dispose(); }
});

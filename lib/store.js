/** Versioned user data only. Profiles and reusable rules commit in one atomic file. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 2;
export const MAX_PROFILE_TEXT = 64000;
export const MAX_PROFILES = 20;
export const MAX_RULE_SETS = 50;
export const MAX_IMPORT_BYTES = (MAX_PROFILES * 2 + MAX_RULE_SETS) * MAX_PROFILE_TEXT * 6 + 200000;
const idPattern = /^[a-z][a-z0-9-]{0,30}$/;
export const problem = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const validText = value => typeof value === "string" && value.length <= MAX_PROFILE_TEXT;
const nameOf = value => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) throw problem("名称须为 1–80 个字符");
  return value.trim();
};
const idOf = value => { if (typeof value !== "string" || !idPattern.test(value)) throw problem("配置或规则 id 无效"); return value; };
const flag = (item, key) => {
  if (item[key] !== undefined && typeof item[key] !== "boolean") throw problem(`${key} 必须为布尔值`);
  return item[key] !== false;
};
const versionOf = value => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw problem("数据版本无效");
  return value ?? 1;
};
export function normalizeProfile(item) {
  if (!object(item) || !validText(item.prompt) || !validText(item.rules)) throw problem("提示词和附加规则须为不超过 64000 单元的文本");
  const ruleIds = item.ruleIds ?? [];
  if (!Array.isArray(ruleIds) || ruleIds.length > MAX_RULE_SETS || new Set(ruleIds).size !== ruleIds.length) throw problem("规则引用无效或重复");
  return { id: idOf(item.id), name: nameOf(item.name), prompt: item.prompt, rules: item.rules,
    ruleIds: ruleIds.map(idOf), promptEnabled: flag(item, "promptEnabled"), rulesEnabled: flag(item, "rulesEnabled"), version: versionOf(item.version) };
}
export function normalizeRule(item) {
  if (!object(item) || !validText(item.text) || !item.text.trim()) throw problem("规则正文须为非空且不超过 64000 单元的文本");
  return { id: idOf(item.id), name: nameOf(item.name), text: item.text, enabled: flag(item, "enabled"), version: versionOf(item.version) };
}
function unique(items) {
  if (new Set(items.map(item => item.id)).size !== items.length) throw problem("同类数据包含重复 id");
}
export function normalizeStore(input) {
  if (!object(input) || ![undefined, 1, SCHEMA_VERSION].includes(input.schemaVersion)) throw problem("不支持的数据格式版本，请恢复匹配版本的备份", 409);
  if (!Array.isArray(input.profiles) || input.profiles.length < 1 || input.profiles.length > MAX_PROFILES) throw problem("配置数须为 1–20");
  const profiles = input.profiles.map(normalizeProfile);
  const rulesInput = input.ruleSets ?? [];
  if (!Array.isArray(rulesInput) || rulesInput.length > MAX_RULE_SETS) throw problem("规则集数量超过 50");
  const ruleSets = rulesInput.map(normalizeRule);
  unique(profiles); unique(ruleSets);
  const ids = new Set(ruleSets.map(item => item.id));
  if (profiles.some(item => item.ruleIds.some(id => !ids.has(id)))) throw problem("配置引用了不存在的规则集");
  return { schemaVersion: SCHEMA_VERSION, storeVersion: versionOf(input.storeVersion),
    selected: profiles.some(item => item.id === input.selected) ? input.selected : profiles[0].id, profiles, ruleSets };
}
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function fileDigest(file) {
  try { return digest(fs.readFileSync(file)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function loadStore(file, fallbackProfiles) {
  const fallback = normalizeStore({ profiles: fallbackProfiles });
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return { data: fallback, fingerprint: null, sourceVersion: SCHEMA_VERSION, error: null };
    return { data: fallback, fingerprint: null, sourceVersion: null, error: `无法读取配置：${error.code || error.message}` };
  }
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return { data: normalizeStore(parsed), fingerprint: digest(bytes), sourceVersion: parsed.schemaVersion ?? 0, error: null };
  } catch (error) {
    return { data: fallback, fingerprint: digest(bytes), sourceVersion: null,
      error: `配置文件不可用，已阻止覆盖，请先恢复备份：${error.message}` };
  }
}
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(handle); fs.closeSync(handle); handle = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") { /* preserve original operation outcome */ } }
  }
}
export function persistStore(file, value, loaded) {
  if (loaded.error) throw problem(loaded.error, 409);
  const data = normalizeStore(value);
  if (fileDigest(file) !== loaded.fingerprint) throw problem("磁盘配置已被其他进程修改，请重新加载后再编辑", 409);
  let backup = loaded.backup ?? null;
  if (loaded.fingerprint !== null && loaded.sourceVersion !== SCHEMA_VERSION) {
    const directory = path.join(path.dirname(file), "backups");
    fs.mkdirSync(directory, { recursive: true });
    backup = `profiles-v${loaded.sourceVersion}-${Date.now()}-${randomUUID().slice(0,8)}.json`;
    fs.copyFileSync(file, path.join(directory, backup), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(directory, backup), 0o600);
  }
  atomicWrite(file, data);
  return { data, fingerprint: digest(Buffer.from(JSON.stringify(data, null, 2))), sourceVersion: SCHEMA_VERSION, error: null, backup };
}
export function newId(prefix, taken) {
  let id;
  do { id = `${prefix}-${randomUUID().slice(0,18)}`; } while (taken.has(id));
  taken.add(id); return id;
}
export function assertVersion(item, expected, required = true) {
  if (expected === undefined && !required) return;
  if (expected === undefined) throw problem("缺少编辑版本，请刷新面板后再操作", 428);
  if (expected !== item.version) throw problem("内容已被其他窗口修改；草稿已保留，请载入最新版本后重试", 409);
}
const exportProfile = ({ version, ...item }) => ({ ...item, ruleIds: [...item.ruleIds] });
const exportRule = ({ version, ...item }) => ({ ...item });
export function exportBundle(data, kind = "all", id) {
  let profiles = data.profiles, ruleSets = data.ruleSets;
  if (kind === "profile") {
    profiles = profiles.filter(item => item.id === id);
    if (!profiles.length) throw problem("配置不存在");
    ruleSets = ruleSets.filter(item => profiles[0].ruleIds.includes(item.id));
  } else if (kind === "rule") {
    profiles = []; ruleSets = ruleSets.filter(item => item.id === id);
    if (!ruleSets.length) throw problem("规则集不存在");
  } else if (kind !== "all") throw problem("导出类型无效");
  return { format: "dsh-prompt-lab", formatVersion: 1, profiles: profiles.map(exportProfile), ruleSets: ruleSets.map(exportRule) };
}
export function validateBundle(input) {
  if (!object(input)) throw problem("导入内容须为 JSON 对象");
  if (input.format === undefined && input.formatVersion !== undefined) throw problem("导入文件缺少格式标识");
  if (input.format !== undefined && (input.format !== "dsh-prompt-lab" || input.formatVersion !== 1)) throw problem("不支持的导入格式");
  if (input.format === undefined && (input.schemaVersion !== undefined && ![1,2].includes(input.schemaVersion))) throw problem("不支持的导入版本");
  if (!Array.isArray(input.profiles) || !Array.isArray(input.ruleSets ?? [])) throw problem("导入文件缺少配置或规则列表");
  if (!input.profiles.length && !(input.ruleSets ?? []).length) throw problem("导入内容为空");
  if (input.profiles.length > MAX_PROFILES || (input.ruleSets ?? []).length > MAX_RULE_SETS) throw problem("导入数量超过上限");
  const profiles = input.profiles.map(normalizeProfile), ruleSets = (input.ruleSets ?? []).map(normalizeRule);
  unique(profiles); unique(ruleSets);
  const ids = new Set(ruleSets.map(item => item.id));
  if (profiles.some(item => item.ruleIds.some(id => !ids.has(id)))) throw problem("导入文件的规则引用不完整");
  return { profiles, ruleSets };
}
export function previewBundle(data, input) {
  const incoming = validateBundle(input);
  if (data.profiles.length + incoming.profiles.length > MAX_PROFILES || data.ruleSets.length + incoming.ruleSets.length > MAX_RULE_SETS) throw problem("合并后配置或规则数量超过上限");
  return { storeVersion: data.storeVersion,
    profiles: incoming.profiles.map(item => ({ id: item.id, name: item.name, renamedId: data.profiles.some(p => p.id === item.id) })),
    ruleSets: incoming.ruleSets.map(item => ({ id: item.id, name: item.name, renamedId: data.ruleSets.some(r => r.id === item.id) })) };
}
export function mergeBundle(data, input, expectedStoreVersion) {
  const preview = previewBundle(data, input);
  if (expectedStoreVersion !== preview.storeVersion) throw problem("导入预览后数据已变化，请重新预览", 409);
  const incoming = validateBundle(input);
  const profileIds = new Set(data.profiles.map(item => item.id)), ruleIds = new Set(data.ruleSets.map(item => item.id));
  const mapping = new Map();
  for (const item of incoming.ruleSets) {
    const id = ruleIds.has(item.id) ? newId("r", ruleIds) : (ruleIds.add(item.id), item.id);
    mapping.set(item.id, id); item.id = id; item.version = 1;
  }
  for (const item of incoming.profiles) {
    item.id = profileIds.has(item.id) ? newId("p", profileIds) : (profileIds.add(item.id), item.id);
    item.version = 1; item.ruleIds = item.ruleIds.map(id => mapping.get(id));
  }
  return { ...data, storeVersion: data.storeVersion + 1, profiles: [...data.profiles, ...incoming.profiles], ruleSets: [...data.ruleSets, ...incoming.ruleSets] };
}

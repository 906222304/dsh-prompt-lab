/**
 * 在本地解密 dsh-purge 的默认提示词（源自上游的加密资源）。
 * 解密原文仅供本地参考，npm 发布清单排除该生成文件；不自动导入或启用。
 *
 * 用法：
 *   npm run extract:purge-prompt
 *   npm run extract:purge-prompt -- 'C:\path\to\dsh-purge'
 *
 * 输出：references/dsh-purge-default-prompt.md
 * 来源：https://github.com/YuJunZhiXue/dsh-purge
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';
import { createHash, createDecipheriv } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'references', 'dsh-purge-default-prompt.md');
// 固定到上游某个提交，保证提取逻辑与加密资源格式匹配、结果可复现。
const revision = '6c1d638d1bdcc45ede50fc30249c753d58122a51';
const sourceUrl = `https://raw.githubusercontent.com/YuJunZhiXue/dsh-purge/${revision}/lib/asset-table.js`;

/**
 * 下载文本内容，带超时、体积上限与重定向白名单。
 *
 * @param {string} url 目标地址。
 * @param {number} [retries] 剩余可跟随的重定向次数。
 * @returns {Promise<string>} 响应正文。
 */
function download(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout: 15000, headers: { 'user-agent': 'dsh-prompt-lab-local-extractor' } }, (res) => {
      // 只允许跟随指向 raw.githubusercontent.com 的 https 重定向，避免被导向不受信任的主机。
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && retries > 0) {
        res.resume();
        const redirected = new URL(res.headers.location, url);
        if (redirected.protocol !== 'https:' || redirected.hostname !== 'raw.githubusercontent.com') {
          reject(new Error('拒绝重定向到不受信任的主机'));
          return;
        }
        resolve(download(redirected.toString(), retries - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub 响应 ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (b) => {
        size += b.length;
        // 上游资源只有几十 KB，超出上限说明响应异常，直接中断。
        if (size > 1024 * 1024) {
          req.destroy(new Error('数据超过 1 MiB，已终止'));
        } else {
          chunks.push(b);
        }
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/**
 * 从 asset-table.js 源码中取出加密所需的四个分片。
 * 数据以「字符串数组 + 三段独立常量」的形式导出，需要拼回完整密文。
 *
 * @param {string} jsSource 上游 asset-table.js 的内容。
 * @returns {{slot: string, mask: string, iv: string, tag: string}} 密文分片与参数。
 */
function extractEncryptedParts(jsSource) {
  const arrayMatch = jsSource.match(/const\s+SLOT_ROWS\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!arrayMatch) throw new Error('缺少 SLOT_ROWS 数组');
  const rows = JSON.parse(arrayMatch[1]);
  if (!Array.isArray(rows) || !rows.length || !rows.every((x) => typeof x === 'string')) {
    throw new Error('SLOT_ROWS 数据格式不符合预期');
  }
  // 按名取出 `export const X = "..."` 形式的常量。
  const prop = (name) => {
    const match = jsSource.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*("[A-Za-z0-9+/=]+")\\s*;`));
    if (!match) throw new Error(`缺少 ${name}`);
    return JSON.parse(match[1]);
  };
  return { slot: rows.join(''), mask: prop('MASK'), iv: prop('IV'), tag: prop('TAG') };
}

/**
 * 还原明文：按上游的密钥派生规则用 AES-256-GCM 解密，再做 zlib 解压。
 *
 * @param {string} jsSource 上游 asset-table.js 的内容。
 * @returns {string} 解密后的提示词全文。
 */
function decrypt(jsSource) {
  const { slot, mask, iv, tag } = extractEncryptedParts(jsSource);
  // 与上游对应版本的 lib/table-key.js 保持一致。
  const mix = ['cordis.slot.v2', 'dsh-purge', 'surface:web|desktop', 'ov.table.1'];
  const key = createHash('sha256')
    .update(`${mix.join('\x1e')}\x1e${mask}`)
    .digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const raw = Buffer.concat([
    decipher.update(Buffer.from(slot, 'base64')),
    decipher.final(),
  ]);
  const plaintext = inflateSync(raw).toString('utf8');
  if (!plaintext.trim()) throw new Error('解密结果为空');
  return plaintext;
}

/**
 * 主流程：优先用命令行参数指定的本地源码，否则从 GitHub 下载，然后解密并写出 Markdown。
 */
async function main() {
  const arg = process.argv[2];
  const source = arg
    ? fs.readFileSync(path.join(path.resolve(arg), 'lib', 'asset-table.js'), 'utf8')
    : await download(sourceUrl);
  const plaintext = decrypt(source);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, plaintext, 'utf8');
  console.log(`解密成功：${outputPath}`);
  console.log(`字符数：${plaintext.length}`);
  console.log('提示：这只是上游加密默认正文，不代表当前会话实际注入的提示词。');
}

main().catch((err) => {
  console.error(`解密失败：${err.message}`);
  console.error('如 GitHub 下载不通，可先克隆 dsh-purge，再将其源码根目录作为参数传入。');
  process.exitCode = 1;
});

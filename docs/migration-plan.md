# dsh-purge → prompt-lab 功能迁移计划

> 历史草案：本文保留 0.4.2 当时的分析，不再作为当前实施基线。
> 当前路线见 [下一步实施规划](next-step-plan.md)，0.4.9 实现与验证见 [变更记录](../CHANGELOG.md) 和 [宿主契约](host-contract.md)。

> 状态：**草案，待评审**。本文只做方案，不改 prompt-lab 任何代码。
> 基线：dsh-purge `1.1.71`（本机 `D:\private\github\dsh\plugin\dsh-purge`，`dshTarget: 0.2.0-rc.2`）
> 与 prompt-lab `0.4.2`（`conversation.view` 页签 + `/prompt-lab/api`）。
> 日期：2026-10-26

---

## 1. 结论先放前面

1. **两个项目的技术路线不同，迁移只能按「能力」迁，不能按「代码」搬。**
   - dsh-purge：**改宿主包文件**（patch + `.dshpurge.bak` + shim + 重启）+ 在 `system-prompt/assemble` 上做深度改写，为了兜住宿主版本差异还每 400ms 重包 `systemPrompt.assemble`。
   - prompt-lab：只用公开 API（`systemPrompt.section` + 只读观察 `assemble` 事件）+ 本地 HTTP 接口 + 一个会话页签。
2. **值得迁**：提示词多方案、规则库、能力协议段、postPrompt、注入闸门、workspace 基线策略、本地指令文件（AGENTS.md/CLAUDE.md）勾选、组装快照（已有）。
3. **不建议迁**：宿主包补丁/还原/更新/卸载/重启、net-scope 网络拦截、演练台（redteam）、CLI 与聊天命令（可后续单独立项）。
4. **核心工作量约 8 人日**（P0–P5 + 收尾，不含可选 P6），风险集中在 P3「组装后处理」。
5. **前置条件**：dsh-purge 现为商业许可（非 MIT）且有署名要求。迁移其代码/提示词进 prompt-lab 前，先确认你是作者本人或在授权范围内，并在 README 写明来源。

---

## 2. 现状对比（技术事实）

| 维度 | dsh-purge | prompt-lab |
| --- | --- | --- |
| 注入方式 | `systemPrompt.section` 注册 3 段（主注入 / 能力协议 / post），`text()` 现读磁盘 | `systemPrompt.section` 1 段（`prompt-lab:custom`，order 5100），`text()` 现读内存配置 |
| 组装阶段 | **改写**：`ctx.on("system-prompt/assemble")` 里调 `next()` 后重写 `sections`；另有 400ms 重包 `assemble` 兜底 | **只读观察**：调 `next()` 后原样返回，只拷贝快照 |
| 配置来源 | `cordis.patch.yml`（15 个开关）+ `$DSH_HOME/*.json` | `cordis.patch.yml`（`enabled`/`prompt`）+ `profiles.json` |
| 规则库 | `$DSH_HOME/rules/<id>.md|json` + `state.json`；**激活时覆盖 `$DSH_HOME/AGENTS.md`/`CLAUDE.md`**（带 `.bak`） | 无（`profiles[].rules` 只是追加到提示词正文的普通文本） |
| 本地规则 | 按 cwd 向上扫 `AGENTS.md`/`CLAUDE.md`/`*.local.md`，勾选后拼接注入（512KB 截断） | 无 |
| UI | 右侧栏 510KB 打包脚本（清洗 / 演练台），挂在 `conversation.input.right` + `shell.overlay` | 会话页签 `conversation.view`，2 个子页，~350 行手写 JS |
| 宿主文件 | **会改** `@deepseek-ai/*` 包文件，需重启 | **不碰**任何宿主文件 |
| 事件日志 | 有 `purgeLog` / 控制台 | 已移除（0.4.2 起无日志） |

证据位置（便于评审时核对）：

- 注入段注册：`dsh-purge/lib/index.js:310-343`（`addPromptSection`）、`345-388`（三段）
- 组装改写：`dsh-purge/lib/index.js:697-743`（事件钩子）、`746-774`（`prepareAssemble` + 400ms `wrapAssemble`）
- 规则库存储与激活：`dsh-purge/lib/rules.js:50-63`（目录布局）、`266-284`（`activateRule` 覆盖目标文件）、`243-257`（注入文本优先级）
- 本地规则扫描/拼接：`dsh-purge/lib/rules.js:426-458`、`538-560`
- workspace 基线策略：`dsh-purge/lib/rules.js:460-477`（policy）+ `lib/identity.js:518-534`（剥离用的 marker）
- 能力协议文本：`dsh-purge/lib/capability-protocol.js:13-30`
- 配置默认值：`dsh-purge/lib/index.js:45-63`
- 宿主补丁/更新/卸载：`lib/core.js`(369KB)/`host-clean.js`/`reapply.js`/`update.js`/`uninstall.js`/`restart-*.js`
- 演练台：`lib/redteam/*`（~1.1MB）+ `presets/redteam/` + `skills/redteam/`(25 个 md)

---

## 3. 迁移判定矩阵

等级：**A** 直接迁（公开 API / 纯用户数据）；**B** 可迁但有风险（依赖宿主事件细节）；**C** 不迁（改宿主文件 / 另一个领域）。

| # | 能力 | 等级 | 迁移方式 | 工作量 |
| --- | --- | --- | --- | --- |
| 1 | 提示词多方案（多套正文 + 切换 + 落盘） | A | **已有**，只需扩展字段（备注、来源、顺序） | 0 |
| 2 | 附加规则文本（`profiles[].rules`） | A | **已有**，保留 | 0 |
| 3 | 规则库（多套规则 / CRUD / 激活） | A | 独立 `rules/<id>.md`，激活后作为**独立 section 注入**（不覆盖 AGENTS.md） | 1.5d |
| 4 | 本地指令勾选（cwd 的 AGENTS.md/CLAUDE.md） | A | 新 `GET /api/scan?cwd=` + 勾选表，注入时拼接 | 1d |
| 5 | 能力协议段（capability protocol） | A | 新增一个文本 section，可开关 | 0.2d |
| 6 | postPrompt（尾部附加段 + order） | A | 新增 section，order 可配 | 0.2d |
| 7 | 注入闸门（enabled / 每会话一次性） | A | `enabled` 已有；`injectOnce` 按 sessionId 记账 | 0.5d |
| 8 | workspace 基线策略（strict/fallback/always） | B | `assemble` 事件里按 marker 过滤 sections（只删自己认得的两类） | 1d |
| 9 | 身份段覆盖（去 Harness 身份 / persona 前后缀） | B | 同上，按 marker 过滤或替换；`persona*` 走 patch config | 0.5d |
| 10 | 组装快照 + 改写前后 diff | A/B | 快照已有，增加「改写前/后」两份摘要 | 0.5d |
| 11 | 自动重试 / 自动继续 | B | 依赖 session 事件与 loop 细节，先做开关 + 最小实现 | 1d |
| 12 | rewind（回退一轮） | B | 客户端调 `session.fork({ atSeq })`，需确认 0.2 API 面 | 0.5d |
| 13 | skills 导入（写官方 skills 目录） | B | 需确认目标目录与格式；只做导入，不做注册 | 0.5d |
| 14 | 宿主包补丁 apply/revert（`.bak`/shim） | C | 与 prompt-lab「不碰宿主文件」的定位冲突 | — |
| 15 | 自动更新 / 卸载 / 重启宿主 | C | 属安装器职责 | — |
| 16 | net-scope（CN/HK/MO 拦截 + 白名单） | C | 网络作用域是另一层，非提示词面板目标 | — |
| 17 | 演练台（redteam：资产/技能/报告/评分/SQLite） | C | 体量与目标都不匹配（~1.1MB + 25 技能） | — |
| 18 | CLI（`dsh-purge --apply` 等）/ 聊天命令（`/purge`、`/rules`） | C | 可后续单独立项（面板已覆盖主要操作） | — |
| 19 | 模型工具（`purge_status/apply/revert`） | C | 依赖补丁流程，随 14 一起排除 | — |

---

## 4. 目标架构（prompt-lab 0.5）

### 4.1 数据目录

```
$DSH_HOME/prompt-lab/
  profiles.json          # 现有：{ selected, profiles: [{id,name,prompt,rules}] }
  settings.json          # 新增：注入段开关 / 策略 / 本地勾选
  rules/<id>.md          # 新增：规则集正文
  rules/<id>.json        # 新增：{ id, name, updatedAt }
```

`settings.json` 结构（草案）：

```json
{
  "inject": { "enabled": true, "once": false },
  "sections": {
    "prompt": true,
    "rules": true,
    "capabilities": false,
    "post": "",
    "postOrder": 5100
  },
  "assembly": {
    "workspaceBaseline": "fallback",
    "identityOverride": false,
    "stripMnemon": false
  },
  "workspace": { "cwdSelections": [], "lastCwd": "" }
}
```

沿用现有约定：原子写（tmp + rename）、`0600`、长度上限、损坏整体回退。

### 4.2 注入段（保持公开 API）

| 段名 | order | 内容 | 默认 |
| --- | --- | --- | --- |
| `prompt-lab:custom` | 5100 | 当前方案的正文（已有） | 开 |
| `prompt-lab:rules` | 5101 | 激活的规则集 + 勾选的本地指令（带 `<!-- prompt-lab:cwd-rule -->` 头） | 开 |
| `prompt-lab:capabilities` | 5102 | 能力协议文本 | 关 |
| `prompt-lab:post` | 可配 | 尾部附加 | 空 |

每段 `text()` 都是动态求值，返回空串即等于不注入（dsh-purge 也是这么做的）。

### 4.3 组装后处理链（唯一需要「改写」的地方）

在现有观察者里加一条**可关闭**的过滤链：

```
result = await next()
  ├─ stripWorkspaceBaseline(result)   # 按 marker：agent-instructions / workspace baseline 文本
  ├─ stripIdentity(result)            # 按 marker：You are an AI agent powered by DeepSeek Harness.
  └─ 记录 before/after 摘要 → 快照
return result
```

约束：
- 只删**认得 marker** 的段，其它一律不动；marker 集中在 `lib/markers.js`，便于随宿主升级维护。
- 策略全关时**零改写**，行为与 0.4.2 完全一致（回归基线）。
- 事件签名兼容两参/三参（dsh-purge 在这上面踩过坑：`args[args.length-1]` 是否为函数）。
- 下游 `next()` 抛错时回退到上游 `assembly`，不让整轮组装失败。

### 4.4 接口扩展

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/prompt-lab/api?since=` | 快照（新增 `settings`、`rules` 列表、`assembly.rewrite` 摘要），仍支持增量 |
| POST | `/prompt-lab/api` | `{ action: "profile.save" \| "profile.activate" \| "rule.save" \| "rule.delete" \| "rule.activate" \| "settings.update" \| "cwd.toggle" }` |
| GET | `/prompt-lab/api/scan?cwd=` | 扫 cwd 向上的指令文件（路径、大小、预览、scope） |

沿用现有准入（回环 + Host + `x-prompt-lab-ui` + 同源 Origin）、请求体上限、`since` 增量。

### 4.5 UI 信息架构（4 个子页）

| 子页 | 内容 | 来源 |
| --- | --- | --- |
| 提示词 | 方案列表、正文/规则编辑、保存/启用、预览 | 现有 |
| 规则 | 规则集列表（新建/编辑/删除/激活）、本地指令勾选、workspace 策略下拉 | 新增 |
| 组装 | 段列表、改写前后 diff、段开关、能力协议/postPrompt 编辑 | 扩展 |
| 设置 | 注入开关、一次性注入、身份覆盖、mnemon 剥离、关于/迁移导入 | 新增 |

---

## 5. 分阶段计划

> 每个阶段结束都可独立发布；阶段内先加测试再动实现。

### P0 决策与基线（0.5d）
- 冻结 prompt-lab `0.4.2` 作为回归基线（现有 14 个用例作为「零改写」保护网）。
- 记录宿主版本与 API 事实：`systemPrompt.section` 签名、`assemble` 事件参数形态、`renderPrompt` 的前缀过滤行为（dsh-purge 注释里提到过 `startsWith("dsh-purge")` 会被挪到最前，段名要避开同名前缀）。
- **验收**：一页 ADR 写清「为什么不用 dsh-purge 的改包路线」。

### P1 数据模型与存储（1d）
- 新增 `settings.json` 与 `rules/`；`state.js` 拆出 `lib/store.js`（原子写、权限、校验、损坏回退）。
- 兼容导入：可选读取 dsh-purge 的 `$DSH_HOME/prompt-inject.md` 与 `rules/`（**只读导入，不删原文件**）。
- **验收**：单测覆盖读写/非法输入/超长/并发写；导入后不改动 dsh-purge 任何文件。

### P2 多段注入（1d）
- 拆出四个 section，各自开关；`injectOnce` 按 sessionId 记账。
- **验收**：面板可看到每段最终文本；关掉某段后，组装快照里该段消失；`enabled=false` 时零注入。

### P3 组装后处理（1.5d，风险最高）
- `lib/rewrite.js` + `lib/markers.js`；三项策略可独立开关；before/after 摘要进快照。
- 事件签名兼容、下游异常回退。
- **验收**：
  - 全关时 14 个现有用例 + 快照与 0.4.2 完全一致（逐字节比较 `sections` 摘要）。
  - 开 `strict` 时只少了 baseline 段，其它段顺序与内容不变。
  - 下游抛错时不影响本轮组装。

### P4 规则集与本地规则（1.5d）
- 规则集 CRUD + 激活 → 作为 section 注入（**默认不写 AGENTS.md**）；如要兼容 dsh-purge 的写文件模式，做成显式开关 + `.bak` + 一键还原。
- 本地指令扫描 + 勾选 + 注入（路径白名单、512KB 截断、切目录失效）。
- **验收**：切目录后旧勾选不生效；规则集切换只影响下一轮；未勾选时零读取。

### P5 UI（2d）
- 4 个子页；沿用 `.pl-*` 语法与增量轮询；所有开关持久化。
- **验收**：面板改设置 → 刷新页面不丢 → 新会话生效；`?since=` 空闲仍只回几十字节。

### P6 可选能力（2d）
- 能力协议（0.2d）、rewind（0.5d）、skills 导入（0.5d）、自动重试/继续（1d，最不确定）。

### P7 收尾（0.5d）
- 与 dsh-purge 共存检测：同时存在时面板顶部提示「可能重复注入」。
- README 增「从 dsh-purge 迁移」章节（含导入步骤与回滚）。
- 版本 `0.5.0`。

**里程碑**：M1=P0–P2（多段注入可用，2.5d）｜M2=P3（策略层，4d）｜M3=P4–P5（规则+UI，7.5d）｜M4=P6+P7（可选，10d）

---

## 6. 明确不做（含理由）

| 不做 | 理由 |
| --- | --- |
| 宿主包补丁 apply/revert、shim、`.bak`、自动重启 | npm 一升级就失效；需重启；不可审计；与 prompt-lab「只用公开 API」定位冲突 |
| 自动更新 / 卸载 / 官方版本升级 | 属安装器（`dsh plugin`）职责 |
| net-scope 网络拦截与白名单 | 是网络作用域控制，不是提示词面板的目标 |
| 演练台 redteam（资产/技能/报告/评分/SQLite） | ~1.1MB 代码 + 25 个技能 + 事实库；应独立成包 |
| CLI / 聊天命令 / 模型工具 | 面板已覆盖主要操作；命令面可后续单独立项 |

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 宿主版本漂移（段名、marker、事件签名） | 改写误删或失效 | marker 集中管理 + 只删认得的两类 + 策略可一键关闭 + 用例锁住「零改写」 |
| 与 dsh-purge 并存 | 双注入、双 assemble 改写互相打架 | 启动检测 + UI 警告 + 文档要求二选一 |
| 覆盖用户 `AGENTS.md` | 用户文件被改 | 默认走 section 注入，不写用户文件；写文件模式需显式开启并备份 |
| 注入全文进内存/网络 | 内存与带宽 | 已有 64k×2 上限、240k 快照上限、增量轮询 |
| 一次性注入记账泄漏 | 会话多了内存增长 | 只存 sessionId 集合，上限 + 会话结束清理 |
| 许可与署名 | 合规风险 | 迁移前确认作者身份/授权；README 标注来源与改动 |

---

## 8. 验收清单（端到端）

1. 全新安装 prompt-lab 0.5：不装 dsh-purge，`systemPrompt` 里出现四段，面板四页可切换。
2. 关闭全部策略 → `assemble` 结果与 0.4.2 逐段一致。
3. `strict` 策略：baseline 段消失，其余段顺序不变，快照里能看到 before/after。
4. 规则集：新建 → 编辑 → 激活 → 新会话生效；删除后注入回到空。
5. 本地规则：勾选 cwd 的 `AGENTS.md` → 注入出现 `<!-- prompt-lab:cwd-rule -->` 头；换目录后消失。
6. 一次性注入：同一会话第二轮不再出现注入段。
7. 增量轮询：空闲 3 秒一次仍只回 <100 字节。
8. 卸载/禁用 prompt-lab：宿主提示词回到原始状态（无残留段）。
9. 与 dsh-purge 同时安装：面板出现共存警告，注入不重复。
10. 从 dsh-purge 导入：`prompt-inject.md` + `rules/` 变成 prompt-lab 的方案与规则集，dsh-purge 的文件未被修改。

---

## 9. 待你确认的三个决策

1. **范围**：只做 P0–P5 + P7（8d），还是把 P6（重试/继续/rewind/skills）也纳入？
2. **规则注入方式**：默认「section 注入，不写 AGENTS.md」（本计划推荐），还是保留 dsh-purge 的「覆盖工作区文件」模式作为默认？
3. **提示词资产**：是否把 dsh-purge 的加密默认提示词正文迁进 prompt-lab（涉及许可/署名与体积），还是只保留「导入用户自己那份」的路径？

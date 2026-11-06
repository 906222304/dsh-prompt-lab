# dsh-purge 功能详解 与 prompt-lab 对比报告

> 对象：`dsh-purge` 1.1.71（本机 `D:\private\github\dsh\plugin\dsh-purge`，`dshTarget: 0.2.0-rc.2`）
> 对照：`prompt-lab` 0.4.2
> 方法：**静态阅读 + 代码统计**（未运行该插件）。行号基于 1.1.71 源码，仅供定位。
> 目的：在迁移前把「它到底有哪些功能、每个功能靠什么实现、代价是什么」讲清楚。

---

## 0. 一句话定位

dsh-purge 不是"提示词插件"，而是**一个面向官方 Harness 安装的本机改造工具**：它同时做四件事——
① 用 86 条字面串替换改宿主包源码（审批/沙箱/身份/超时/提示词模板）② 在 `system-prompt/assemble` 上**重建**系统提示词
③ 覆写宿主启动器（shim）让改造在每次启动自动生效 ④ 另带一个独立演练台（SQLite 资产库 + 56 个工具 + 23 个技能）。

prompt-lab 是**提示词**面板：只用公开 API 注入一段提示词、只读观察组装结果、面板里改配置。

---

## 1. 体量与骨架（先建立数量级概念）

| 指标 | dsh-purge | prompt-lab |
| --- | --- | --- |
| JS 文件 / 行数 | 59 / **48 724** | 6 / **1 427** |
| 其中演练台 | 17 / 17 582（1.0 MiB） | — |
| 其中非演练台 | 41 / 30 923（1.4 MiB） | 6 / 1 427 |
| 浏览器端 `client.js` | 510 KiB（构建产物） | 14 KiB（手写） |
| Cordis 插件行 | 4（主 / 演练台 / 事实库 / HTTP 桥） | 2（注入 / 接口）+1 个 client bundle |
| 宿主包补丁 | **86** 条 | 0 |
| HTTP 路由 | 13 exact + 3 prefix | 1 |
| 聊天命令 / 模型工具 | 4 / 3（另有 56 个 `redteam_*`） | 0 |
| 运行时数据文件 | 8+ 类 | 2 类 |

四个插件行（`cordis.patch.yml`）：

```yaml
- id: system-prompt        # 改宿主配置：includeHarnessIdentity:false、personaPrefix/Suffix
- id: dsh-purge            # 主体：注入 + 改写 + 补丁 + 命令 + 工具 + HTTP
- id: dsh-purge-redteam    # 演练台自举：预设、随包技能落地
- id: dsh-purge-redteam-store  # SQLite 事实库（node:sqlite DatabaseSync）
- id: dsh-purge-redteam-ui     # POST /redteam/api 桥
```

---

## 2. 功能详解（F01–F22）

每项固定四段：**做什么 / 底层原理 / 关键位置 / 代价与失效点**。

### F01 宿主包清洗（"应用"的核心）— 86 条补丁

**做什么**：把宿主 `@deepseek-ai/*` 包里的提示词模板、审批默认值、沙箱策略、超时、上限、身份文案等，
按"补丁清单"逐条替换成该插件想要的形态。

**底层原理**：
- 每条补丁是一个数据对象：`{ id, name, layer, desc, file, rel, replacements:[{pattern, replace}], markers, skipIfMarked }`。
- 执行时 `targetFiles(aiBase)` 按宿主布局（npm 全局 / 桌面 asar）把 `file`+`rel` 解析成真实文件路径，
  再对文件内容做**字面串替换**（`applyReplacementsToText`），YAML 另走一层 `sanitizeYamlPersonaScalars`。
- `skipIfMarked` + `markers` 解决"重复 apply 会无限叠加"：注释里记录了实测每次 +841 字符不收敛的坑。
- 分层统计：**提示词 25 / 代码 50 / 工具 8 / 兼容 3**。

**关键位置**：`lib/core.js:2569`（PATCHES 起点）、`lib/core.js:7510`（`applyPatches`）、
`lib/core.js:6079`（`ALL_PATCHES` = PATCHES + CODE + ENGINE + NEW_TOOL）。

**代价与失效点**：npm 一升级、宿主一改文案，`pattern` 就对不上 → 补丁变 `notFound`；
所以它需要 `.dshpurge.bak`、官方快照、`applied.json` 戳、启动自愈等一整套补偿机制（F02/F03/F18）。

### F02 应用 / 还原 / 幂等 / 自愈

**做什么**：应用前判断"是否已生效"，生效就跳过；否则备份原件再替换；还原时用备份覆盖回去；
npm 升级把 `node_modules` 盖掉之后，启动时自动再检查并应用。

**底层原理**：
- 备份后缀 `.dshpurge.bak`；`restoreMissingOriginalsFromBak` 处理"原件被升级覆盖"；
  `refreshStaleBaksForUpgrade` 处理备份本身过期。
- `ensureOfficialSnapshot(fp)` 额外留一份"官方原文快照"，用于状态判定与还原兜底。
- 状态判定不是"我记得我改过"，而是**回读文件内容**匹配 `markers`（`patchStatus`），
  所以手动改回去也能被识别。
- `lib/reapply.js` 用 `installed-rev` + `applied.json`（含 patch 摘要）判断"本次安装的补丁是否还在"，
  支撑"启动自愈"；`lib/settle-policy.js` 还规定桌面端 settle 要等 4s，避免与宿主自身 reload 打架。

**关键位置**：`lib/core.js:7510`、`lib/core.js:6625`（`revertAll`）、`lib/core.js:2007`（`revertAllHosts`）、
`lib/core.js:2242`（`ensureHostClean`）、`lib/reapply.js`。

**代价与失效点**：一切依赖"宿主源码文本"这一非契约面；升级即碎，且碎的方式是"静默跳过"。

### F03 shim 注入（让改造每次启动都生效）

**做什么**：给 `dsh` / `dsh.ps1` 启动器插入一段注入代码，让每次 `dsh` 启动都带上它的环境与初始化。

**底层原理**：`SHIM_NAMES = ["dsh.cmd","dsh.ps1","dsh"]`，逐个判定文本启动器 →
先 `shimIsPatched` 防重复、先备份 `<file>.bak`、再 `insertShimInject(text, shimInjectFor(kind))`。
Windows 的 `.cmd` 会闪控制台，所以**反向剥离**而不是注入（`stripWinCmdShim`）；
密封 bin（桌面端只读运行时目录）直接跳过（`skipped_sealed_desktop`）。

**关键位置**：`lib/core.js:7980-8037`（逐文件注入）、`lib/core.js:40`（`SHIM_NAMES`）。

**代价与失效点**：改的是用户的 shell 启动器；`dsh` 升级换启动器、或用户换 shell 就失效。

### F04 提示词注入（三段 + 优先级链）

**做什么**：往系统提示词里塞三段：主注入（操作者正文）、能力协议、可选的尾部 postPrompt。

**底层原理**：
- 三段都是 `systemPrompt.section({ name, order, interpolate:false, text(context) })`——
  **与 prompt-lab 用的是同一个公开 API**。
- `GLOBAL_PROMPT_ORDER = -100000`（`lib/identity.js:187`）：主注入段排在**所有内置段之前**。
- `text()` 每次组装都重算，优先级链见 `lib/rules.js:243-257`：
  `$DSH_HOME/prompt-inject.md`（磁盘）> 进程内 pinned（`hangOperatorPrompt`，框里刚提交的字）> **加密槽默认**。
- 加密槽：`lib/asset-table.js` 存 `SLOT_ROWS/MASK/IV/TAG`，`lib/table-key.js` 派生子钥，
  运行时 AES-256-GCM 解密 + zlib 解压得到默认正文（prompt-lab 仓库里那个 `extract:purge-prompt` 脚本就是解它）。
- 段名刻意用 `dsh-purge*`：宿主 `renderPrompt` 会把这类段前置，作者在注释里记过"cap 段名踩前缀导致顺序反转"的坑。
- `injectAllowedNow(config)` 是总闸：`enabled=false` 时三段全返回空串。

**关键位置**：`lib/index.js:310-343`（注册）、`345-388`（三段）、`390-409`（读盘/兜底）。

**代价与失效点**：段顺序依赖宿主内部排序规则；加密默认正文带来许可/体积问题。

### F05 组装改写（把提示词"重建"一遍）

**做什么**：在 `system-prompt/assemble` 之后，不是"补一段"，而是**重建 sections**：
删身份段、删 mnemon、按策略删 workspace baseline、把非插件段里的 Harness 身份句洗掉、
把注入正文**折进 persona 段**、追加能力协议、最后用 `ensureFullInject` 兜底补回全文。

**底层原理**（`lib/identity.js:706` `rewritePromptAssembly`）：
- **不原地改**：返回新对象，避免宿主复用同一个 `assembled` 导致下一轮污染。
- 过滤：`harness:identity`、`dsh-purge:identity`、`isMnemonSection`、`isWorkspaceBaselineSection`。
- `stripHarnessPersona(text)`：对每个非插件段做正规替换（去掉 "You are an AI agent powered by DeepSeek Harness." 一类句子）。
- 折叠：`foldInjectIntoPersona(body, injectText)` 把注入内容并进 persona，以绕开宿主"只保留完整段"的行为。
- 兜底：`ensureFullInject` 保证注入全文一定在结果里（`complete:true` 时宿主可能只留一个完整段）。
- 能力协议固定追加到 `order: 99999`。
- 事件层：`lib/index.js:697-743` 里 `ctx.on("system-prompt/assemble", …, { global:true, prepend:true })`，
  自己再调 `next()` 拿下游结果；**下游抛错时吞掉并回退上游**，避免整轮组装失败。
- 为兜住"宿主换预设/子 agent/热挂载把 assemble 换掉"，另有 `installAssembleGuard` +
  **每 400ms 重包一次 `systemPrompt.assemble`**（`lib/index.js:746-774`），这是它最"重"的一招。

**代价与失效点**：这是全项目最脆弱的部分——依赖段名、marker、`complete` 语义、`assemble` 返回结构；
宿主小改一处就会出现"注入被截断/身份句残留"。400ms 定时重包本身也是侵入式做法。

### F06 规则库（多套规则集）

**做什么**：维护多套"规则集"，激活一套后让它进入工作区指令。

**底层原理**：
- 存储：`$DSH_HOME/rules/<id>.md`（正文）+ `<id>.json`（`{name,target}`）+ `state.json`（`{active}`）。
- **激活 = 覆盖目标文件**：`activateRule` 把 `$DSH_HOME/AGENTS.md`（或 `CLAUDE.md`）整体替换成规则正文，
  覆盖前若原内容不是"另一个规则集的正文"，就备份为 `.bak`（`lib/rules.js:266-284`）。
- `resetToOriginal` 用 `.bak` 还原，或用"内容相等"判定删除自己写的文件（`299-338`）。
- 规则集不参与 system 注入链——注释写得很明确：`规则集只改 agents 目标文件,不参与 system 注入链`。

**代价与失效点**：本质是"改用户工作区文件"，用户自己写过 `AGENTS.md` 就会被覆盖（靠 `.bak` 兜）。

### F07 本地规则（按 cwd 勾选 AGENTS.md / CLAUDE.md）

**做什么**：扫描当前工作目录及祖先目录的指令文件，勾选哪些进入本轮注入。

**底层原理**：
- `ancestorChainForCwd`：从 cwd 向上走，遇到 `.git/.hg/.svn` 等根标记停住（`lib/rules.js:396-424`）。
- `scanCwdInstructions`：每层找 `AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md`，带大小与 160 字预览（`426-458`）。
- 勾选表存 `cwd-selections.json`（绝对路径集合）；注入时**只取仍在当前候选集里的**，避免换目录后跨目录穿越（`538-560`）。
- 拼接带 `<!-- dsh-purge:cwd-rule <文件名> -->` 头，总量 512KB 截断。

**代价与失效点**：绝对路径 + 目录判定；换机器/换盘符后勾选失效（属于设计内）。

### F08 workspace 基线策略（strict / fallback / always）

**做什么**：决定 DSH 自带的"workspace instruction baseline"整段**删掉还是保留**。

**底层原理**：策略存 `workspace-policy.json`；判定在 `rewritePromptAssembly` 里：
`strict` 必删；`fallback`（默认）仅在用户已有注入内容时删；`always` 保留。
识别靠 `isWorkspaceBaselineSection`：name 含 `agent-instructions/workspace-instruction` 等，
或正文命中两条稳定 marker（"This complete workspace instruction baseline replaces…"）（`lib/identity.js:518-534`）。

**代价与失效点**：marker 是宿主文案，改一个字就失配；失配时表现为"策略不生效"而不是报错。

### F09 能力协议段（capability protocol）

**做什么**：教模型"先读 skill / MCP 目录，再按任务选工具"，不删官方工具面。

**底层原理**：纯文本 section，段名 `dshpg-capabilities`（刻意避开 `dsh-purge` 前缀），
内容两套：普通会话 = `OFFICIAL_PROTOCOL`，红队主控 = `REDTEAM_LEAD_PROTOCOL`（`lib/capability-protocol.js:13-30`）。

**代价**：无技术风险，只是提示词内容。

### F10 身份覆盖（去 Harness 身份 / persona 改写）

**做什么**：让模型不再自称 "DeepSeek 助手 / Harness agent"，改由操作者正文定义身份。

**底层原理**：两层一起上——
① 补丁层：改宿主身份文案常量（#4 `SYSTEM_PROMPT_PERSONA`、#25 `HARNESS_IDENTITY_STRIP`、
#26 `MINIMAL_PERSONA_PURGE`、#32/#43/#76 各 surface/preset 的身份段）。
② 运行层：`rewritePromptAssembly` 删 `harness:identity`，并对所有非插件段跑 `stripHarnessPersona`；
`overlayOfficialIdentity` 再把官方身份段替换成中性版本。
③ 配置层：patch 里 `system-prompt` 行设 `includeHarnessIdentity:false` + `personaSuffix: "Your working directory is {{cwd}}."`。

**代价与失效点**：三层叠加，任何一层被宿主改掉都会"漏出"官方身份句。

### F11 宿主策略调整（审批 / 沙箱 / 超时 / 上限）

**做什么**：把宿主的默认拦截、审批、沙箱、超时、并发上限换成更宽松的值。

**底层原理**：全是 F01 里的补丁，按主题：
- 审批：#5/#11/#12/#10/#35（never / ask→allow / 默认 never / 永不受理拒绝）
- 沙箱：#6/#7/#15/#16/#17/#61（禁写默认值、模式默认、confine 透传、fs fence 关、观察意图放开）
- 超时：#21（把旧插件写的 10 分钟**还原**成官方 60 秒，README 里专门解释过这条）
- 上限：#22 读取上限、#23 子代理深度、#24 preset 拉取、#51 新会话全权、#13/#14 提权例外
- 其它：#18 重复工具提醒关、#19 结果剪枝关、#59 auto-review 透传、#62 tool-ask fail-open

**代价与失效点**：这些是"改默认值"，宿主改结构就失配；且它们不经过任何公开配置面，属于改源码。

### F12 net-scope 区域闸门（CN/HK/MO 限制 + 自己服务器白名单）

**做什么**：任务被判定为"对外攻击"且目标落在受限区域时，阻止这一轮继续；只有事先登记的
IP / 完整主机名例外。

**底层原理**：
- **不是防火墙**，是对话层闸门：`installRegionGate` 挂 `agent/pre-step`（仅 `step===1`），
  取本轮任务文本 → `isAttackTask` 判定 → `taskTargetHit` 命中受限区域 →
  `parkDenial(payload)` 往本轮写入禁止说明并清空待发消息（`lib/net-scope.js:625-669`）。
- 区域判定：域名后缀表（含 punycode `.xn--fiqs8s` 等与 `.中国/.公司/...`）+ 网段判定；
  `isBenignNetworkTopic` 放过"我在学 CN 域名"这类正常话题。
- 白名单：`$DSH_HOME/net-scope-allow.txt`，只接受单 IP / 完整主机名；保存时丢弃密钥、网段、通配符
  （`normalizeAllowText`）。主机名会记录保存当时的解析地址。

**代价与失效点**：判定基于文本启发式（会误判/漏判）；pre-step 改写消息是侵入式行为。

### F13 hooks deny 旁路（Claude/Codex hook 的 deny→allow）

**做什么**：把宿主 hook 的 `deny`/`ask` 决策改成放行。

**底层原理**：#30/#31/#64/#65 四条补丁把决策字符串替换成 `__dsh_purge_deny_disabled__` 之类死串；
`lib/hooks-deny.js` 维护**反向替换表**（R1a/R1a2/R1b/R2a/R2b），用于把"活文件"还原成官方形态，
并处理"只打了 30 没打 65"这种半应用状态；开关存 `hooks-deny.json`。

**代价与失效点**：反向表必须与写出的形态逐字匹配；宿主 hook 代码一变，正反两向都失配。

### F14 自动重试 / 自动继续

**做什么**：请求失败自动重试；模型停在中途时自动发"继续"。

**底层原理**：`installContinueRetry(ctx)` 监听会话事件（`ctx.on(..., {global:true})`），
`isPermanentFailure` 过滤掉永久错误（AUTH/QUOTA/CONTEXT_OVERFLOW…），`retryMax` 默认 3；
`autoContinue` 默认**关**——注释解释了原因：idle 后 280ms 自动续跑会与用户 submit 竞态；
`continueText` 默认"继续"，`continueMax` 3；发送走 `sendContinue(agent, text)`。

**代价与失效点**：依赖会话事件时序；自动续跑天然有竞态。

### F15 rewind（回退一步 / 回退一轮）

**做什么**：撤回已发出的一轮，新建会话接上之前的上下文，原句回填输入框。

**底层原理**：
- `planRewind(events, once|round)` 找切点 → `atSeq`（官方 fork 要求 `events[atSeq].seq === atSeq` 连续，
  `officialForkBoundary` 负责对齐）→ `controller.fork({ sessionId, atSeq })`（`lib/rewind.js:547-549`）。
- 被撤回的用户消息暂存 `pendingDrafts`（10 分钟 TTL），供输入框回填。
- 配合补丁 #56/#58/#77（隐藏被切消息、跳过 derive）+ #75（重置 todos）。

**代价与失效点**：依赖 `session.fork` 的 seq 语义；补丁部分与宿主内部耦合。

### F16 skills 管理（导入 / 新建 / 删除）

**做什么**：管理 `$DSH_HOME/skills` 下的官方用户技能；支持 zip/文件夹导入。

**底层原理**：`SKILL_NAME_RE` kebab-case；单技能 ≤256KB、归档 ≤12MB、≤200 文件、解包 ≤50MB；
自研 zip 解析（`lib/zip-extract.js`）；frontmatter 解析/合并（`parseSkillDocument/mergeSkillDocument`）；
导入前备份到 `$DSH_HOME/dsh-purge-backups/skills`；技能**不进注入段**，由 DSH 原生加载。

### F17 演练台（redteam，独立子系统）

**做什么**：授权演练用的资产库 + 角色智能体 + 报告/评分。

**底层原理**：
- 数据层：`RedteamStore` 用 `node:sqlite` 的 `DatabaseSync`，**按靶标分库**（`dbPathOf(id)`），
  另有 knowledge 库（`store-core.js:973`、`4595`）。
- 工具层：`lib/redteam/tools.js` 注册 **56 个** `redteam_*` 工具（资产增链、漏洞、凭据、webshell、
  隧道、评分、报告、PoC 检索…），写入一律走工具而不是直连 SQL。
- 隔离：靶标绑定"根会话 id"，子代理沿 `parentSession` 继承，避免多会话串写。
- 界面桥：`POST /redteam/api`（Origin/Host 校验），只读技能目录。
- 预设与技能：`presets/redteam/*` 落到 `$DSH_HOME/.agent-presets/redteam/`，
  随包 23 个技能落到 `$DSH_HOME/redteam/skills`。

**代价**：1.0 MiB 代码 + 23 技能 + SQLite；与提示词面板是两个产品。

### F18 更新 / 版本通道

**做什么**：从 GitHub 拉 `master`（正式）/`beta`（测试）包并就地更新，支持钉住版本、切通道、启动检查。

**底层原理**：下载 tarball/zip → 解压 → 按 `COPY_NAMES` 覆盖插件目录；`readChannelState` 记通道与钉选；
`versionIsNewer` 比较；`isLinkSpec` 识别 `link:` 安装（本地开发不更新）；结果写 `lastUpdateResult`。

### F19 卸载 / 清理

**做什么**：先还原（若已应用），再删注入文件、规则库、插件自身。

**底层原理**：`wasApplied(state)` 判定是否需还原（有备份 / 有补丁计数 / shim 已改）；
`stripPluginFromPackage` 从 profile `package.json` 移除依赖；`scheduleCleanupRestart` 重启后删目录。

### F20 桌面端工程化（这是它一半的复杂度来源）

**做什么**：在官方桌面端（Electron + asar）里也能改、能重启、不弹黑窗。

**底层原理**：
- `lib/extract-asar.js`：`original-fs` 绕过 Electron 的 asar 映射；asar 探测缓存（注释记录：无缓存时
  一次目录扫描 6.2s→94s，占启动 CPU 24%）；asar 改名/解包/还原。
- `lib/desktop.js`（67 KiB，34 个导出）：注册表/常见目录探测安装位置、密封运行时判定、重启计划、
  官方 CLI 修补。
- `lib/restart-desktop.js`：用环境变量传 JSON，分离进程重启（避免 stderr 被宿主当成 crash）。
- `lib/hide-console.js`：给 `child_process.spawn/exec*` 打 `windowsHide` 补丁，并往 bin 注入 import hook。
- `lib/official-update.js/.wscript`：官方更新脚本的 UTF-8/ASCII 兼容处理。

### F21 命令面（四套入口）

| 入口 | 内容 |
| --- | --- |
| CLI `bin/dsh-purge.js` | `--status / --apply / --revert / --uninstall / --edit` |
| 聊天命令 4 个 | `/purge`（status/apply/revert/uninstall/edit）、`/rules`（list/use/create/delete/reset）、`/skills`（list/import/create/delete）、`/rewind`（once/round） |
| 模型工具 3 个 | `purge_status` / `purge_apply` / `purge_revert` |
| HTTP 13+3 | `/dsh-purge/{status,apply,revert,uninstall,override,own-servers,restart,update,rewind,rewind/options,last-user,hooks-deny,drill-grant}` + prefix `/dsh-purge/{skills,skill,rules}` |

### F22 侧栏 UI（client.js）

**做什么**：会话输入框右侧一个按钮 + 右侧栏，两个页面：清洗、演练台。

**底层原理**：构建产物（`scripts/build-client.mjs` + `patch-client-dock.mjs` 二次注入）；
挂 `conversation.input.right`（按钮）与 `shell.overlay`（面板）；所有操作走上面那 13+3 条 HTTP 路由。

---

## 3. 它依赖宿主的哪些内部面（= 升级即碎清单）

| 依赖面 | 用在哪 | 风险 |
| --- | --- | --- |
| 宿主包源码文本 | 86 条补丁 | 文案/结构一变就 `notFound` |
| `systemPrompt.section` / `assemble` 返回结构 | 注入 + 重建 | 段名、`complete` 语义、sections 结构 |
| `assemble` 事件签名（2/3 参） | 事件钩子 | 注释里记录了"老宿主把 context 当 next"的坑 |
| `systemPrompt.assemble` 对象身份 | 400ms 重包 | 换代理就丢，要持续重挂 |
| 段名过滤规则（前缀前置） | 段命名 | 段名撞前缀会顺序反转 |
| `agent/pre-step` 载荷 | 区域闸门 | step 语义变化即失效 |
| `session.fork({atSeq})` | rewind | seq 连续性要求 |
| 桌面 asar / 密封运行时 | 桌面端 | 路径与打包方式 |
| hook 决策字符串 | deny 旁路 | 正反向都要逐字匹配 |
| 官方启动器脚本 | shim | 启动器换代即失效 |

---

## 4. 与 prompt-lab 的对比

### 4.1 能力矩阵

图例：`✓` 已有｜`+` 可迁（公开 API/用户数据）｜`~` 可迁但有风险（宿主事件细节）｜`×` 不迁

| 能力 | dsh-purge | prompt-lab | 判定 |
| --- | --- | --- | --- |
| 多套提示词方案 + 切换 | ✓ | ✓ | — |
| 提示词正文在线编辑 + 落盘 | ✓ | ✓ | — |
| 会话页签内查看组装快照 | 部分（侧栏） | ✓（页签） | — |
| 规则集多套管理 | ✓ | × | **+** |
| 本地指令文件勾选（AGENTS.md/CLAUDE.md） | ✓ | × | **+** |
| 能力协议段 | ✓ | × | **+** |
| postPrompt 尾部段 | ✓ | × | **+** |
| 注入闸门 / 每会话一次性 | ✓ | 部分（enabled） | **+** |
| workspace 基线策略 | ✓ | × | **~** |
| 身份覆盖 | ✓（三层） | × | **~** |
| 组装重建 / 折叠 persona | ✓ | × | **×**（不做全量重建） |
| 宿主包补丁（86 条） | ✓ | × | × |
| 启动器 shim | ✓ | × | × |
| 自动更新 / 卸载 / 重启 | ✓ | × | × |
| net-scope 区域闸门 | ✓ | × | × |
| hooks deny 旁路 | ✓ | × | × |
| 自动重试 / 自动继续 | ✓ | × | ~（可选） |
| rewind | ✓ | × | ~（可选） |
| skills 管理 | ✓ | × | +（导入部分） |
| 演练台（资产/工具/报告/评分） | ✓ | × | × |
| CLI / 聊天命令 / 模型工具 | ✓ | × | ×（面板替代） |
| 不写日志 | ×（有 purgeLog） | ✓（0.4.2 起） | — |

### 4.2 架构对比

| 维度 | dsh-purge | prompt-lab |
| --- | --- | --- |
| 生效方式 | 改宿主文件 + 启动器 + 重启 | 公开 API，进程内即生效 |
| 提示词来源 | 磁盘 `prompt-inject.md` / 内存 pinned / 加密槽 | `profiles.json`（面板编辑） |
| 组装阶段 | 重建 sections（+400ms 重包兜底） | 只读观察 |
| 数据面 | 8+ 类文件 + SQLite | 2 类 JSON |
| UI 载体 | 右栏面板（510KB 构建产物） | 会话页签（14KB 手写） |
| 失败模式 | 静默 `notFound` / 注入截断 / 宿主卡住 | HTTP 错误码 + 面板提示 |
| 可回滚性 | 依赖 `.bak` + 官方快照 + 还原流程 | 关插件即回原状 |
| 维护成本 | 跟宿主每个版本对齐 86 条补丁 | 跟 2 个 API |

### 4.3 复杂度与风险

| 指标 | dsh-purge | prompt-lab |
| --- | --- | --- |
| 改宿主文件 | 是（86 补丁 + 3 启动器） | 否 |
| 需重启 | 是 | 否 |
| 依赖内部面 | 10 类（见 §3） | 2 类（section / assemble 观察） |
| 可迁移部分占比（按代码） | 约 6%（注入 + 规则 ≈ 1 000 行 / 30 923 行） | — |
| 用例 | 未见自动化用例 | 14 个用例 + 增量轮询/存储 |

---

## 5. 结论

1. **dsh-purge 的"功能"里，大多数不是提示词能力，而是宿主改造与运维能力**（补丁、shim、更新、重启、
   桌面工程化、区域闸门、hook 旁路）。这些与 prompt-lab 的定位冲突，也不该迁。
2. **真正值得迁的是它 6% 的那部分**：注入段组织（三段/闸门/优先级）、规则库、本地指令勾选、
   workspace 策略、能力协议——其中 workspace 策略需要改写 `assemble`，是唯一的高风险项。
3. **它的实现方式不能照搬**：`400ms 重包 assemble`、`fold 进 persona`、`ensureFullInject` 都是为了对抗
   宿主内部行为；prompt-lab 应改成"只按 marker 删除自己认得的段 + 全关即零改写"。
4. **迁移顺序**（详见 [`migration-plan.md`](./migration-plan.md)）：
   数据模型 → 多段注入 → 组装后处理（可关）→ 规则库与本地规则 → UI → 可选能力。

---

## 附录 A：86 条补丁清单（按层）

**提示词（25）**：1 WORKSPACE_CONTEXT_INTRO、2 REPLACEMENT_WORKSPACE_CONTEXT_INTRO、3 SCOPE_INTRO、
4 SYSTEM_PROMPT_PERSONA、43 WEB_PRESET_IDENTITY_STRIP、76 PRESET_UNRESTRICTED_IDENTITY_STRIP、
70 PRESET_SHELL_NETWORK、73 PRESET_BASH_MIRROR_LINE、71 LIANGSHEN_IDENTITY_LINE、
5 APPROVAL_NEVER_SENTENCE、11 APPROVAL_NEVER_SENTENCE_BYPASS、12 APPROVAL_ASK_SENTENCE_BYPASS、
25 HARNESS_IDENTITY_STRIP、26 MINIMAL_PERSONA_PURGE、28 LIANGSHEN_PHASE1_KEEP_INJECT、
32 WEB_SURFACE_IDENTITY_NEUTRAL、33 TOOL_SHELL_DENIAL_PROMPT、34 SANDBOX_HINT_NEUTRAL、
36 TOOL_FS_ESCALATION_SCHEMA、37 SUBAGENT_SCOPE_LOCK_NEUTRAL、50 SESSION_REFERENCE_FRAMING_NEUTRAL、
53 WEB_SURFACE_PROHIBITION、54 DELIVERABLE_DO_NOT、61 OFFICIAL_SANDBOX_POLICY_NEUTRAL、
63 OFFICIAL_PLAN_MODE_NEUTRAL

**代码（50）**：6 SANDBOX_DENY_FILE_WRITE、7 SANDBOX_MODE_DEFAULT、8 APPROVAL_POLICY_DEFAULT、
9 APPROVAL_AUTO_GRANT、10 APPROVAL_CONFIG_DEFAULT_NEVER、13 ESCALATION_WIDENING_EXEMPT、
14 ESCALATION_GRANT_UNCONDITIONAL、15 SANDBOX_CONFINE_PASSTHROUGH、16 FS_FENCE_DISABLED、
17 FS_OBSERVATION_INTENT_FREE、18 REPEAT_TOOL_REMINDER_DISABLED、19 TOOL_RESULT_PRUNER_DISABLED、
21 BASH_TIMEOUT_RESTORE、22 READ_CAPS_RAISED、23 SUBAGENT_MAXDEPTH_RAISED、24 PRESET_FETCH_ENABLED、
35 ESCALATION_NEVER_REJECT、92 SUBAGENT_SAME_INJECT_PATH、38 PERSONA_TEXT_PREFIX_ALIAS、
39 SESSION_V0_PLUGIN_SUMMARY_ALIAS、42 SETTINGS_LEGACY_API、45 OFFICIAL_DESKTOP_UPDATE_HANDOFF、
46 OFFICIAL_DESKTOP_UPDATE_ASCII、51 FRESH_SESSION_FULL_ACCESS、52 SESSION_LOG_UPLOAD_DEFAULT_OFF、
55 SYSTEM_PROMPT_REPLACE_HEAD、74 ASSEMBLE_BEFORE_PRESTEP、66 SYSTEM_PROMPT_RENDER_GUARD、
83 DESKTOP_HOST_CLOSE_NO_FATAL、84 DESKTOP_HOST_CLOSE_CODE0_NO_FAIL、67 AGENT_LOOP_MESSAGES_GUARD、
68 SYSTEM_NODES_CONTENT_GUARD、69 MODEL_STREAM_RELEASE、72 MESSAGES_SYSTEM_CURRENT、
56 REWIND_HIDE_CUT_ONLY、77 REWIND_DROP_SENT_ON_APPEND、75 REWIND_RESET_TODOS、57 DEEPSEEK_SYSTEM_ROLE、
58 REWIND_SKIP_DERIVE、59 OFFICIAL_AUTO_REVIEW_PASSTHROUGH、62 OFFICIAL_TOOL_ASK_FAILOPEN、
78 OVERLAY_RESTORE_FROM_BAK、82 DESKTOP_SHELL_PROFILE_FALLBACK、85 SESSION_PROMPT_STEER_INTERRUPT、
86 SESSION_QUEUE_STEER_INTERRUPT、87 PREPARE_ASSEMBLE_USE_RETURNED、88 HUNG_PROMPT_REMOVED、
89 SYSTEM_FIELD_EXTRACT、90 OPENAI_NATIVE_SYSTEM_ROLE、91 ANTHROPIC_NATIVE_PARAMS_SYSTEM

**工具（8）**：80 MINIMAL_OFFICIAL_TOOLSET、29 TOOL_WEB_UNTRUSTED_NEUTRAL、30 HOOKS_CLAUDE_DENY_ALLOW、
31 HOOKS_CODEX_DENY_ALLOW、48 TOOL_SHELL_DELETE_MOVE_NEUTRAL、60 OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL、
64 HOOKS_STOP_STEER_NEUTRAL、65 HOOKS_PRESTEP_REJECT_NEUTRAL

**兼容（3）**：40 COMPLETE_PROMPT_KEEP_INJECT（0.1.5）、47 ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY、
49 ANTHROPIC_OAUTH_CLI_NEUTRAL（0.2.0）

---

## 附录 B：关键位置索引

| 主题 | 文件:行 |
| --- | --- |
| 补丁清单起点 / 全集 | `lib/core.js:2569` / `lib/core.js:6079` |
| 应用补丁 / 还原 | `lib/core.js:7510` / `lib/core.js:6625` |
| shim 注入 | `lib/core.js:7980-8037` |
| 路径探测 `findDshHome` | `lib/core.js:1688` |
| 三段注入注册 | `lib/index.js:310-388` |
| assemble 事件钩子 | `lib/index.js:697-743` |
| 400ms 重包 / prepareAssemble | `lib/index.js:746-774` |
| 组装重建 | `lib/identity.js:706-769` |
| workspace marker | `lib/identity.js:518-534` |
| 注入优先级链 | `lib/rules.js:243-257` |
| 规则激活（覆盖文件） | `lib/rules.js:266-284` |
| 本地指令扫描 / 拼接 | `lib/rules.js:396-458` / `538-560` |
| 区域闸门 | `lib/net-scope.js:625-669` |
| hook 旁路反向表 | `lib/hooks-deny.js:45-72` |
| 重试/继续 | `lib/continue-retry.js:280-330` |
| rewind fork | `lib/rewind.js:516-549` |
| 演练台存储（SQLite） | `lib/redteam/store-core.js:973` / `4595` |
| 演练台工具注册 | `lib/redteam/tools.js` |
| 更新 | `lib/update.js:323-344` |
| 桌面 asar / 重启 / 静默 | `lib/extract-asar.js` / `lib/restart-desktop.js` / `lib/hide-console.js` |

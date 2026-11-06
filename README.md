# 提示词（dsh-prompt-lab）

> 版本：**0.5.2**；中文名：**提示词**；英文代号 `Prompt Lab`；包名 `dsh-prompt-lab`；页签 id `prompt-lab`。

DSH（DeepSeek Harness）的提示词面板：在**会话页签**里查看「已保存配置预览」「最近一次 text() 求值」和
「进程最近一次组装快照」，直接编辑、保存、切换配置，并可对轨迹里那段
「Current runtime context …」运行时上下文做**去除或脱敏**。

支持配置新建、复制、重命名、删除与 JSON 导入导出；共享规则库可被多套配置按顺序引用，
正文段与规则段分别开关。保存带编辑版本，多窗口冲突返回 409 并保留草稿。

0.5.2 参考 [Magpie](https://github.com/yetone/magpie) 的桌面界面设计，使用低对比灰阶、分组卡片、
配置列表与编辑器分栏。管理操作收进菜单，预览信息按需展开，支持明暗主题和窄屏布局。

## 组成

一个 npm 包，落成两个 Cordis 插件行 + 一个浏览器 bundle：

| 组件（行 id / 包名） | 代码 | 依赖 | 职责 |
| --- | --- | --- | --- |
| `prompt-lab` / `dsh-prompt-lab` | `lib/index.js` | `systemPrompt` | 注册正文 `prompt-lab:custom`（5100）和规则 `prompt-lab:rules`（5101）两段，动态求值；观察组装并按设置处理上下文 |
| `prompt-lab-ui` / `dsh-prompt-lab/ui` | `lib/ui.js` | `webServer` | 只注册一条路由 `/prompt-lab/api`：GET 取快照（支持增量），POST 保存/启用配置、更新设置 |
| 浏览器端 `dsh.client` | `client.js` | `slots` | 注册 `conversation.view` 页签，含提示词与规则、规则库、导入导出、组装快照、设置五个子页，数据走本地接口 |

拆两个行是为了让**依赖面互不牵连**：Cordis 的 `inject` 是硬依赖，合并后 `systemPrompt` 与
`webServer` 必须同时就绪，任一缺失就整体不工作。分开后只开接口也能用，页面里两个开关互不影响。

## 数据流

```
浏览器 Panel (client.js) ──HTTP──> lib/ui.js ──> lib/state.js <── lib/index.js ──> systemPrompt.section
      (会话页签)                  (接口组件)      (共享状态)        (注入组件)
```

两个插件行在同一个 Node 进程里 import 同一个 `lib/state.js` 模块实例。配置预览、最近求值和
组装快照分别展示，并标注配置版本与时间；进程共享的快照可能来自其他会话。

## 本地接口

| 请求 | 说明 |
| --- | --- |
| `GET /prompt-lab/api` | 返回版本、存储状态、配置、规则库、设置与进程快照；profiles/ruleSets 各项含编辑 version，轮询使用 revision（**无历史日志**） |
| `GET /prompt-lab/api?since=<revision>` | 版本一致时只回 `{ok:true,unchanged:true,revision}`（实测 196 KiB → 0.04 KiB） |
| `POST /prompt-lab/api` | body `{action:"save",id,prompt,rules,expectedVersion:1}`、`{action:"activate",id}` 或 `{action:"settings.update",contextFilter:"off"\|"strip"\|"redact", identityBreak?:boolean}`，返回新快照 |
| `GET /prompt-lab/api/export?kind=all\|profile\|rule&id=...` | 导出已保存配置和所需规则，不含快照、求值、设置或运行时路径 |
| `POST /prompt-lab/api/import` | `{action:"preview",bundle}` 校验并预览；`{action:"commit",bundle,expectedStoreVersion}` 一次性追加导入 |

配置动作支持 `create/duplicate/rename/delete/save/activate`（也支持 `profile.` 前缀）；规则动作支持
`rule.create/rule.duplicate/rule.rename/rule.delete/rule.save`。
修改已有项须带该项的 `expectedVersion`，缺失返回 428，过期返回 409；activate 可不带版本，带版本时仍校验。
`save` 还接受 `ruleIds`（有序数组）、`promptEnabled`、`rulesEnabled`；`rule.save` 接受名称、正文与 `enabled`。
删除须显式 `confirm:true`；删除启用配置还须指定 `fallbackId`，最后一套配置不可删除；被引用规则须先解除全部引用。

导入为追加副本：冲突 id 自动重分配，规则引用同步映射，不自动启用或覆盖。一次导入任一项非法即整体拒绝。
导入专用端点上限为 34,760,000 字节，按最多 20 套配置、50 套规则与最坏 JSON 转义计算；普通保存仍使用下述较小上限。

### 上下文过滤（去除 / 脱敏轨迹里那段运行时上下文）

宿主每轮请求都会把 `assembly.contexts`（工作目录、文件沙箱策略、审批策略、宿主源码路径、
Web GUI 地址等贡献）渲染成「Current runtime context. This snapshot supersedes earlier
runtime-context snapshots. …」追加进模型上下文，轨迹（Trajectory）里因此每轮都能看到。
插件在 `system-prompt/assemble` 事件里对**返回值**做后处理（绝不改入参）：

| 模式 | 行为 | 注意 |
| --- | --- | --- |
| `off`（默认） | 原样返回（同一引用，零改写） | 与未启用时逐字节一致 |
| `strip` | `contexts` 整组清空：模型与轨迹里都不再出现这段 | 其中含审批提示（工具要不要先问用户）等功能句，全去掉可能让模型更保守 |
| `redact` | 保留每条贡献的结构与功能句，把路径 / URL / 时间戳换成 `<路径>` / `<URL>` / `<时间>` | 推荐：模型仍知道环境结构与策略，但看不到具体机器信息 |

只作用于**之后的新请求**；已入库的历史不会回改。轨迹里「Time sampled / Elapsed /
Browser time zone」那几行来自官方 `@deepseek-ai/dsh-time-context` 插件（注入的是用户消息），
不在此过滤范围内。

### 渠道指纹脱敏（identityBreak，0.4.4）

WorkBuddy 国内网关对 `system`/`assistant` 消息做**大小写不敏感的精确子串匹配**，命中「第三方
agent 身份句」清单即拒（`400 / code 11128`；报错文案「这次调用没通过渠道校验」是通用托词，
换账号/换 UA 无效）。DSH 提示词里有三处这样的 span，**三处全处理才有效**（dsh-connect-workbuddy
#113/#125 的对照实测：只改任意一处不够）：

1. `You are a coding agent powered by the <模型名> model.`（首行身份句，模型名可变）
2. `You are an AI agent powered by DeepSeek Harness.`
3. `You are interacting with the user through the DeepSeek Harness Web GUI …`（约 221 字说明段）
   及 `DeepSeek Harness implementation checkout / Web GUI URL` 两行来源说明

开启后本插件在组装结果（sections + contexts）里对命中 span 的**每个词界插入 U+200B 零宽空格**
（dsh-connect-workbuddy 5.8.1 `breakIdentityClauses` 的同款做法）：网关子串匹配失配，模型读到
的每个词不变——真实 28,651 字系统提示词实测只 **+0.08%** 字节，去掉零宽后与原文逐字一致。

边界：拦截清单是实测快照，网关加词条时需更新 `lib/redact.js` 的 `IDENTITY_SPANS`；
只处理系统提示词层，历史消息里复述过这些句子的会话需要换新会话（或在中转层处理）；
与上下文过滤（strip/redact）独立，可同时开启。

准入条件（缺一即 403）：请求来自回环地址、`Host` 是本机名、带 `x-prompt-lab-ui: 1` 自定义头
（跨站表单无法在不触发 CORS 预检的情况下携带它，因此充当 CSRF 防线）、`Origin` 为空或同源。
请求体上限 `2 × 64000 × 6 + 20000 = 788000` 字节，超限返回 413。
单条配置正文（提示词或规则）≤ 64000 个 JavaScript UTF-16 单元；emoji 通常占两个单元。
请求预算包含两字段的完整 `\uXXXX` 转义空间，中文与转义输入仍受相同字段长度校验。

`configRevision` 仅随配置或设置变更递增。`evaluation` 记录最近一次宿主调用 `text()` 的文本、
配置 id、时间与版本；`assembly` 记录进程最近一次事件观察结果（`scope: "process"`）。
配置变化后保留旧结果并标记 `stale: true`，表示待新求值/新组装验证，不表示已发送给模型。

## 配置

- `cordis.patch.yml` 的 `enabled`：置 `false` 只关自定义提示词注入，仍可编辑配置、观察组装和按设置过滤。
- 在宿主中停用整条 `prompt-lab` 插件行会撤销注入与观察/过滤；仅保留接口行时，面板会提示观察未就绪。
- `cordis.patch.yml` 的 `prompt`：仅作**首次运行**的默认正文。
- 配置与共享规则一起保存在 `DSH_HOME/prompt-lab/profiles.json`（schemaVersion 2，单文件原子写；Windows 访问保护取决于实际 ACL）。
- 旧格式先在内存兼容，首次写入前保存原始字节到同目录 `backups/profiles-v<旧版本>-*.json`。损坏或未知格式会阻止覆盖；外部进程已改磁盘文件时也会拒绝写入。
- 配置最多 20 套，规则最多 50 套；每套正文/附加规则和每条共享规则正文均最多 64000 UTF-16 单元。
- 原有 `profiles[].rules` 仍为配置自己的附加规则，保持 `## 当前规则集` 文本；共享规则按 `ruleIds` 顺序追加在其后，避免重复迁移。
- 面板设置（上下文过滤模式 + 渠道指纹脱敏开关）保存在 `DSH_HOME/prompt-lab/settings.json`，
  坏字段回落默认（全关），删掉文件即复位。
- 未保存草稿只保留在本次页面内存，切走宿主页签后再返回可恢复；切换编辑配置或启用已保存版本时需确认放弃修改。刷新/关闭整个页面会丢失草稿，浏览器支持时会弹出离开确认。

## 命令（源码检出目录）

```powershell
npm run check              # 运行时、测试与辅助脚本的语法检查
npm run test               # node --test 跑用例（59 项）
npm run test:plain         # 直接执行测试文件（沙箱/受限环境下 node --test 可能 EPERM）
npm run extract:purge-prompt  # 解密 dsh-purge 上游默认提示词到 references/
npm pack --dry-run --json  # 核对发布清单
npm run test:rollback      # 需要本地 0.4.9 tgz，使用隔离夹具验证备份恢复
```

测试和辅助脚本仅在源码仓库中提供。npm 包不携带解密提示词原文、聊天归档和辅助脚本；
本地已有的参考原文文件不会被删除，也不会自动注入。隔离宿主联调方式与结果见
[宿主契约与验证](docs/host-contract.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。

真实 Chromium 渲染验收：安装 React 18/ReactDOM 18 到单独的测试依赖目录，设置
`PROMPT_LAB_BROWSER_DEPS=<该目录/node_modules>` 后运行 `npm run test:browser`；可用
`PROMPT_LAB_BROWSER` 指定 Chromium/Edge 可执行文件，用 `PROMPT_LAB_BROWSER_ARTIFACTS` 指定截图目录。
该辅助测试需要 Node 22+ 和已安装浏览器，使用隔离用户目录；插件运行时仍为 Node 18+ 且无第三方依赖。
当前界面、部署与回滚记录见 [0.5.2 交付记录](docs/release-0.5.2.md)，数据升级说明见 [0.5.1 交付记录](docs/release-0.5.1.md)。

## 排查

| 现象 | 原因 |
| --- | --- |
| 页签不出现 | 宿主要求注册了 ≥2 个 View 才画页签条；「轨迹」依赖 developerTools 开启，关掉它只剩「对话」 |
| 面板空白、配置列表为空 | 只启用了 `prompt-lab-ui` 行时状态从未初始化；0.4.0 起由 `ensureInitialized()` 兜底 |
| 组装快照一直为空 | 注入插件行未加载、宿主没暴露 `system-prompt/assemble`，或进程尚无新组装；面板展示进程最近一次结果，不按会话隔离 |
| 请求 403 | 不是同源请求，或缺 `x-prompt-lab-ui` 头 |
| 保存报错 | 参数问题返回 400、请求体超限返回 413、写入失败（EACCES/EPERM/EROFS）返回 500；失败保留草稿 |
| 页签显示但内容不刷新 | 轮询被退避挡住（连续失败会 3s→6s→12s→24s→30s 退避），恢复后自动回到 3s |
| 轨迹里还看得到运行时上下文 | 过滤只作用于新请求，历史不回改；确认「设置」页签的模式不是「关闭」；若宿主没暴露 `system-prompt/assemble` 则过滤无法生效 |
| 轨迹里「Time sampled / Elapsed」还在 | 那几行来自官方 `dsh-time-context` 插件（用户消息），不在本过滤范围；需要关掉请走该插件自己的配置 |
| WorkBuddy 报 400 / 11128「渠道校验」 | 系统提示词命中网关的第三方 agent 身份句清单；在「设置」页签开启**渠道指纹脱敏**后新请求生效；历史消息复述过身份句的旧会话需换新会话 |

## 已知边界

- 面板展示的是 `text()` 返回值与组装事件快照，**不等于模型 API 最终请求正文**。
- 启动时仅注册回调，不把配置预览记成已发生的宿主求值；快照作用域为整个进程。
- 插件**不记录任何事件日志**：没有内存缓冲、不落磁盘、也不打印控制台（唯一输出是接口挂载成功时那一行
  `[prompt-lab] UI registered`）。提示词全文只留在内存里的 `lastFullText` 与组装快照中，供面板读取。
- 组装快照正文的共享上限为 240000 个 UTF-16 单元；sections 和 contexts 都显示保留量、原长与截断标记。
- `strip` 会把动态上下文**整组**去掉，包括审批策略这类功能性句子；想保留结构只遮数值请用 `redact`。

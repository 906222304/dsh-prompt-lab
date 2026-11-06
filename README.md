# 提示词（dsh-prompt-lab）

> 中文名：**提示词**；英文代号 `Prompt Lab`；包名 `dsh-prompt-lab`；页签 id `prompt-lab`。

DSH（DeepSeek Harness）的提示词面板：在**会话页签**里就地剖开「这次实际注入的系统提示词」和
「系统提示词的组装快照」，直接编辑、保存、切换配置，并可对轨迹里那段
「Current runtime context …」运行时上下文做**去除或脱敏**。

## 组成

一个 npm 包，落成两个 Cordis 插件行 + 一个浏览器 bundle：

| 组件（行 id / 包名） | 代码 | 依赖 | 职责 |
| --- | --- | --- | --- |
| `prompt-lab` / `dsh-prompt-lab` | `lib/index.js` | `systemPrompt` | 把配置里的提示词注册成 `systemPrompt.section`（`prompt-lab:custom`，order 5100，`text()` 每次组装时动态求值），并在 `system-prompt/assemble` 上观察 + 按设置过滤 `contexts`（`lib/redact.js`） |
| `prompt-lab-ui` / `dsh-prompt-lab/ui` | `lib/ui.js` | `webServer` | 只注册一条路由 `/prompt-lab/api`：GET 取快照（支持增量），POST 保存/启用配置、更新设置 |
| 浏览器端 `dsh.client` | `client.js` | `slots` | 注册 `conversation.view` 页签（与「对话」「轨迹」并排），面板三个子页：**提示词与规则**、**组装快照**（含动态上下文形态）、**设置**，数据全部走本地接口 |

拆两个行是为了让**依赖面互不牵连**：Cordis 的 `inject` 是硬依赖，合并后 `systemPrompt` 与
`webServer` 必须同时就绪，任一缺失就整体不工作。分开后只开接口也能用，页面里两个开关互不影响。

## 数据流

```
浏览器 Panel (client.js) ──HTTP──> lib/ui.js ──> lib/state.js <── lib/index.js ──> systemPrompt.section
      (会话页签)                  (接口组件)      (共享状态)        (注入组件)
```

两个插件行在同一个 Node 进程里 import 同一个 `lib/state.js` 模块实例，所以「注入用的文本」和
「面板里看到的文本」天然一致。

## 本地接口

| 请求 | 说明 |
| --- | --- |
| `GET /prompt-lab/api` | 返回完整快照：`status` / `profiles` / `selected` / `effectivePrompt` / `settings` / `assembly`（含 `contexts`）/ `revision`（**无日志**，插件不记录事件历史） |
| `GET /prompt-lab/api?since=<revision>` | 版本一致时只回 `{ok:true,unchanged:true,revision}`（实测 196 KiB → 0.04 KiB） |
| `POST /prompt-lab/api` | body `{action:"save",id,prompt,rules}`、`{action:"activate",id}` 或 `{action:"settings.update",contextFilter:"off"\|"strip"\|"redact", identityBreak?:boolean}`，返回新快照 |

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
请求体上限 `4 × 64000 + 20000` 字节，单条配置正文（提示词或规则）≤ 64000 字符。

## 配置

- `cordis.patch.yml` 的 `enabled`：置 `false` 只关提示词注入，接口与面板照常。
- `cordis.patch.yml` 的 `prompt`：仅作**首次运行**的默认正文。
- 之后的所有编辑保存在 `DSH_HOME/prompt-lab/profiles.json`（原子写、权限 0600）。
- 面板设置（上下文过滤模式 + 渠道指纹脱敏开关）保存在 `DSH_HOME/prompt-lab/settings.json`，
  坏文件自动回落默认（全关），删掉文件即复位。

## 命令

```powershell
npm run check              # 六个源文件的语法检查
npm run test               # node --test 跑用例（24 个）
npm run test:plain         # 直接执行测试文件（沙箱/受限环境下 node --test 可能 EPERM）
npm run extract:purge-prompt  # 解密 dsh-purge 上游默认提示词到 references/
```

## 排查

| 现象 | 原因 |
| --- | --- |
| 页签不出现 | 宿主要求注册了 ≥2 个 View 才画页签条；「轨迹」依赖 developerTools 开启，关掉它只剩「对话」 |
| 面板空白、配置列表为空 | 只启用了 `prompt-lab-ui` 行时状态从未初始化；0.4.0 起由 `ensureInitialized()` 兜底 |
| 组装快照一直为空 | 宿主没暴露 `system-prompt/assemble`，或当前会话还没发过消息 |
| 请求 403 | 不是同源请求，或缺 `x-prompt-lab-ui` 头 |
| 保存报错 | 参数问题返回 400，写入失败（EACCES/EPERM/EROFS）返回 500 |
| 页签显示但内容不刷新 | 轮询被退避挡住（连续失败会 3s→6s→12s→24s→30s 退避），恢复后自动回到 3s |
| 轨迹里还看得到运行时上下文 | 过滤只作用于新请求，历史不回改；确认「设置」页签的模式不是「关闭」；若宿主没暴露 `system-prompt/assemble` 则过滤无法生效 |
| 轨迹里「Time sampled / Elapsed」还在 | 那几行来自官方 `dsh-time-context` 插件（用户消息），不在本过滤范围；需要关掉请走该插件自己的配置 |
| WorkBuddy 报 400 / 11128「渠道校验」 | 系统提示词命中网关的第三方 agent 身份句清单；在「设置」页签开启**渠道指纹脱敏**后新请求生效；历史消息复述过身份句的旧会话需换新会话 |

## 已知边界

- 面板展示的是 `text()` 返回值与组装事件快照，**不等于模型 API 最终请求正文**。
- 插件**不记录任何事件日志**：没有内存缓冲、不落磁盘、也不打印控制台（唯一输出是接口挂载成功时那一行
  `[prompt-lab] UI registered`）。提示词全文只留在内存里的 `lastFullText` 与组装快照中，供面板读取。
- 组装快照 240000 字符为内存上限，超长内容会被截断并在界面标注。
- `strip` 会把动态上下文**整组**去掉，包括审批策略这类功能性句子；想保留结构只遮数值请用 `redact`。

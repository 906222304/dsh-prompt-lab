# 0.6.3 实施与完成审计

目标：按 dsh-purge 差距评审的优先级推进，基于 0.6.2 已有能力补齐项目规范来源、诊断、失败回归，并推进显式会话适用范围和场景组合。

| 要求 | 实现 | 直接验收证据 |
| --- | --- | --- |
| 项目规范有限发现、选择、预览、原文冻结；不改写工作区 | lib/studio/workspace.js、runtime.js、WorkspacePicker | project-diagnostics.test.mjs：根/祖先/当前目录、无根、子目录排除、变化 409、UTF-8/单文件/总量预算、junction 越界、只发送所选材料；browser-smoke 实际 HTTP/React 操作 |
| 分层保存/注册/求值/组装/最终请求证据；不冒认已发送 | lib/diagnostics.js、state.js、InjectionDiagnostics | project-diagnostics 最后一例：来源版本/哈希、排除、过期/截断、重复检测与 verified=false；host-smoke 实际 session 关联；browser-smoke 诊断文案 |
| 失败会话转未保存可编辑训练草稿，确认后保存来源 | regression.js、provenance.js、suites.js、ExperimentPanel | regression-source.test.mjs：不发未选消息、固定原输入、模型 validation 被强制 train、无自动保存、确认门槛、来源持久化/哈希、输入漂移与验证分组拒绝；浏览器确认与保存 |
| 会话固定完整资产，独立于全局选择/共享规则后续编辑，重载保留 | bindings.js、state.evaluate、SessionBindings | session-bindings.test.mjs：跨会话、规则变更、重载、子会话不继承、解除、陈旧预览/项目变化/损坏文件；host-smoke 调用真实 assembleContextFor 和 SystemPrompt |
| 场景保存配置/规则/模型/测试集/完整预算；预览再载入，不自动启用/调用 | scenarios.js、runtime.js、ExperimentPanel | scenarios.test.mjs：冻结内容、统计不改变版本匹配、未保存草稿、来源漂移、供应商、损坏与删除；浏览器验证调用数不变、完整预算额外字段载入后再保存 |
| 旧配置与测试集继续可读；新数据的回退边界明确 | profiles schemaVersion 2 不变，SuiteStore 兼容 version 1/2；独立 bindings/scenarios 文件 | package-smoke 使用实际 0.6.3 与实际 0.6.2 tgz：旧版读取核心资产、忽略绑定/拒绝 v2 测试集；恢复当前版再次读取；测试只用临时 DSH_HOME |
| 安装包包含全部运行模块，排除本机材料和测试夹具 | package.json 显式 files | npm pack 文件清单、package-smoke 由解包模块验证新功能与既有优化/采用/恢复 |

命令及结果位置：

- `npm run check`、`npm test`、`npm run test:plain`：`.scratch/check-0.6.3.log`、`tests-0.6.3-final.log`、`plain-0.6.3-final.log`。
- `scripts/browser-smoke.cjs`：`.scratch/browser-0.6.3-final.log`，截图 `.scratch/browser-artifacts-0.6.3/`；真实 Chromium，合成服务与数据。
- `scripts/host-smoke.cjs`：`.scratch/host-0.6.3.out/.err`；真实宿主模块，隔离 Cordis Context。
- `npm pack --json`、`scripts/package-smoke.cjs`：`.scratch/pack-0.6.3.json`、`package-0.6.3.log`。

这里 .scratch 指仓库的同级目录 `D:/private/github/dsh/plugin/.scratch`。该目录不进入安装包。

上游方案的条件项（额外重试、尾部段、静态能力协议、聊天撤回）已作取舍，不在本次引入重复机制；没有移植宿主补丁或红队业务平台。源评审保留固定上游提交及适用边界。

本地候选版仅完成源码、安装包与隔离验证，不表示已提交、推送、npm 发布或替换真实运行实例。

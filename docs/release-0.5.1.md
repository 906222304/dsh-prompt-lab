# 0.5.1 交付、测试与回滚记录

开发与验证：2026-11-06；交付：2026-11-07（Asia/Hong_Kong）。本版合并交付路线中的 0.5.0 配置管理和 0.5.1 独立规则库。

## 版本基线

- 旧版基线：本地 Git 标签 `v0.4.9`，提交 `df4bcea`；未推送远端。
- 旧版安装包：`dsh-prompt-lab-0.4.9.tgz`，SHA256 `659EE9A8129FFB9C8A235381F2C9C016005AFF59E77FDBC0EDD3FD9462E5BA6B`。
- 新版代码版本：`0.5.1`；交付安装包名称为 `dsh-prompt-lab-0.5.1.tgz`。
- 本地运行 profile 继续使用工作区目录链接；npm 发布为独立动作，本轮不发布。

## 要求与证据

| 要求 | 实现与验证 |
| --- | --- |
| 配置新建、复制、重命名、删除和启用回退 | state 配置动作及面板入口；management.test 回归与真实浏览器操作 |
| 最后一套配置保护、保存失败不改内存 | 管理回归覆盖最后一项删除、原子 rename 失败与临时文件清理 |
| 多窗口冲突保护 | HTTP 428/409 回归；浏览器模拟另一窗口写入后保存，草稿保留并可载入最新版本 |
| 旧数据迁移与恢复 | lazy load；首次写入备份原始字节；迁移与未知版本保护测试；rollback-smoke 用 0.4.9 代码恢复求值 |
| 配置与规则导入导出 | bundle 格式版本 1；预览无写入，提交检查 storeVersion；规则 id 冲突与引用共同映射 |
| 批量与 Unicode 边界 | 单项 64000 UTF-16 单元、配置 20、规则 50；导入独立上限 34,760,000 字节；验证中文转义大于普通保存预算的合法导入 |
| 独立规则 CRUD、停用与引用保护 | 单文件 schemaVersion 2；管理回归、规则引用列表与禁删按钮、浏览器规则 CRUD |
| 有序引用与正文/规则独立开关 | 两个动态 section；单元测试与真实 SystemPrompt 验证段内容、顺序及开关 |
| 旧附加规则不重复迁移 | 原 profiles[].rules 继续保留，规则段中只拼装一次，再按 ruleIds 顺序拼共享规则 |
| 文件写入完整性 | 配置与共享规则在同一原子文件；校验失败、写入失败和过期导入均不改变状态 |
| 草稿与布局 | 真实 React DOM 验证配置/规则草稿恢复；1200、520、360px 无横向溢出 |
| 宿主生命周期与路由 | 真实 Cordis/SystemPrompt/WebServer 验证 API、导出、导入、禁用注入后过滤以及卸载恢复 |

## 已执行检查

- `npm run check`：运行时、测试及辅助脚本语法检查。
- `npm test`：58 项通过、0 失败；包含 1 项旧测试目录清理检查。
- `npm run test:plain`：四个测试文件的备用执行入口。
- `npm run test:host` 的宿主运行时形式：在 DSH `0.2.2-rc.1`、Electron `44.7.0` / Node `v24.21.0` 上隔离运行。
- `npm run test:browser`：真实 Chromium 和 React 18.3.1 / ReactDOM 18.3.1；Node `v22.22.0`；测试依赖只安装在工作区 .scratch，不进入插件运行依赖或发布包。
- `npm run test:rollback`：将隔离夹具升级到 schema 2 后恢复原始备份，并用真实 0.4.9 包核对原正文与附加规则组合。
- `npm pack` 与发布清单检查：仅运行时与指定说明文档；排除聊天归档、解密参考原文、测试、脚本与浏览器依赖。

以上记录的完整成功结论以交付前各命令最终退出码和输出为准；执行中的失败会修正后重跑相关检查。
浏览器截图保存在本工作区外层 `.scratch/browser-artifacts-0.5.1`，只含隔离夹具内容。

## 当前 profile 部署验证

已在 2026-11-06 通过既有工作区链接热加载 0.5.1，无需重启宿主。
部署前备份位于 `C:\Users\yyyyyytd\.dsh\backups\prompt-lab-0.5.1-1793980655126`，
含当时的 profile manifest、patch、提示词/设置数据以及 0.4.9 回滚安装包。

- 在线 API 返回 `version:0.5.1`，观察器已注册，配置 3 套、共享规则 0 套，存储无错误。
- 宿主前端资源 revision 为 `d3c320fa757f`，返回内容包含完整当前 client.js 源码。
- GET 导出和无副作用的 POST 导入预览成功；缺少 UI 头的导出请求返回 403；空闲 since 响应为 41 字节。
- 真实用户的 profiles.json、settings.json 校验值与组合提示词预览保持不变；profile patch 原文恢复。
- 部署时 `needsMigration:true`，表示仅在内存兼容旧文件；首次真实保存前才自动生成迁移备份并写入 schema 2。在线验证未提交任何测试配置或规则。

## 数据结构与升级说明

```text
DSH_HOME/prompt-lab/
  profiles.json    # schemaVersion:2；storeVersion、selected、profiles、ruleSets
  settings.json    # 原格式；contextFilter、identityBreak
  backups/         # 首次新格式写入前的旧 profiles.json 原始字节
```

加载旧格式时先在内存添加版本、空 ruleIds 和默认开关，不立即写磁盘。首次数据写入前生成
`profiles-v0-<时间>-<随机标识>.json`（或相应旧 schema 版本），再整体提交新 profiles.json。
profile/rule 的 item version 用于编辑冲突，storeVersion 用于导入预览冲突，revision 只用于轮询。
API 写入须提供页面载入时的 expectedVersion；发生冲突不能直接覆盖，应保留草稿并重新载入/合并。

## 回滚步骤

1. 在宿主插件管理中停用 Prompt Lab 的注入与接口行；先把当前 schema 2 数据另存备份，避免丢失升级后的编辑。
2. 将目标版本匹配的旧 profiles.json 副本恢复到原位置。可使用升级前部署备份，或上述首次迁移自动备份。settings.json 格式未变化，但若要求恢复原设置，应使用同一时间点的备份。
3. 使用官方 CLI 将 desktop profile 的插件依赖切回保留的 0.4.9 tgz，例如 `dsh plugin --profile desktop add '<旧包绝对路径>' --offline --ignore-scripts`。profile 改动前保留其 manifest 与 patch；此操作不修改宿主安装文件。
4. 重新启用插件行，确认 API 可用、配置选择正确，下一次组装恢复旧的单段正文与附加规则。
5. 回到开发版本时，重新使用既有工作区目录链接并验证版本；仅在需要时恢复匹配的新格式备份。

必须同时匹配代码和数据。只换回旧代码不能保证新共享规则或开关继续生效；不要让旧版覆盖唯一一份新格式数据。
隔离回滚测试已证明备份原始字节和旧版求值可恢复，不在真实用户数据上演练删除或覆盖。

## 范围边界

- 用户原生 DSH 窗口的直接点击通道受本机自动化沙箱故障影响；本轮使用真实浏览器渲染操作验收和真实宿主模块隔离联调，明确区分两者。
- 快照仍为进程最近一次观察结果；本地指令扫描、按会话快照和模型最终请求验证不属于本版范围。
- 不发布 npm，不改宿主源码，不覆盖 AGENTS.md/CLAUDE.md，不把提示词正文写入事件日志。

# 0.4.9 宿主契约与验证

验证日期：2026-11-06。宿主模块来自本机 `D:\app\tool\DeepSeek Harness\resources\app.asar\dsh\node_modules`，
仅作只读检查；隔离联调运行于新的 Cordis Context 和临时 `DSH_HOME`，未加载用户会话或调用模型。

## 实际检查的模块

| 项目 | 本机事实 |
| --- | --- |
| `@deepseek-ai/dsh-system-prompt` | `0.2.2-rc.1` |
| `@deepseek-ai/dsh-desktop-host` | `0.2.2-rc.1` |
| 宿主运行时 | Electron `44.7.0`、Node `v24.21.0` |
| Cordis 事件实现 | 安装包中 `@deepseek-ai/cordis/lib/index.js` 的 `EventsService.waterfall` |

以下位置均为这份已安装包内部源码行号，并非上游所有版本的通用保证。

## 接口事实

1. `@deepseek-ai/dsh-system-prompt/lib/index.js:255-257`：`section(section)` 要求有限数值的 order，注册为随 Cordis effect 销毁的条目。插件保留 `prompt-lab:custom`、order 5100、`interpolate:false` 和动态 text 回调。
2. 同文件 `:389-390`：宿主组装时调用 `section.text(context)`；最终 assembly 的 section 不一定包含 order。因此面板允许 order 为 null。
3. 同文件 `:401`：宿主调用 `ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly))`。
4. `@deepseek-ai/cordis/lib/index.js:903-917`：waterfall 给监听器附加 next，next 继续分发，并禁止同一个监听器重复调用。因此这份宿主传给插件的是 `(assembly, context, next)`；插件只调用一次 next，并处理其返回结果。两参 `(assembly,next)` 是额外兼容分支，有自动测试，但本机宿主没有采用该形态。
5. `@deepseek-ai/dsh-system-prompt/lib/index.js:402-411`：事件后还会补工具列表；启用 complete section 或抑制 runtime context 时，也可能再替换 sections 或过滤 contexts。观察快照不能作为最终模型请求正文的证明。
6. 插件当前不使用事件 context 中的会话字段，状态为进程共享的最近一次结果。`assembly.scope="process"`，不会通过时间或文本推断会话归属。

## 生命周期与异常约定

- `config.enabled=false` 只跳过自定义 section，保留组装监听、过滤和配置编辑。
- 空正文仍注册动态 section，返回空串；之后保存非空正文即可恢复，无需重载。
- 停用整个 `prompt-lab` 插件行会由 Cordis 撤销 section 与监听器，清理函数标记 disposed；单独的 API 行仍可显示、编辑已保存配置。
- 启动时不主动求值 text；`evaluation=null` 表示尚未观察到宿主调用。
- 配置或设置变化后，旧 evaluation 与 assembly 保留并标为 stale。仅保留最近一份观察结果，不记录历史日志。
- 下游 next 的异常传播给宿主；插件自己的处理异常返回 next 已得到的未处理结果。若能捕获回退快照，会标记 `processingFailed=true`。

## 已执行验证

- `npm run check`：运行时、测试及辅助脚本语法通过。
- `npm test`：43/43 通过；包括原有 24 项、12 项后端边界回归、7 项前端交互回归。
- 前端回归运行真实 Panel、effect 和事件处理器，使用可控的 React hooks/fetch 替身验证交错响应与草稿状态；这不等同于真实浏览器渲染验证。
- `scripts/host-smoke.cjs`：在本机真实 Cordis/SystemPrompt 上验证动态 section、保存后新组装、redact、进程快照、禁用注入时 strip，以及卸载撤销并恢复原始上下文；退出码 0。
- `npm pack --dry-run --json`：通过显式发布清单排除解密提示词原文、聊天归档、测试和辅助脚本；包含运行时、说明、变更记录与本文。

## 重跑隔离宿主联调

脚本在源码仓库中提供，需要可加载宿主模块的运行时；本机使用宿主自带的 Electron Node 模式。
以下示例在源码根目录运行，日志写入临时目录，等待完成且不显示桌面窗口；路径按安装位置调整。

```powershell
$taskDshExe = 'D:\app\tool\DeepSeek Harness\DeepSeek Harness.exe'
$taskHostModules = 'D:\app\tool\DeepSeek Harness\resources\app.asar\dsh\node_modules'
$taskSmokeScript = Join-Path (Get-Location) 'scripts\host-smoke.cjs'
$taskOldElectronMode = $env:ELECTRON_RUN_AS_NODE
$taskSmokeOut = Join-Path $env:TEMP 'prompt-lab-host-smoke.out'
$taskSmokeErr = Join-Path $env:TEMP 'prompt-lab-host-smoke.err'
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $taskSmokeArgs = @('"' + $taskSmokeScript + '"', '"' + $taskHostModules + '"')
  $taskSmokeProcess = Start-Process -FilePath $taskDshExe -ArgumentList $taskSmokeArgs -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $taskSmokeOut -RedirectStandardError $taskSmokeErr
  Get-Content -LiteralPath $taskSmokeOut
  Get-Content -LiteralPath $taskSmokeErr
  if ($taskSmokeProcess.ExitCode -ne 0) { throw 'Host smoke failed' }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $taskOldElectronMode
}
```

宿主模块是普通目录、且当前 Node 支持该版本的宿主依赖时，也可使用 `npm run test:host -- '<node_modules 绝对路径>'`。
普通 Node 不能直接加载 app.asar 内部模块；不要因此修改或解包宿主安装。

## 尚未验证

- 真实 DSH 桌面界面中的人工操作验收：切页签、切会话、重载插件及页面关闭确认。
- 模型调用最终请求、网关响应及渠道兼容性；本轮未新增或扩展现有渠道文本变换。
- 本机以外的宿主版本。

这些验证不影响本地代码和安装包交付；上线发布前应完成目标桌面环境的操作验收。

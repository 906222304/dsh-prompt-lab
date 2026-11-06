# dsh-purge 参考默认提示词：本地解密导出

本文件夹不预置第三方项目的完整默认提示词原文。可使用随包脚本从 `dsh-purge` 公开仓库中的加密资源生成本地 Markdown：

**在线下载并解密**（PowerShell，在插件根目录）：

```powershell
npm run extract:purge-prompt
```

**已经下载 `dsh-purge` 源码时**，可离线解密：

```powershell
npm run extract:purge-prompt -- 'D:\private\github\dsh\plugin\prompt-lab'
```

成功之后，同目录生成 `dsh-purge-default-prompt.md`，可以用 VS Code 直接查看。不会自动导入或启用，也不会改变提示词面板的配置。若想测试，可将原文自行粘贴到提示词面板的提示词编辑器，并在授权环境内验证。

来源：[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)，提取脚本针对固定的源代码版本 `6c1d638d1bdcc45ede50fc30249c753d58122a51`，依赖 Node.js 18+ 内置模块，不需要额外 npm 包。提示词的使用与传播请遵守原项目的许可证及使用说明。

注意：解密出的内容是参考项目**内置默认提示词**，不是 DSH 模型调用的最终完整上下文，也不代表模型已经实际接收。

# dsh-purge 参考默认提示词：本地解密导出

`references/dsh-purge-default-prompt.md` 本地参考文件仍不列入 npm 发布清单。2026-11-08 按用户要求，将其现有第一套文本逐字固化到 `lib/default-prompt.js`，作为唯一初始默认“越狱破甲”，并随运行时代码携带；署名及 LICENSE/NOTICE 位于 `licenses/`。新默认不会覆盖已保存的用户配置。源码检出目录可能已有本地参考原文，提取脚本只更新参考文件，不自动更新固化默认文本。源码仓库中的辅助脚本可从 `dsh-purge` 公开仓库的加密资源生成本地 Markdown；脚本不随 npm 包发布。

**在线下载并解密**（PowerShell，在源码检出目录）：

```powershell
npm run extract:purge-prompt
```

**已经下载 `dsh-purge` 源码时**，可离线解密：

```powershell
npm run extract:purge-prompt -- 'D:\private\github\dsh\plugin\dsh-purge'
```

成功之后，同目录生成 `dsh-purge-default-prompt.md`，可以用 VS Code 直接查看。不会自动导入或启用，也不会改变提示词面板的配置。若想测试，可将原文自行粘贴到提示词面板的提示词编辑器，并在授权环境内验证。

来源：[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)，提取脚本针对固定的源代码版本 `6c1d638d1bdcc45ede50fc30249c753d58122a51`，依赖 Node.js 18+ 内置模块，不需要额外 npm 包。提示词的使用与传播请遵守原项目的许可证及使用说明。

注意：解密出的内容是参考项目**内置默认提示词**，不是 DSH 模型调用的最终完整上下文，也不代表模型已经实际接收。

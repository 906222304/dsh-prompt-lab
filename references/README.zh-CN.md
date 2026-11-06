# dsh-purge 参考默认提示词：本地解密导出

npm 发布包不包含第三方项目的完整默认提示词原文。源码检出目录可能已有本地参考原文，0.4.9 不删除该文件，
但通过显式发布清单排除它。源码仓库中的辅助脚本可从 `dsh-purge` 公开仓库的加密资源生成本地 Markdown；脚本不随 npm 包发布。

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

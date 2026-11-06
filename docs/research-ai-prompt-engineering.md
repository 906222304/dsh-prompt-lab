# Prompt Lab：AI 辅助提示词工程方案调研

检索日期：2026-11-07。基于项目公开 README、官方文档和本地 0.5.4 代码检查；未安装这些项目，未对其优化收益做本机实测。下文区分已有开源能力与 Prompt Lab 建议方案。

## 结论

当前 Prompt Lab 已有配置与规则的管理、组合、冲突保护和注入能力，但没有模型调用层、AI 创作入口或提示词效果评测。下一阶段需要让 AI 承担起草、定向修改、规则提取与样例整理，让用户主要提供目标、反馈和采用决定。

优先参考 prompt-optimizer 的交互，结合 ACE 的增量规则沉淀思路，并用 Promptfoo 风格的测试验证效果。GEPA / PromptWizard 可作为有评估数据后的优化引擎候选，不应把算法框架本身当成即插即用的 DSH 插件。

## 已查到的开源方案

| 项目 | 已有能力 | 对 Prompt Lab 的意义 |
| --- | --- | --- |
| [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) | 系统/用户提示词优化、多轮迭代、分析与对比评估、模板/变量、上下文测试；提供 optimize-system-prompt、optimize-user-prompt、iterate-prompt 等 MCP 工具 | 最接近直接可用的创作界面。可参考交互，也可评估单独部署后经 MCP 调用；尚未验证 DSH 中的实际联通 |
| [ace-agent/ace](https://github.com/ace-agent/ace) | Generator → Reflector → Curator，结合反馈对 playbook 做增量更新、去重与修剪 | 适合把反馈中的可复用经验提为规则候选，保留来源；不是将整段聊天原样永久注入 |
| [kayba-ai/agentic-context-engine](https://github.com/kayba-ai/agentic-context-engine) | ACE 工程实现，持久策略集合、执行轨迹反思、策略维护；TraceAnalyser 可使用预录轨迹 | 可评估现成的规则学习后端；与 ace-agent/ace 为不同仓库，不能混同实现与结果 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 多提示词/模型测试，确定性断言与模型评分，结果矩阵 | 适合比较当前版/候选版的输出和通过率。JavaScript/Node 工具生态与本插件较接近 |
| [gepa-ai/gepa](https://github.com/gepa-ai/gepa) | 利用执行轨迹与文字反馈反思、生成候选并选择；支持 DSPy 和自定义 evaluator | 适合任务/指标明确后的预算受控自动迭代。需要额外 Python 运行环境与模型调用接入 |
| [microsoft/PromptWizard](https://github.com/microsoft/PromptWizard) | 自动生成、批评和改进提示词及示例；支持无示例、合成示例、已有训练数据三种场景 | 适合离线实验。真实改进仍需独立验证；合成数据不能单独作为质量证明 |
| [Langfuse Playground](https://langfuse.com/docs/prompt-management/features/playground) | 提示词与模型参数编辑、并排执行、变量/工具、结果保存 | 适合参考试跑对比与版本管理交互；本阶段不建议为小插件引入整套平台 |

项目是否易于嵌入、当前接口和许可证需要在实际选型时按固定版本复核。prompt-optimizer 当前 README 标注 AGPL-3.0；本调研未复制其实现。

## 建议的产品流程

```text
一句话描述目标 / 导入现有材料
    → AI 补齐必要信息、起草提示词
    → 按反馈定向修改、生成差异
    → 提取可复用规则候选
    → 用样例对比当前版与候选版
    → 采用为草稿、保存版本、按需启用
```

这是一项 Prompt Lab 的拟议设计，不能把整条流程记为以上任一开源项目都已完整提供。

### 提示词与规则：从空白编辑器变成创作入口

- 默认提供“描述需求生成”“从已有内容整理”“优化当前草稿”。人工编辑仍保留。
- 用户只需描述用途、关键约束；AI 可提出少量必要问题。缺失信息标成待补充，避免编造业务约束。
- 生成结构化候选：配置名称、正文、当前配置附加规则、可复用规则建议、修改理由与待确认项。
- 支持“更简洁”“补输出格式”“按反馈修改”等定向指令，不把所有优化都变成扩写。
- 对比原稿/候选稿；可整体采用或只接受部分变化。采用先进入草稿，不直接覆盖正在启用的版本。

### 规则库：从手工录入变成候选沉淀

- 从用户选择的提示词、项目说明、反馈片段提取规则；后续再接入选定会话的明确数据接口。
- 不把一次性任务要求直接提升为长期规则。候选需要说明适用范围、来源与理由。
- 支持去重、冲突提示、合并已有规则，按候选批量勾选采用。
- 对重复或无效规则支持停用/替换；预算与适用范围比无上限累积更重要。
- 共享规则变更会影响多个配置，应显示引用范围，并保留可回退版本。

### 验证：证明效果，不只证明文字更漂亮

- AI 可以辅助起草测试样例，用户从真实任务或失败案例中选择、补充。
- 固定相同测试输入和目标模型，对比当前版/候选版；记录模型及必要参数。
- 输出格式、必含字段等使用确定性检查；事实性、覆盖度等用明确评分标准，并展示判断理由。
- 保留不参与优化的验证样例；模型自评或同一模型自生成题目不能单独证明提升。
- 代码 Agent 的真实效果要看文件修改、构建/测试等任务结果，普通文本试跑只能证明部分能力。
- 记录调用数量、Token/成本、超时和失败；后台失败不能显示为通过。

## 建议分步交付

1. **第一步：AI 创作与规则提取。** 接入一个可靠模型调用通道；完成生成/改写/提取 → 差异预览 → 采用草稿。提供取消、超时、失败保留原稿。不先要求用户手写大批规则。
2. **第二步：试跑与版本。** 样例管理、当前版/候选版并排结果、基础评分、版本回退。可先导出 Promptfoo 测试配置，验证集成后再考虑内嵌运行。
3. **第三步：反馈驱动优化。** 在有可用样例与任务评估器后，再加入 ACE 风格规则更新或 GEPA 优化；设置轮次与调用预算上限，保留所有候选和验证结果。

## 本地接入检查

- 目前 `lib/ui.js` 只负责本地数据接口，`lib/index.js` 使用 SystemPrompt 贡献和观察钩子，没有模型生成接口。
- 模型层优先验证能否复用 DSH 已配置服务；不能在未核对宿主契约前承诺无需额外配置。备用方案是独立的兼容 API 接入。
- 生成接口与保存/启用动作分开。模型结果必须通过结构、长度和引用校验；外部内容不能直接触发启用。
- 原数据 `schemaVersion:2` 可以继续保存已采用资产；来源、候选、评测与历史需要单独设计存储和导出兼容策略。
- 已有进程组装快照不是会话聊天记录，不能用来冒充“从当前会话学习”。

## 主要资料

- [Prompt Optimizer 中文 README](https://github.com/linshenkx/prompt-optimizer/blob/develop/README.zh-CN.md)
- [ACE 方法与实现](https://github.com/ace-agent/ace#readme)
- [ACE 工程实现与 TraceAnalyser](https://github.com/kayba-ai/agentic-context-engine#readme)
- [Promptfoo 配置](https://www.promptfoo.dev/docs/configuration/guide/)、[断言与指标](https://www.promptfoo.dev/docs/configuration/expected-outputs/)
- [GEPA 接口与工作方式](https://github.com/gepa-ai/gepa#readme)
- [PromptWizard 场景和数据集要求](https://github.com/microsoft/PromptWizard#readme)
- [Langfuse Playground](https://langfuse.com/docs/prompt-management/features/playground)

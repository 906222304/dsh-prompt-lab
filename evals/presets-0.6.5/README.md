# 0.6.5 提示词效果验收材料

这些是 2026-11-08 的合成实验记录，不包含供应商凭据、原生模型推理块或用户真实会话。未打包进入插件运行时。

- protocol.json：固定的四例文本输入、参考、rubric、候选工程规则、路由与预算；nativeTask 是实际 Agent 任务。
- text-results.json：可见输出、确定性检查、评分、截断与服务层 usage。result 不完整，不能据汇总分数选胜者。
- agent-results.json：两个真实 Agent 的可见最终回答、工具调用、原生结束原因、独立检查和资源开销。
- agent-A/B-before-tests.txt 与 after-tests.txt：运行前失败、结束后评估方重跑通过。
- agent-A/B-diff.patch：两个 Agent 各自生成的最终补丁，内容相同。
- fixture/：原始、尚未修复的合成仓库文件。复制到两个独立目录后，先执行 python -m unittest -v，应复现 2 failures + 1 error。把原文及原文加 protocol.json.engineeringRules 分别用于两份独立 DSH 会话，按 nativeTask 执行。结束后重跑 unittest，并检查只有 pricing.py 被修改。verify_boundaries.py 是评估方的追加检查，放在 fixture 外；在 Agent 完成后再运行，不在执行前提供给 Agent。

真实任务采用官方 headless 组合与原生 Agent/工具，另加独立 driver 控制 8 次派发、每次 2048 输出、300 秒上限。driver 使用机器相关安装路径，不作为公共运行器发布；不能把未经限额的普通 headless 命令当作相同预算的复现。模型、温度默认值、缓存、随机性与供应商版本都可能影响复测。

也可在原始 fixture 副本中检查 patch，但手工应用补丁通过测试不等于重新执行 Agent 实验。

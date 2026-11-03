# W2 数值指标参考模板

读取结构化指标快照，执行阈值、连续独立采样和恢复阈值规则。

## 配置与检查节奏

设置来源绝对路径，并编辑 CONFIG.metric、unit、threshold；direction 为 above 或 below，clearThreshold 可设置恢复阈值。

由 Harness 按任务选择的 cadenceSeconds 调用，当前登记入口至少为 60 秒。探针单次执行后返回，不自行启动后台循环；脚本检查频率与模型处理条件分开。

## 事件与状态

首次建立基线；新的采样时间连续命中后报告一次，恢复后可重新触发。重复或乱序样本不增加计数。

state 保存于 watcher/state.json，由 Runtime 写入。规则配置改变后重新建立基线。来源异常必须报错，不能伪装成无变化；失败不会提交新的状态。只返回有界的证据和读取引用。

## 唤醒后的处理

核实指标单位、采样时间、变化原因和当前工作。阈值命中本身不能证明训练质量或任务完成。

分析结果首行使用 classification: no_change、classification: relevant_change 或 classification: uncertain，再给出理由、证据和建议。是否报告 Main 取决于长期目标；通知用户是后续决定。探针不会直接调用模型、Main 或产生业务副作用。

## 验证命令

在包目录执行：

```sh
node --test tests/rule.test.mjs
```

结构校验命令：

```sh
node /absolute/path/to/.pi/skills/virtual-agent-authoring/scripts/validate_package.mjs /absolute/path/to/package
```

测试使用临时文件、可控时钟或注入的 HTTP 响应，不接入线上来源，不调用外部模型。Job 模板的进程测试使用真实本地子进程。

## 适用边界

输入必须为 {metric, unit, value, observedAt}，value 为有限数值，observedAt 为 ISO 时间。NaN、缺失或过期样本作为观测错误；自动解析训练日志和复杂趋势尚未覆盖。

这是需要配置和审阅的模板包。复制文件或通过测试不会登记监控器。现有 activate_virtual_agent 只复制 rule.mjs 和 AGENT.md，因此配置必须写入 rule.mjs，来源列表同步写入 manifest.json；其他采集依赖需留在规则内或由来源提供。

Supervisor 的事件分析加载本 AGENT.md（最多 16 KiB）与登记时提供的 task。模板文件本身不会启用实例；需要 create_watcher 或 activate_virtual_agent 成功。Session 内外、直接唤醒与预算边界见 [本轮报告](../../../../../docs/watcher-runtime-report-2026-10-12.md)。

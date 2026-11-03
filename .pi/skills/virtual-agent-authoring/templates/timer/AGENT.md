# 共用时间触发参考模板

按绝对时间触发一次，或按固定间隔触发；每次调用检查时钟，不持有 sleep 循环。

## 配置与检查节奏

替换 CONFIG.startAt 为未来 ISO 时间；intervalMs 为 null 时仅一次，否则至少 60000；endAt 是可选的排他截止时间。

由 Harness 按任务选择的 cadenceSeconds 调用，当前登记入口至少为 60 秒。探针单次执行后返回，不自行启动后台循环；脚本检查频率与模型处理条件分开。

## 事件与状态

首次建立基线；到期输出 timer.due。周期任务恢复后只交接最近到期的一次，并报告跳过的间隔数；一次性任务只触发一次。

state 保存于 watcher/state.json，由 Runtime 写入。规则配置改变后重新建立基线。来源异常必须报错，不能伪装成无变化；失败不会提交新的状态。只返回有界的证据和读取引用。

## 唤醒后的处理

根据原目标执行约定处理。scheduledAt 与 observedAt 区分计划时间和实际检查时间；漏过的周期需由模型判断是否补做。

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

定时器精度受 Harness 检查间隔限制；日历时区、DST、暂停控制和直接唤醒 Main 属于下一阶段。通过 create_watcher 创建时默认直接唤醒 Main，不运行监控分析模型；一次性或已到截止时间的实例在 pending 事件投递处理完成后结束。

这是需要配置和审阅的模板包。复制文件或通过测试不会登记监控器。现有 activate_virtual_agent 只复制 rule.mjs 和 AGENT.md，因此配置必须写入 rule.mjs，来源列表同步写入 manifest.json；其他采集依赖需留在规则内或由来源提供。

Supervisor 的事件分析加载本 AGENT.md（最多 16 KiB）与登记时提供的 task。模板文件本身不会启用实例；需要 create_watcher 或 activate_virtual_agent 成功。Session 内外、直接唤醒与预算边界见 [本轮报告](../../../../../docs/watcher-runtime-report-2026-10-12.md)。

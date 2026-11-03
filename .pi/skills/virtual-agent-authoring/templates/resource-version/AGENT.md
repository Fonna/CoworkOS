# W3 资源版本参考模板

对一个本地常规文件计算指纹，连续稳定检查后报告生成、变更或删除。

## 配置与检查节奏

设置来源绝对路径；CONFIG.stableChecks 设置连续稳定次数，maxBytes 设置可接受文件大小。

由 Harness 按任务选择的 cadenceSeconds 调用，当前登记入口至少为 60 秒。探针单次执行后返回，不自行启动后台循环；脚本检查频率与模型处理条件分开。

## 事件与状态

首次观察建立基线；新的指纹连续稳定后报告。相同字节内容不重复报告，删除后重建是新事件。

state 保存于 watcher/state.json，由 Runtime 写入。规则配置改变后重新建立基线。来源异常必须报错，不能伪装成无变化；失败不会提交新的状态。只返回有界的证据和读取引用。

## 唤醒后的处理

核实产物能否读取及内容是否满足任务要求。指纹稳定仅说明多次观察一致，不能保证生产者已经完成写入。

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

首批支持单个有限大小的常规文件。超大模型权重、目录、网页选区、生产者完成标记需单独采集适配；本模板不读取无限日志。

这是需要配置和审阅的模板包。复制文件或通过测试不会登记监控器。现有 activate_virtual_agent 只复制 rule.mjs 和 AGENT.md，因此配置必须写入 rule.mjs，来源列表同步写入 manifest.json；其他采集依赖需留在规则内或由来源提供。

Supervisor 的事件分析加载本 AGENT.md（最多 16 KiB）与登记时提供的 task。模板文件本身不会启用实例；需要 create_watcher 或 activate_virtual_agent 成功。Session 内外、直接唤醒与预算边界见 [本轮报告](../../../../../docs/watcher-runtime-report-2026-10-12.md)。

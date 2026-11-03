# Watcher 模板复核：2026-10-11 历史范围

本记录描述 [初始模板验证](watcher-template-verification.md) 后的信息源候选保存复核，不是当前合并版本的验收结论。原阶段未执行完整 Dashboard、模型、浏览器或桌面验证。

## 当时识别并处理的边界

信息源读取游标与候选交接分开：候选在确认交接前保存必要内容，来源后续移除、暂时不可用或规则修改不应静默删除已捕获证据。队列超过预算时应明确失败并保留原状态。候选观察时间与交接时间分开记录。

这解决了模板内部“已观察候选继续依赖来源窗口”的问题，单独不能证明探针状态到 Main Inbox 的崩溃一致性。原报告当时列出的 Runtime 后续工作不能再作为现行缺口：当前采用原子 state/outbox checkpoint、持久 Inbox 和显式确认，详见 [架构](architecture.md#长期目标监控与暂停)。

## 当前维护入口

修改参考包时核对 [模板契约](../.pi/skills/virtual-agent-authoring/templates/README.md)、[任务分类](watcher-task-taxonomy.md)、包内测试和 [模板回归](../test/watcher-templates.test.js)。状态/outbox、采样与慢分析隔离、暂停恢复分别见 [可靠性](../test/watch-reliability.test.js)、[采样活性](../test/watch-sampling-liveness.test.js) 与 [暂停回归](../test/monitoring-pause.test.js)。

规则修改后重新生成相应版本证据；本次文档合并未运行这些测试，也不沿用旧统计为当前通过。

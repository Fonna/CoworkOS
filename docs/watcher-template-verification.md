# Watcher 参考模板验证：历史范围

本记录对应 2026-10-10、仓库基线 `7242cfe` 上的模板变更，各包原版本为 `0.1.0`。它不是当前合并版本的验收结论；原始执行细节保留于该变更历史。现行模板以 [参考包](../.pi/skills/virtual-agent-authoring/templates/README.md) 与各包 manifest/测试为准。

原阶段覆盖六类模板的受控输入：job-lifecycle、metric-threshold、resource-version、feed-keyword、entity-state、timer。验证范围包括包结构、仓库外搬移、重复事件、跨进程观察状态以及训练/信息源组合；当时不覆盖后台目标创建、模型分析、线上来源或完整产品安装。

后续信息源候选保存问题见 [2026-10-11 复核](watcher-template-review-2026-10-11.md)。不能把当时的规则指纹或用例数量沿用到修改后的包。

## 当前复现入口

```sh
npm run test:watcher-templates
node --test .pi/skills/virtual-agent-authoring/templates/*/tests/rule.test.mjs
```

命令对应 [模板回归](../test/watcher-templates.test.js) 与包内行为测试；本次文档合并没有运行它们。来源采样、Inbox、暂停、模型和浏览器仍需各自验证，范围见 [本地测试](testing-local-run.md)、[运行时参考](runtime-reference.md#长期目标接口与调度) 和 [暂停契约](monitoring-pause-contract.md)。

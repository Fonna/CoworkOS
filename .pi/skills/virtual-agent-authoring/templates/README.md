# Watcher 参考模板

当前包版本为 0.2.0；10 月 10 日的 0.1.0 与 10 月 11 日的信息源 0.1.1 记录保留为历史证据。

这六个模板提供低成本观察规则和可重复的行为用例。选择模板、复制完整包、配置来源与规则、运行测试，再由 Main 审阅和登记。模板库中的文件不会自动成为监控任务。

分类定义见 [Watcher 任务分类与模板范围](../../../../docs/watcher-task-taxonomy.md)。

## 选择模板

| 类别         | 模板                                          | 首批支持的来源                                       | 产生事件的条件                         |
| ------------ | --------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| W1 程序运行  | [job-lifecycle](job-lifecycle/AGENT.md)       | CoworkOS start_job 的本地 JSON 记录和日志元数据      | 运行结束、未知退出、首次超过安静阈值   |
| W2 数值指标  | [metric-threshold](metric-threshold/AGENT.md) | 一个本地结构化指标快照                               | 连续独立采样命中阈值，恢复后可重新触发 |
| W3 资源版本  | [resource-version](resource-version/AGENT.md) | 一个有大小上限的本地常规文件                         | 内容连续稳定后生成、更新或删除         |
| W4 新增信息  | [feed-keyword](feed-keyword/AGENT.md)         | JSON 条目列表、GitHub 发布 API/Atom、Hacker News API | 新条目或更新内容命中关键词             |
| W5 实体状态  | [entity-state](entity-state/AGENT.md)         | 带递增 revision 的 JSON 实体快照                     | 进入指定目标状态                       |
| 共用时间触发 | [timer](timer/AGENT.md)                       | 本地时钟                                             | 绝对时间到达或固定间隔到期             |

运行入口均为自包含的 `watcher/rule.mjs`，只依赖 Node 内置模块和现有 ScriptWatcher 上下文。每个包自带 manifest、处理说明和可搬移的测试。`createWatcher` 导出供配置测试使用；默认导出才是 Runtime 的实际入口。

## 配置与使用

1. 按预期交接的事实选择模板，复制完整目录到任务的作者工作目录。
2. 把 `manifest.sources` 中的占位来源改为真实来源。当前规则读取第一项，首批模板每个实例观察一个来源。
3. 编辑 `watcher/rule.mjs` 的 `CONFIG`。模型可以修改来源适配和规则，但修改后需重跑测试。
4. 按 `AGENT.md` 配置处理说明、检查频率和结束条件。登记时把监控目标写进 `task`；Supervisor 会加载已验收的 handler，最多 16 KiB。
5. 在包目录运行 `node --test tests/rule.test.mjs`，再运行作者 skill 的 `scripts/validate_package.mjs`。
6. 检查真实来源的输入格式、可访问性和首次基线，然后使用既有显式登记入口。

当前登记只复制 `rule.mjs` 和 `AGENT.md`；配置不能依赖未被复制的相邻文件。测试用的 `now` 参数允许注入时钟，实际运行默认使用 `Date.now`。

首次探针建立基线，不报告现有积压。程序若已经超过安静阈值，会在下一次检查报告；一次性定时器在首次配置时必须尚未到期。修改配置会重新建立基线；信息源模板在 pending 尚未清空时拒绝配置变更，避免丢弃已发现的候选。

## 标准输入示例

Job 模板读取既有 [JobRecord](../../../../src/tools/jobs.ts)，不需要生成新的运行记录格式。

数值模板的单个快照：

```json
{
  "metric": "loss",
  "unit": "ratio",
  "value": 1.25,
  "observedAt": "2026-10-10T00:00:00Z"
}
```

信息源模板的列表：

```json
{
  "items": [
    {
      "id": "announcement-1",
      "title": "CoworkOS release",
      "summary": "New release details",
      "url": "https://example.test/announcement-1",
      "publishedAt": "2026-10-10T00:00:00Z"
    }
  ]
}
```

实体模板的快照：

```json
{
  "id": "order-1",
  "revision": 2,
  "status": "filled",
  "observedAt": "2026-10-10T00:00:00Z"
}
```

真实来源可能需要适配成这些格式。采集适配、规则匹配和模型处理分别验证；不能因为规则测试通过就推断某个外部服务已接通。

## 成本与可靠性边界

- 探针没有模型调用，不负责通知、重启程序或下单等业务动作；它只产生候选证据。
- 本地读取有大小上限；事件只携带有限证据和读取引用。HTTP 模板检查状态码、响应结构和文本大小，底层 `context.fetchUrl` 仍会先读取响应正文，因此这里不承诺传输层的硬内存上限。
- 数值计数只接受新的采样时间；阈值可用独立恢复条件降低抖动。资源稳定检查只能证明多次观察一致，不能替代生产者完成标记。
- 信息源模板把已发现候选保存到 pending，每轮交接有限条目。交接积压前不重新查询来源，已发现证据不会依赖来源继续保留条目；新输入的候选队列超过 512 KiB 则报错且不推进游标。去重仅保证保存窗口内的条目，历史淘汰后重新出现可能再次报告。
- 网络或输入异常抛出错误，保持上次状态；Source 故障的退避和统一健康事件属于后续 Runtime 工作。
- 事件序号区分恢复后重复发生的同类变化。状态遵循当前 Runtime 的保存方式；事件入队和游标保存的崩溃一致性、并发互斥与业务副作用幂等仍需在功能阶段验证。
- 时间探针不持有长 sleep。实际唤醒精度取决于检查 cadence；停机后周期触发只报告最近时点及跳过次数，是否补做由处理 Agent 判断。

## 验证入口

在仓库根目录执行：

```sh
npm run test:watcher-templates
```

这个入口将六个包复制到仓库外，分别执行结构校验和包内测试；再用真实 ScriptWatcher 在不同子进程中读取同一持久状态，并验证训练与后台信息源两条组合观察路径。无需安装产品依赖，不访问外部模型或线上信息源。

初始版本验证范围见 [Watcher 模板验证记录](../../../../docs/watcher-template-verification.md)，信息源 `0.1.1` 的候选保存修正见 [模板复核记录](../../../../docs/watcher-template-review-2026-10-11.md)。本轮 Session 内外、预算与管理界面的实现和边界见 [全链路报告](../../../../docs/watcher-runtime-report-2026-10-12.md)。模型可用 `create_watcher` 配置这些模板；默认定时、指标、程序运行和文件版本事件直接交给 Main，新内容和对象状态先做有限分析。模型和用户也能调整固定检查频率；自动冷热切换仍待实现。

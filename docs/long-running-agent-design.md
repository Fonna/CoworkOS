# Cowork 长程任务与 Virtual Agent 设计

> 文档归类：历史专项设计，以下模型、阶段差距与实现顺序保留设计背景，不作为现行缺口清单。长期目标、模板登记、应用内动态、Dashboard Main 恢复与显式 macOS 服务已有实现，当前交付范围以 [ROADMAP](../ROADMAP.md)、[目标架构](long-term-goals-architecture.md)、[运行时参考](runtime-reference.md#长期目标接口与调度) 和 [暂停契约](monitoring-pause-contract.md) 为准；设计时序不证明生产验收。

## 1. 设计目标

Cowork 的差异化不应该只是“Main 可以调用多个 Subagent”，而是让 Agent 能够在数小时、数天甚至更长时间内持续完成任务，并且在等待外部条件时不占用模型会话。

这里要区分两个闭环：

```text
长程执行：执行一段工作 → 保存状态 → 进程退出/上下文重启 → 从 checkpoint 继续

长期监测：Task 进入睡眠 → 外部事件到达 → 去重/过滤/策略判断 → 唤醒 Main → 继续决策
```

长程执行解决“不要丢进度”，长期监测解决“不要一直运行模型”。Virtual Agent 是这两个闭环的组合：它不是一个永远思考的模型，而是一个由事件源、持久状态和唤醒策略驱动的任务代理。

## 2. 设计原则

### 2.1 Model decides, Runtime remembers

Main 负责理解目标、拆分工作、选择工具、验收结果和决定下一步；Runtime 负责可靠保存、恢复、调度、租约、事件、预算和唤醒。

Main 不需要维护复杂的 `plan.json`，也不应该每轮重写一份完整状态。Main 只维护一份简洁的语义记忆 `agents/main/context/memory.md`；Runtime 自动生成可靠的内部投影。

### 2.2 Event is a fact, Wake is a decision

外部事件到达不等于立刻调用模型：

```text
Watcher observation
  → normalize
  → dedupe/debounce/cooldown
  → Event Log + Inbox
  → Wake Policy
  → Main continuation
```

这样可以记录低价值事件、合并重复事件，并避免 webhook 或日志抖动造成模型风暴。

### 2.3 Evidence is immutable, projection is rebuildable

- Event Log、Inbox、Checkpoint、Artifact Manifest 是事实和证据；
- Task/Run/Step projection 是可重建的索引；
- `memory.md` 是 Main 的语义工作笔记，不是审计日志；
- 任何 projection 损坏，都应该可以从事件和 checkpoint 重建，而不是依赖模型重新回忆。

## 3. 核心对象

### 3.1 Task

Task 是跨 Run 的长期目标，至少包含：

```json
{
  "taskId": "task-1",
  "goal": "持续监控服务并在异常时修复",
  "constraints": ["不修改生产配置"],
  "successCriteria": ["测试通过", "异常有证据"],
  "budget": { "maxModelTokens": 1000000, "maxCost": 20 },
  "deadline": "2026-09-30T00:00:00Z",
  "wakePolicy": "on_relevant_event"
}
```

### 3.2 Runtime Task Projection

这是 Runtime 自动维护的内部状态，不作为 Main 必须调用的工具：

```json
{
  "phase": "executing|waiting_subagents|waiting_external|sleeping|waking|verifying",
  "currentRunId": "main-run-1",
  "lastCheckpoint": "checkpoint-42",
  "lastEventCursor": "event-100",
  "nextAction": "inspect external event and decide whether to patch",
  "openObligations": ["等待测试结果"],
  "requiredCalls": ["call-7"],
  "wakeAt": null,
  "revision": 17,
  "updatedAt": "..."
}
```

它解决的是恢复问题，不是替代 Main 的推理。`nextAction` 可以由 Main 在 checkpoint 时提供建议，但 Runtime 必须允许它过期并要求 Main 验证。

### 3.3 Run / Step / Call

- **Run**：一次 Main session 或一次恢复后的执行代际；
- **Step**：Runtime 可领取、checkpoint、重试和取消的最小工作单元；不一定暴露给 Main；
- **Call**：Main→Coordinator 或 Coordinator→Subagent 的一次调用，带 mode、deadline、依赖、租约和 callback。

长程任务不要求模型显式创建 Step，但每次 Main 决策、Subagent 调用、外部等待和唤醒都应该在 Runtime 内部形成可恢复的 step/checkpoint 边界。

### 3.4 Watcher / External Event / Wake

Watcher 是事件源，不是模型：

```json
{
  "watcherId": "service-log-prod",
  "source": "file|timer|webhook|queue|custom",
  "eventTypes": ["error", "health_degraded"],
  "filter": {},
  "debounceMs": 30000,
  "cooldownMs": 300000,
  "wakePolicy": "record_only|wake_if_sleeping|wake_always",
  "priority": 80,
  "version": 1
}
```

统一事件：

```json
{
  "eventId": "watcher-event-abc",
  "watcherId": "service-log-prod",
  "source": "filesystem",
  "type": "file.changed",
  "dedupeKey": "service.log:sha256",
  "occurredAt": "...",
  "payload": {}
}
```

`watcherId + dedupeKey` 保证幂等；`debounce` 合并短时间重复事件；`cooldown` 限制一个 watcher 在时间窗口内的唤醒次数。

## 4. Task 生命周期

当前已有的 `created/running/waiting/completed/failed/cancelled` 仍然保留；长程版本需要在 Runtime projection 中细分阶段：

```text
created
  → active
  → waiting_subagents
  → verifying
  → sleeping
  → waking
  → active
  → completed

active → blocked / failed / cancelled
sleeping → expired / cancelled
```

对外 API 可以继续返回简单 Task status；详细的 `phase`、wake reason 和 open obligations 放在 Task detail/progress API 中，避免 UI 只能看到一个笼统的 `waiting`。

## 5. 一次长程任务的完整流程

### 5.1 启动

1. 创建 Task，保存 goal、约束、成功标准、预算和 watcher 配置；
2. 创建 Main Run、Task projection 和 checkpoint；
3. Main 读取 memory、projection、Inbox、最近事件和 Artifact 摘要；
4. Main 选择独做、并行委派、同步等待或进入等待。

### 5.2 执行

每一个决策边界都执行：

```text
读取上下文
  → 模型决策/工具调用
  → Runtime 执行并写 Event
  → 保存 transcript checkpoint
  → 更新 projection
  → 检查预算、deadline、未完成依赖
```

Subagent 的结果先进入 Coordinator/InBox；Main 只有在下一次决策或明确 wait 时消费它。迟到、重复和部分失败结果不能破坏已经完成的工作。

### 5.3 进入睡眠

当满足以下条件时，Main 可以结束当前 Run：

- 没有必须立即等待的 Subagent；
- 没有需要当前上下文继续执行的工具调用；
- 当前阶段只需要外部事件或未来时间；
- memory 和 Runtime projection 已保存下一步；
- Task 仍有未完成目标或 watcher。

Runtime 将 Task 标记为 `sleeping`/`waiting_external`，释放模型进程，但保留 workspace、checkpoint、Inbox 和 watcher lease。

### 5.4 事件唤醒

1. Watcher 产生 observation；
2. Runtime 校验来源、版本、权限和 payload 大小；
3. 计算 dedupe key，执行 debounce/cooldown；
4. 写入 Event Log 和 Main Inbox；
5. Wake Policy 判断 `record_only`、`wake_if_sleeping` 或 `wake_always`；
6. Supervisor 为 Task 获取 wake lease，防止重复唤醒；
7. 从最近 checkpoint 恢复 Main，并注入“有新的外部事件，请先验证再行动”的提示；
8. Main 读取 Inbox，判断事件是否相关、是否需要委派、是否需要人工确认；
9. Main 更新 memory、projection 和下一次等待条件。

事件本身永远不应该直接变成模型命令。模型必须重新验证事件和当前 workspace。

## 6. Supervisor 与恢复

Dashboard/Electron 不能是长程任务的唯一宿主。需要一个独立 Supervisor/Worker：

```text
Supervisor
├── watcher leases
├── wake leases
├── Task projection rebuild
├── Main resume queue
├── health/heartbeat
└── notification/escalation
```

关键保证：

- Supervisor 可以重启；
- 同一个 Task 同时只能有一个 Main wake lease；
- Main 进程崩溃后，checkpoint 可以恢复；
- watcher 进程崩溃后不会丢失已写入的 event；
- 外部副作用必须带 action/idempotency key；
- 任务在睡眠期间不消耗模型调用；
- `completed` 只能由验收通过或明确人工完成产生，不能由进程退出自动推断。

## 7. Context Builder 与 Memory

每次恢复的上下文按优先级构造：

1. 当前用户指令或 wake reason；
2. 未消费的 Main Inbox；
3. Runtime projection：phase、open obligations、next action、deadline；
4. `memory.md`；
5. 最近 checkpoint 的消息尾部；
6. 相关 Artifact 摘要和证据；
7. 必要时再读取完整 message log。

`memory.md` 推荐保持简单：

```markdown
# Goal

# Completed

# Next

# Important constraints / evidence
```

模型不需要每轮更新它；但在阶段完成、进入睡眠、准备 clear context、接受外部事件并做出决策前，应该更新一次。Runtime 不能假设模型一定写了 memory，因此 projection 和 checkpoint 仍是恢复依据。

## 8. 当前实现与差距

已经实现：

- Task workspace、Event Log、Checkpoint、Inbox、Artifact；
- Main/Subagent 的 sync/async 调用和恢复 Worker；
- `WatcherEvent`、dedupeKey 幂等、Event Log + Main Inbox；
- 文件轮询 Watcher/Loop；
- Dashboard 外部事件 API；
- `wake: true` 时在 Dashboard 进程仍存活的情况下尝试恢复 Main。
- Watch Program/Virtual Agent 控制平面、Crossref research watcher 和可重启的 `WatchSupervisor`；Supervisor 可以按 cadence 轮询、领取/释放 Virtual Agent Inbox、启动短 Subagent Run，并将重要结论幂等写入 Main Inbox。

仍缺少：

1. Runtime 自动维护的 Task projection 和可重建 index；
2. Supervisor 已有单次 cycle/CLI loop，仍缺少生产化的独立进程部署、Task lease 和真正启动 Main continuation 的 wake Worker；
3. timer、Webhook、日志流等更多事件源；
4. debounce、cooldown、过滤、优先级和 watcher 配置持久化；
5. Main 的统一 Context Builder；
6. 整体 deadline、预算、backpressure 和健康检查；
7. 真实的“睡眠 → 事件 → 唤醒 → resume”集成测试；
8. wake 后的人工确认、通知和升级路径。

## 9. 实现顺序

### L0：可靠状态投影

- 增加 `task_projection.json`，由 Task/Run/Event/Inbox 更新；
- 在 checkpoint、Task transition、callback、watcher event 时原子更新；
- 支持从 Event Log 重建 projection；
- 暴露 `/api/tasks/:id/progress`。

### L1：独立 Supervisor（控制循环已完成，生产化仍待补齐）

- `WatchSupervisor` 已从 Dashboard 控制面抽出，维护 monitor cadence、Inbox lease/release 和 Virtual Agent run；
- 下一步从 Dashboard 中移出 Main spawn/resume，并增加 Task lease、wake lease 和 heartbeat；
- Dashboard/Electron 只提交命令和订阅 SSE；
- 杀掉 Dashboard 后，Task 仍可被 Worker 恢复。

### L2：事件策略

- 持久化 watcher 配置；
- 加入 timer、Webhook、日志/文件三类事件源；
- 实现过滤、去抖、冷却、优先级和版本；
- 增加通知和人工确认。

### L3：Context Builder 与预算

- 统一恢复上下文；
- 记录 token、延迟、wake 次数和成本；
- 支持 deadline、总预算和 backpressure；
- 防止长期任务因事件抖动无限消耗模型。

### L4：长程评测

- 设计 24 小时以上的 synthetic monitor tasks；
- 测试进程杀死、重复事件、网络中断、迟到 callback、版本升级和人工确认；
- 评价完成率、误唤醒率、漏唤醒率、恢复时间、token 成本和副作用幂等性。

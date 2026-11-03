<a id="cowork-watch-program从用户兴趣到自维护-virtual-agent"></a>

# Watch Program 设计

本文说明 Watch Program 的设计，包括已实现的监控机制和待实现的事件源、策略。开发排期见 [ROADMAP](../ROADMAP.md)，作者激活范围见 [运行时参考](runtime-reference.md#长期目标接口与调度)。

作者 skill、文件包校验和登记已实现，版本化 handler 升级和回滚仍待实现。`call_subagent(task, mode)` 只委派一次执行，不创建持久程序，也不按任务关键词路由；具体边界见 [运行时参考](runtime-reference.md#长期目标接口与调度)。

## 1. 目标场景

用户表达长期兴趣，Cowork 负责确定监控对象及 cron、RSS、Webhook 或搜索关键词等配置：

> “我最近在关注这家公司，希望持续了解它的重要变化。”

Cowork 应该自动完成：

```text
用户兴趣
  → Main 理解长期目标
  → 并行研究公司与信息来源
  → 形成 baseline 和监控假设
  → 设计并注册 Virtual Agents
  → 进入低成本睡眠监测
  → 事件命中后收集证据、判断变化、通知用户
  → 更新长期状态和监控策略
```

Watch Program 围绕一个长期目标组织持续监控。

## 2. 三个概念必须分开

### Watch Program

面向用户的长期关注目标，例如“持续关注某公司”。它保存目标、对象、baseline、监控器集合、通知偏好和长期状态。

### Watcher

Watcher 按确定性规则采集来源：定时调用公开 API、读取 RSS/公告、查询搜索或网页变化、监听文件/日志/Webhook。复杂判断交给 Virtual Agent，Watcher 输出标准化 `ExternalEvent`。

### Virtual Agent

Virtual Agent 在事件触发后执行一次轻量 Agent Run。它判断相关性、交叉验证、比较 baseline，评估重要性和置信度，再生成摘要与证据、更新 Watch Program，并决定是否通知用户或调整监控器。它拥有独立的持久工作目录，setup/maintenance run 可在其中创建或修订 `watcher/rule.mjs`。

```text
watcher/rule.mjs = Virtual Agent 编写的低成本观察规则
Virtual Agent run = 解释、验证、修改规则和判断
Main Agent = 长期目标、策略、验收和最终责任
```

日常采样由 Watcher 执行，发现候选变化时才启动 Agent。

## 3. Watch Program 数据模型

### 3.1 稳定的机器状态

```json
{
  "programId": "watch-company-1",
  "taskId": "task-1",
  "status": "discovering|monitoring|paused|review_required|completed",
  "subject": {
    "name": "Example Corp",
    "canonicalIds": ["ticker:EXM", "sec:..."],
    "aliases": ["Example", "Example Corporation"],
    "identityConfidence": 0.97
  },
  "objective": "持续了解公司的重大业务、财务和组织变化",
  "successCriteria": ["重要变化可发现", "每条通知有证据", "低价值噪声不打扰用户"],
  "baselineArtifactId": "artifact-baseline-v1",
  "monitorIds": ["monitor-earnings", "monitor-news"],
  "notificationPolicy": "important_only",
  "revision": 3,
  "updatedAt": "..."
}
```

### 3.2 Main 可读的语义记忆

Main 的 Prompt 保留简洁的长期记忆，完整机器状态由 Runtime 维护：

```markdown
# Long-term interest

持续关注 Example Corp 的业务、财务和重大组织变化。

# Current understanding

- 公司主体已确认，主要公开信息源是 ...
- 当前最值得跟踪的风险是 ...

# Active monitors

- 财报/公告：季度
- 重大新闻：每天

# Recent important changes

- 2026-09-06：...

# Next review

检查监控噪声和来源质量，必要时调整频率。
```

Runtime 自动维护 `watch-program.json`、monitor state、cursor、last checked 和失败计数；Main 只在研究完成、重大事件处理、策略变化或阶段切换时更新语义记忆。

## 4. 从研究到监控的流程

### Phase A：理解意图和实体

Main 先判断用户关注的是公司、人物、项目、技术还是主题；是一次性研究还是长期关注；“重要变化”的含义；通知频率；以及是否存在同名实体。实体不明确时，Main 先问澄清问题，不应注册错误监控。

### Phase B：并行研究

Main 可以派发多个 Subagent：

```text
Subagent A：确认公司身份、ticker、官方域名和关联主体
Subagent B：整理官方来源、财报、公告和新闻源
Subagent C：分析用户目标对应的重大变化类型
Subagent D：评估查询成本、频率、噪声和可观测性
```

每个 Subagent 返回自然语言结论、证据和来源，由 Main 综合生成 baseline。Subagent 不直接创建长期监控。

宽泛兴趣不能直接变成一个“监控一切”的 Virtual Agent。例如“关注美国 LLM 发布进度”至少应先区分官方发布、API/可用性、路线图/预告和独立交叉验证；Main 先并行做一次轻量来源侦察，再为有独立来源和判断标准的维度分别创建异步 Virtual Agent。只有“监控某个明确 URL/RSS”这类窄目标才适合直接创建一个实例。

### Phase C：形成 baseline

Baseline 是后续比较的事实基线：当前业务和产品线、经营指标、组织和关键人物、公开战略、风险与用户关心的变化，以及每个结论的来源、时间和置信度。Baseline 保存为不可变 Artifact，后续 Virtual Agent Run 引用版本而不是覆盖历史。

### Phase D：设计 Virtual Agents

Main 根据 baseline 拆分监控职责，为每个明确维度设计一个监控器：

```text
公司公告 Agent：官方公告、财报、监管披露
业务变化 Agent：产品、客户、合作、市场变化
组织变化 Agent：高管、招聘和组织信号
风险 Agent：诉讼、监管、重大负面事件
周期复盘 Agent：总结噪声、漏报和监控器质量
```

每个 Virtual Agent 都有明确的触发来源、判断目标、预算和交付物。

## 5. Virtual Agent 配置

```json
{
  "monitorId": "monitor-official-news",
  "programId": "watch-company-1",
  "purpose": "发现官方重大公告和财报变化",
  "sources": [{ "kind": "rss", "uri": "..." }],
  "schedule": { "kind": "interval", "seconds": 21600 },
  "trigger": {
    "eventTypes": ["new_document", "content_changed"],
    "importance": "high",
    "dedupeKey": "source_url+content_hash"
  },
  "handler": {
    "agentRole": "research-verifier",
    "mustCompareBaseline": true,
    "mustCiteEvidence": true,
    "deliverable": "natural_language_summary"
  },
  "policy": {
    "wake": "only_if_relevant",
    "cooldownSeconds": 3600,
    "maxRunsPerDay": 8,
    "maxTokensPerRun": 12000,
    "notify": "important_only"
  },
  "status": "active",
  "version": 1
}
```

Main 表达监控目标、频率和通知条件，例如“监控官方公告，每 6 小时检查，只在重大变化时通知我”。Coordinator/Runtime 补全底层字段、校验并落盘。

## 6. 一次事件处理流程

```text
Watcher 发现新公告
  → Event 标准化和 dedupe
  → 判断是否在 cooldown 内
  → 写入 Watch Program Inbox
  → Virtual Agent 领取事件
  → 读取 baseline、最近相关事件和来源原文
  → 交叉验证
  → 判断 no_change / relevant_change / uncertain
  → 记录证据和置信度
  → 需要时通知用户
  → 更新 program state 和 Main memory
  → 调整 monitor 或进入睡眠
```

事件分类：`no_change` 只记录；`relevant_change` 生成摘要、证据和影响分析；`uncertain` 安排额外验证；`source_failure` 进入 retry/health 状态而不是误报；`policy_change` 交给 Main 决定是否修改监控器。

## 7. Main 如何维护长期状态

Main 维护已有认知，只在必要时重新研究：

1. 新消息到达时读取已有 Watch Program；
2. 判断是否已有相关 baseline 和监控器；
3. 只有信息过期、身份变化或用户目标变化时才重新研究；
4. 处理 Virtual Agent 的摘要和证据；
5. 决定是否暂停噪声源或增加关注维度；
6. 在阶段结束或清理 context 前更新 memory；
7. 让 Runtime 保存完整事件和 checkpoint。

用户新增“关注它的招聘和 AI 产品”等要求时，Main 更新原 Watch Program，保留同一目标的已有状态。

## 8. 工具设计

Main 使用简单的委派入口，任务文本只描述工作：

```text
call_subagent(task, mode)
get_subagent_status()  # 一次性调用和已有持久实例的状态
browse_workspace(...)  # 按需读取证据
```

`sync` 等待结果，`async` 接收后续回调；两者都只执行一次。Main 可以自己编写 Virtual Agent，也可以普通委派“设计并验证一个观察规则及其事件处理说明”。这些文件是可验收的产物，文件出现或 Subagent 完成不会自动激活持久程序。

模型可按需加载 [virtual-agent-authoring](../.pi/skills/virtual-agent-authoring/SKILL.md) 编写和测试文件包；该 skill 提供文件约定及结构校验脚本。当前可通过 `create_watcher` 配置模板或 `activate_virtual_agent` 验收文件包；现有 Watch CLI 仍兼容，详见 [运行时参考](runtime-reference.md#长期目标接口与调度)。

### 8.1 规则和控制消息

现有 `watch create` / `watch add` CLI 可以登记持久实例；Agent 编写的规则需要放入实例工作目录。`call_subagent` 本身不创建实例或启动专用 setup。运行时的目录结构是：

```text
<task>/agents/subagents/<monitor-id>/
├── watcher/rule.mjs       # default/check(context)；由 Virtual Agent 维护
├── watcher/state.json     # 规则自己的游标和小状态
├── watcher/versions/      # 可选的版本备份位置
├── watcher/README.md
└── runs/                  # 该 monitor 的模型运行资料
```

规则只返回 `events` 和可选 `state`，Runtime 负责 cadence、超时、dedupe、Inbox、失败状态和唤醒 Main。Main 不需要学习额外的 watcher schema；需要调整时只调用 `send_subagent_message(callId=<monitorId>, message=...)`。控制消息在安全边界进入 Virtual Agent，成功后再次唤醒 Main，由 Main 验收规则修改。

规则拥有 `fetchUrl` 和可选 `searchWeb` 受控能力；禁止直接调用 Main。公共 URL 访问有超时并拒绝明显的 localhost/private-network 目标。规则缺失时当前 ScriptWatcher 不返回事件，执行失败由 Supervisor 记录；完整文件包登记流程还需在启用前验证入口，避免缺失规则被视为无变化。

当前原型在同一个 Node 进程中执行本地 `rule.mjs`，因此只应运行用户信任的 Task workspace；它不是安全沙箱。产品化时应把规则放到受限 worker/容器中，并继续保留网络白名单、CPU/内存/请求预算。

### 8.2 人工确认

Main 只有一个额外的人机协作工具 `askhuman(question, context?, options?)`。它把请求写入 `<task>/human/requests/`，将 Task 置为 `waiting` 并结束当前回合。UI 或 CLI 用 `human reply` 写回答并放入 Main Inbox；Main 恢复后可继续同一 Task。人工决策、异步 Subagent 和外部事件共用这条可恢复消息链。

## 9. Workspace 布局

```text
.tmp/<task-id>/
├── watch/
│   ├── program.json
│   ├── memory.md
│   ├── monitors/<monitor-id>.json
│   ├── monitor-state/<monitor-id>.json
│   ├── runs/<monitor-run-id>/
│   └── cursors/<watcher-id>.json
├── artifacts/
│   ├── baseline/<version>/...
│   └── monitor-reports/<run-id>/...
├── agents/main/context/
├── sessions/
└── runs/
```

持久 Virtual Agent 的规则实际位于 `<task>/agents/subagents/<monitor-id>/watcher/rule.mjs`，其小状态位于同目录的 `state.json`；人工请求位于 `<task>/human/requests/`。历史 baseline、监控报告和证据不可变；当前 monitor state 可以原子覆盖；所有变化仍写入 Event Log。

## 10. 评测指标

长期关注需要评估：实体识别正确率、baseline 完整性和引用质量、重要事件召回率、噪声/误唤醒率、重复事件去重率、事件到通知延迟、进程重启后的恢复成功率、每个有效事件的 token/cost，以及 Virtual Agent 是否会主动调整失效或过于嘈杂的监控器。

## 11. 当前差距与实现顺序

当前已有 Task、Run、Checkpoint、Inbox、Event Log、文件 Watcher 和手动唤醒原型。`WatchProgramStore` 将持久实例保存到 `watch/programs/<program-id>/`；`ScriptWatcher` 执行实例目录中的 `watcher/rule.mjs`，`WatchSupervisor` 负责轮询、去重、事件 Inbox 和后续 Agent 分析。现有 CLI 可创建和激活实例；`get_subagent_status` 同时返回一次性调用和持久实例状态，Main 可通过 `send_subagent_message` 发送控制消息。`npm start` 会启动 Supervisor，Main Inbox poller 接收重要事件；Main 离线时事件会保留。`call_subagent` 只委派一次执行。模型文件包登记与探针验收已接入，版本化 handler 升级/回滚仍是后续工作，见作者流程提案。

后续实现顺序：

1. 作者协议与验证：已提供按需加载的作者 skill、文件约定和结构校验脚本；行为测试由模型随具体观察规则一起编写并运行。
2. 研究到 baseline：Main 先并行研究实体和来源，写入 baseline Artifact，再验收 Virtual Agent 定义文件，通过待实现的显式登记入口启用该版本。
3. 事件处理 Run：Watcher 的标准事件进入 Program Inbox，由对应 Virtual Agent 领取、核验和写报告；低价值事件只记录，不唤醒 Main。
4. 聚合与唤醒：同一 Program 的多个 monitor 先做去重和 digest，只把 `wake=important` 的事件交给 Main；通过 `get_subagent_status` 查看一次性和持久实例的统一状态。
5. Supervisor 与恢复：`WatchSupervisor` 已能在单次 cycle/CLI loop 中扫描 Program、按 cadence 轮询、领取 Inbox、失败 release 和写入 Main wake message；`npm start` 已将它作为同一 workspace 的后台 Worker 拉起，并由 Main Inbox poller 接收唤醒。下一步是补充过期 lease、cursor 和通知升级。
6. 质量和成本评测：用“关注一家公司 24 小时/7 天”的 synthetic benchmark 测试重要事件召回、噪声/误唤醒、重复去重、重启恢复和每个有效事件成本。

先稳定持久化对象和事件边界，再添加联网 adapter 和调度。Main 负责创建 Program 和职责明确的 Virtual Agent、检查状态、处理重要回调；Runtime 负责 cursor、dedupe、重试和恢复。

## 12. Virtual Agent 应该是什么

Virtual Agent 是带持久生命周期和触发条件的 Subagent，不增加与 Main/Subagent 平行的模型角色，也不保持 Pi 会话持续运行：

```text
普通 Subagent：
  call → run → result → terminal

Virtual Subagent：
  register → dormant
           → event → run once → result/state update
           → dormant
```

它仍然使用同一套 Pi Agent Loop、工具、workspace、trace 和预算。区别只在 Runtime 保存了它的目标、触发器、cursor 和最近状态，并在下一次事件到来时创建新的执行代际。

这一设计复用现有委派机制：

1. Main 使用可迁移的“委派 + 设置触发条件”能力，无需依赖只在特定 prompt 中出现的 Virtual Agent 技能；
2. 每次事件都是一个短、可回放、可评测的 Subagent Run，不会让一个会话无限增长；
3. Virtual Agent 可以被暂停、恢复、替换模型或改成确定性处理器，不会破坏 Watch Program。

### 12.1 推荐创作方式

Main 通过普通委派产出可检查的定义文件，例如：

```json
{
  "task": "设计并测试一个公告观察器：每 6 小时检查指定官网，保存已处理记录；出现重大业务变化时收集证据并向 Main 汇报。交付规则、事件处理说明和测试结果。",
  "mode": "async"
}
```

调用只运行这次设计任务。Main 验收文件后，再通过待实现的登记入口启用一个产物引用。定义协议通过作者 skill 按需学习；来源、检查逻辑和事件处理职责由模型在文件中表达，Runtime 执行登记后的版本。

### 12.2 持久 Subagent 状态

```json
{
  "virtualAgentId": "va-official-news",
  "programId": "watch-company-1",
  "lifecycle": "dormant|queued|running|waiting_review|paused|failed",
  "goal": "监控官方公告并验证重大变化",
  "lastCursor": "etag:abc",
  "lastEventId": "watcher-event-42",
  "lastRunId": "va-run-17",
  "lastConclusion": "未发现需要通知的变化",
  "confidence": 0.86,
  "openFollowups": [],
  "cooldownUntil": null,
  "health": { "lastSuccessAt": "...", "consecutiveFailures": 0 }
}
```

`lastConclusion` 和 `openFollowups` 是模型可读的语义摘要；cursor、runId、失败计数和 cooldown 由 Runtime 维护。

## 13. 网页更新如何反馈给 Virtual Agent

网页通常不提供 push webhook，Runtime 应按来源能力选择适配器：

```text
RSS/API/Webhook：优先使用结构化事件
静态网页：HTTP conditional request（ETag/Last-Modified）+ 内容 hash
动态网页：浏览器快照 + 规范化文本 hash
搜索结果：定期查询 + URL/标题/摘要去重
```

Web Watcher 生成可追踪的 observation，不直接向模型发送整页内容：

```json
{
  "type": "web.page_changed",
  "source": "https://example.com/news",
  "dedupeKey": "url+normalized_content_hash",
  "payload": {
    "url": "https://example.com/news",
    "previousHash": "sha256:old",
    "currentHash": "sha256:new",
    "diffArtifactId": "artifact-diff-1",
    "fetchedAt": "..."
  }
}
```

反馈链路是：

```text
Scheduler/Watcher
  → fetch/normalize/hash/diff
  → Event Log
  → Virtual Agent Inbox
  → wake lease
  → 一次短 Subagent Run
  → 读取 diff、baseline 和历史报告
  → relevance/importance/evidence 判断
  → report artifact + natural-language summary
  → Watch Program 更新
  → Main callback / 用户通知 / 再次 dormant
```

如果 Virtual Agent 此时已经运行，事件进入它的 Inbox，在安全 turn boundary 消费；不要中断正在进行的模型请求。若它处于 dormant，Supervisor 获取唯一 wake lease 后启动一次新的 Run。Inbox 保存待处理变化，唯一 wake lease 避免重复触发副作用。

## 15. 对 Main 负担的控制

Main 负责四类决策：

1. 用户到底想长期关注什么；
2. 研究后哪些变化值得监控；
3. Virtual Agent 的结果是否改变长期理解；
4. 是否调整、暂停或新增监控器。

Watcher 的轮询、cursor、hash、去重、cooldown、lease、重试和消息投递都由 Runtime 处理。Virtual Agent 每次只处理一个事件包，完整历史由 Runtime 维护。

## 16. 可复用 Profile 与 Main 生成的 Virtual Agent

Virtual Agent 应该分为两个层次：

```text
Virtual Agent Profile（可复用的能力）
  ├── source adapter：如何观察来源
  ├── normalizer：如何提取稳定内容
  ├── trigger：什么变化值得进入分析
  ├── handler prompt/tool policy：如何验证和总结
  ├── tests/fixtures：如何证明它工作正常
  └── version/capabilities

Virtual Agent Instance（某个 Watch Program 的实例）
  ├── 绑定 profile
  ├── 绑定公司/主题/URL/query
  ├── 保存 cursor 和最近状态
  └── 使用该实例自己的预算、通知和生命周期
```

### 16.1 预置 Profile

系统可以提前提供经过验证的 profile：

```text
web-page-change        普通网页变化
rss-news               RSS 新闻源
search-news            搜索结果变化
sec-filings            监管/财报披露
github-repository      GitHub release/issue/commit
company-careers        招聘页面和职位变化
```

预置 profile 提供稳定的观察和处理能力，不硬编码完整 Agent。每个 profile 应有版本、fixture 和回归测试，并独立于单个 Task 的配置。

### 16.2 Main 生成 Profile

当现有 profile 不够时，Main 可以让一个普通 Subagent 生成新的 monitor profile：

```text
研究来源
  → 写 adapter/prompt/test 到当前 workspace
  → run_monitor_once 验证
  → Main 检查证据和误报情况
  → 当前 Task 先以 local profile 运行
  → 用户确认或质量门槛通过后 promote 到 registry
```

Main 生成的 profile 必须先经过一次性验证，不能写完文件就直接让它长期运行。被 promote 后需要成为带版本的不可变能力；后续实例只引用 `profileId@version`。

### 16.3 简单的模型交互

`call_subagent(task, mode)` 永远只委派一次工作，不携带持久化配置。领域能力可由模型编写、测试并复用；Main 自己写定义文件或委派 Subagent 编写都遵循相同约定。经过 Main 验收的产物才进入显式登记流程。

前述 profile 库可以保留为内部复用素材，无需成为 Main 必填的类型枚举。作者 skill 已实现，文件包登记已由 `activate_virtual_agent` 提供，见 [运行时参考](runtime-reference.md#长期目标接口与调度)。

## 17. 多维监控与重大事件聚合

Main 研究清楚公司后，可以一次并行创建多个关注维度：

```text
官方披露 Virtual Agent
产品/客户 Virtual Agent
组织/招聘 Virtual Agent
竞争和市场 Virtual Agent
诉讼/监管 Virtual Agent
```

多个 Virtual Agent 通过两级反馈汇总结果，只在需要时唤醒 Main：

```text
Virtual Agent
  → 各自判断 no_change / relevant / uncertain
  → 写入 Program Event Inbox 和状态
  → 低价值结果进入 digest
  → 重大结果进入 Main Wake Inbox
  → Main 重新读取整体 Watch Program，决定行动
```

每个 Virtual Agent 负责一个窄领域，Main 负责跨领域综合。例如新闻 Agent 发现一条新闻时，只报告“业务变化候选”；Main 被唤醒后再结合财报、招聘和历史状态判断是否真的重要。

### 17.1 重大事件的判定

重大性不应只由单个 Agent 的主观判断决定，可以组合：

- profile 的领域规则；
- 事件来源可信度；
- 和 baseline 的差异；
- 多个 Virtual Agent 的交叉印证；
- 用户在 Watch Program 中的关注权重；
- 最近是否已经通知过同类事件。

低置信度事件进入 `uncertain` 队列，可以触发一次额外验证，但不直接通知用户。只有 `relevant_change` 且满足通知策略时才唤醒 Main 或发送通知。

### 17.2 Main 被唤醒后看到什么

Main 接收汇总后的事件包：

```text
Watch Program：Example Corp
触发原因：官方公告 + 招聘页面在 2 小时内出现相关变化
候选事件：2 条
已验证证据：3 个 Artifact
未解决问题：是否为正式产品发布
建议动作：Main 交叉验证后决定是否通知用户
```

完整网页、diff 和各 Virtual Agent trace 仍留在 workspace 中，Main 需要时再用 `browse_workspace` 查看。

## 18. Profile 的质量门槛

一个 Main 生成的 Virtual Agent 只有满足以下条件，才能被复用：

1. 能在 fixture 上稳定提取目标内容；
2. dedupeKey 不会因无关页面噪声频繁变化；
3. 至少有一次 no-change 和一次 relevant-change 验证；
4. 输出包含来源和证据；
5. 失败不会伪装成“没有变化”；
6. 有明确的 token、请求频率和副作用预算；
7. 版本化后可以回滚。

最小复用单元包含：

```text
adapter + normalizer + trigger + handler policy + fixture tests
```

## 19. 使用与验证入口

现行 Watch Program、事件发现、显式激活与 Supervisor 命令见 [运行时参考](runtime-reference.md#长期目标接口与调度)。本页是扩展设计，不能据此推断未来事件源、通知或独立守护进程已经提供。

开发时使用本地协议服务和可控制的事件夹具验证去重、租约、重启和失败恢复；真实模型分析需显式配置自己的连接，并记录请求预算。不得把外部来源失败判为没有变化，也不得把一次测试结论当作长期运行保证。测试分层与验收条件见 [本地验证](testing-local-run.md) 和 [长程任务设计](long-running-agent-design.md)。

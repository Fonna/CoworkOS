# W4 新增信息参考模板

读取结构化增量列表、GitHub 发布 API/Atom 订阅或 Hacker News 搜索 API，对新增和更新条目执行大小写不敏感的关键词筛选。

## 配置与检查节奏

设置真实 JSON 来源并替换 CONFIG.keywords；maxEvents 限制单轮候选数，maxSeen 限制保存的条目数。

`sourceFormat` 默认 `items`，对应标准 `{items:[...]}`；`github-releases` 对应 GitHub 仓库发布 API（例如 `https://api.github.com/repos/anthropics/claude-code/releases?per_page=3`）；`hn-search` 对应 `https://hn.algolia.com/api/v1/search_by_date` 的 story 搜索结果。GitHub 标题加上仓库名，跳过草稿；Hacker News 的投票和评论计数变化不算新资讯。选择来源页大小时保持整个响应不超过 256 KiB。

`github-atom` 专门支持 github.com 的仓库发布订阅（例如 https://github.com/anthropics/claude-code/releases.atom），能避开未认证 REST API 的共享出口额度问题。仅解析 GitHub 使用的受限 Atom 格式，解码 HTML 证据，拒绝 DTD、实体声明与 CDATA。它不承诺支持所有 RSS/XML；Atom 的 updated 时间表示发布条目的更新时间。

来源全文参与关键词匹配和版本摘要，长正文只在候选证据中截取片段；片段以外的实质内容编辑仍会触发更新。Hacker News 是社区来源，不能仅凭帖子标题把第三方说法当成官方结论。

由 Harness 按任务选择的 cadenceSeconds 调用，当前登记入口至少为 60 秒。探针单次执行后返回，不自行启动后台循环；脚本检查频率与模型处理条件分开。

## 事件与状态

首次全部建立基线；后续新条目或更新内容命中才报告。所有已发现的候选先保存证据，每轮只返回 maxEvents 条，其余保存在 state.pending。下一轮先交接已有队列，再继续读取来源，因此来源移除条目或暂时不可用不会丢失已经观察到的候选。pending 未清空时拒绝修改规则配置。候选队列超过 512 KiB 时明确报错且不推进游标，需要缩小来源页大小。

state 保存于 watcher/state.json，由 Runtime 写入。待交接队列清空后，规则配置改变会重新建立基线。来源异常必须报错，不能伪装成无变化；失败不会提交新的状态。只返回有界的证据和读取引用。publishedAt 与 observedAt 区分来源发布时间和探针首次发现的时间；延迟交接仍保留原观察时间。

## 唤醒后的处理

按 id、version、命中理由和来源引用核实新闻。关键词命中只表示候选相关性；决定是否需要更多证据、通知或临时提高检查频率。

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

标准 JSON 格式为 {items:[{id,title,summary?,url?,publishedAt?}]}；另外支持上述两种明确的公开 API 格式和 GitHub 发布 Atom。通用 RSS/XML、任意网页和 embedding 尚未覆盖。去重仅保证保留窗口内的条目；被淘汰的历史条目重新出现可能再次报告。

这是需要配置和审阅的模板包。复制文件或通过测试不会登记监控器。现有 activate_virtual_agent 只复制 rule.mjs 和 AGENT.md，因此配置必须写入 rule.mjs，来源列表同步写入 manifest.json；其他采集依赖需留在规则内或由来源提供。

Supervisor 的事件分析加载本 AGENT.md（最多 16 KiB）与登记时提供的 task。模板文件本身不会启用实例；需要 create_watcher 或 activate_virtual_agent 成功。Session 内外、直接唤醒与预算边界见 [本轮报告](../../../../../docs/watcher-runtime-report-2026-10-12.md)。

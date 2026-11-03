# CUA JavaScript SDK

本专项接口指南目前以中文维护。浏览器和原生操作分别见 [Browser Use](browser-use.md) 与 [Computer Use](computer-use.md)。

`cua_script` 在隔离的 QuickJS 中执行异步 JavaScript，适合把已知的连续 UI 步骤放在一次工具调用中。它通过当前已注册、已启用的 CUA 工具操作后端，保留原有参数检查、Task 隔离和原生访问策略。脚本无法开启工具组、启用全局桌面授权或恢复被暂停的会话。

Main/Pi 提供 `cua_script({ code, timeoutMs? })` 和 `cua_reset({})`；需要启用 `cua` 以及实际使用的 `computer` 或 `browser` 工具组。下级 Runtime agent 不会自动继承这套控制工具。

## 状态与输出

每个 cell 在异步函数中运行。只有显式放到 `state` 中的变量和 Window/Tab 对象会跨 cell 保留；局部 `let`/`const` 不会保留。状态只存在当前 Pi 会话的内存中，不写入 Task 持久数据，也不跨进程恢复。

```javascript
// 第一个 cell：打开隔离的浏览器页面，保存真实 SDK 对象。
state.tab = await cua.browser.open("https://example.com");
return { pageId: state.tab.pageId, observation: state.tab.observation };
```

查看页面实际的控件名称后，再执行下一 cell：

```javascript
await state.tab.getByLabel("File name").fill("report");
const exported = await state.tab.getByRole("button", { name: "Export CSV" }).click({ expectDownload: true });
return { dispatchStatus: exported.dispatchStatus, download: exported.download };
```

`return` 的 JSON 值放在 `details.value`；`console.log/info/warn` 产生有界日志。`await cua.emitImage(imageRef)` 可以显示当前 Task 的历史图片引用，不能传入文件路径。原工具返回的图片以 image block 输出，JSON 中不包含截图 base64。每 cell 最多交付最后四张图片；被替换的图片数量在 `visualFeedback.superseded` 中。

`details.calls` 按调用顺序列出最多 64 次内部调用：工具名称、状态、错误码、输入发送状态，以及可用的 session/page/observation/image 引用。摘要不复制键入内容；原有运行轨迹仍会记录脚本代码，不能把它视为完整脱敏日志。内部 RPC 调用既有工具的 execute，不会再产生一组独立 Pi `tool_call` 事件。

## 原生 Window

已有窗口级授权时，从 `computer_status` 返回的 active session 取得 `sessionId`，用 `cua.computer.use(sessionId)` 绑定。`discover` / `select` 需要已启用的全局策略；只有窗口级授权时这些工具可能不提供。绑定不授予或续期权限，授权过期仍须由用户宿主处理。

| SDK                                                | 对应工具/行为                              |
| -------------------------------------------------- | ------------------------------------------ |
| `cua.computer.status()` / `discover()`             | `computer_status` / `computer_discover`    |
| `cua.computer.select({pid, windowId, mode})`       | `computer_select`，返回 Window             |
| `cua.computer.use(sessionId)`                      | 重新绑定已有会话；本身不授予访问权限       |
| `win.observe()`                                    | `computer_observe`，更新 `win.observation` |
| `win.act(action)`                                  | `computer_act`，消费当前 fresh observation |
| `win.wait(condition, {timeoutMs?, allowTimeout?})` | `computer_wait`，以明确条件等待            |
| `win.release()`                                    | `computer_release`                         |

```javascript
state.win = await cua.computer.select({ pid: 123, windowId: 456, mode: "control" });
const observed = await state.win.observe();
const save = observed.accessibility.elements.find((e) => e.name === "Save");
await state.win.act({ type: "press", elementId: save.elementId });
await state.win.wait({ type: "accessibility_text", text: "Saved", state: "present" }, { timeoutMs: 5000 });
```

`act` 没有当前观察时先调用 observe；发送前清掉旧观察，成功后采用工具返回的新观察。失败、取消或输入已发送但截图失败时保留空观察，下次必须重新观察。SDK 不会重新发送失败的动作。AX `elementId` 必须来自最新观察，不能保存旧 id 后连续复用。坐标点击仍使用完整观察 PNG 的像素坐标。

## 浏览器 Tab

| SDK                                   | 对应工具/行为                      |
| ------------------------------------- | ---------------------------------- |
| `cua.browser.open(url, {timeoutMs?})` | `browser_open`，返回 Tab           |
| `cua.browser.use(pageId)`             | 重新绑定当前独立浏览器中的已有页面 |
| `tab.observe({timeoutMs?})`           | `browser_observe`                  |
| `tab.goto(url, {timeoutMs?})`         | `browser_act` 的 navigate 动作     |
| `tab.act(action, {timeoutMs?})`       | `browser_act`                      |
| `tab.wait(condition, {timeoutMs?})`   | `browser_wait`                     |
| `tab.close()`                         | `browser_close`                    |

语义定位方法：`getByRole(role, {name})`、`getByLabel(text)`、`getByText(text)`、`getByTestId(text)`，或 `locator({kind, ...})`。它们返回 Locator 对象，支持：

- `click({expectDownload?, timeoutMs?})`
- `fill(value, {timeoutMs?})`
- `press(key, {timeoutMs?})`
- `select(value, {timeoutMs?})`
- `waitFor({state?, timeoutMs?})`，默认等待 `visible`。

定位支持容器链与明确的索引，例如 `tab.getByRole("region", {name:"Report"}).getByRole("button", {name:"Save"})` 和 `.nth(1)`。`tab.frame(frameId)` 使用观察中返回的 iframe ID；动作后的 ARIA 也来自该 frame。Popup 从 `observation.pages` 取得带 opener 的新 pageId，再用 `cua.browser.use(pageId)` 显式绑定，不自动切换目标。

浏览器 `open/observe/act/wait` 和 Locator 动作支持 `{observation:"aria"|"screenshot"|"both"|"none"}`，默认 `both`。已知的语义步骤可用 `none` 连续执行，最后 `observe` 检查结果；显式省略观察不会生成或归档截图。`tab.clickAt(x,y)`、`tab.drag({x,y},{x,y})`、`tab.scroll(x,y,deltaX,deltaY)` 使用该 Tab 当前完整 viewport 截图的 CSS 坐标及 observationId；没有有效截图时先 `observe({observation:"screenshot"})`。跨 cell 可保留最新观察，任何动作、导航、尺寸变化或超过 30 秒都会使旧坐标凭据失效。

`win.wait`、`tab.wait`、`locator.waitFor` 在条件超时后默认抛出 `wait_timeout`，所以串行脚本不会继续下一条输入。只有明确处理探测失败时才用 `{allowTimeout:true}` 返回 `status:"timeout"`；低层 `computer_wait/browser_wait` 保留状态返回。若输入已发送但反馈缺失，SDK 抛 `observation_required` 并保留发送状态；浏览器后端也会拒绝新的动作，直到成功取得实际新观察。`none` 不能解除这个门禁，重建 Tab 或 `cua_reset` 也不能绕过。

定位参数、允许的按键和动作字段遵循原 Browser Use 工具。没有 CSS 字符串定位器、任意页面 evaluate 或 Node API。浏览器拥有独立上下文，不接管用户现有的 cookies、账号资料或标签页。`tab.observation` 只记录最近返回的观察；缺失 post-action 观察时会清空。

## 限制与恢复

| 项目                    | 当前限制                                                      |
| ----------------------- | ------------------------------------------------------------- |
| cell 时间               | 默认 15 秒，可设 1–60000 ms；内层工具仍有自己的更短时限       |
| 同步计算                | 每次执行/每批 Promise jobs 最多 50 ms；每批后让出宿主事件循环 |
| 代码 / VM 内存          | 64 KiB / 64 MiB                                               |
| guest 栈 / JSON 嵌套    | 128 KiB / 最多 24 层                                          |
| 内部 RPC                | 每 cell 最多 64 次，按序执行                                  |
| 文本输出 / 单工具元数据 | 128 KiB / 512 KiB                                             |
| 图片                    | 最后 4 张，单张最多 10 MiB                                    |

每个 CUA 操作都要 `await`。cell 返回时仍有未完成的 RPC 会报告 `unawaited_host_call`，取消剩余调用并丢弃 VM。CPU 超限、内存超限、未捕获异常、timeout 和 cancel 都返回 `vmReset: true`；取消信号传到真实工具，已排队的旧调用无法开始，旧 RPC 的迟到结果不能恢复 guest 或触发下一输入。

脚本没有宿主 eval、Node、filesystem、shell、任意网络或模块加载接口。`cua_reset` 丢弃变量和 SDK 对象，并取消当前 cell；它不撤销已经发送的输入、不释放原生授权，也不恢复用户接管后的控制权限。Pi 会话关闭会 dispose VM；切换会话也会清空状态。后端窗口和浏览器生命周期仍由原服务管理。

检查结果中的 `dispatchStatus`：`not_sent` 表示这次 cell 的变更调用未发送，`sent` 表示已确认发送，`unknown` 表示发送结果未知。`sent` 或 `unknown` 不能自动重发，需要先观察当前目标；`requiresObservation: true` 也要求重新观察。输出处理失败不会把工具已经确认的 `sent` 改成 `unknown`。`condition_met` 只证明等待条件，`sent` 只证明输入交付，都不能替代目标完成检查。

## 验证范围

确定性回归使用真实 QuickJS、真实 ComputerUse 队列与隔离 driver fixture，覆盖跨 cell、fresh observation、取消、资源上限与错误恢复；真实 Pi 使用本地假模型和自己的临时 Task/HTTP 服务。回归还覆盖真实 Chromium 上的 SDK scope/nth/frame/坐标组合、等待后停止，以及 Pi 外层 `toolResult.isError` 和结构化投递证据同步；业务恢复见 [进度与证据](cua-progress.md)。原生 AX 对真实应用的权限与动作验收独立记录，不能由 fixture 的通过替代；没有授予 OS 权限的环境中不进行真实桌面输入。

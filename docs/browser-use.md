# Browser Use

本专项指南为中文。Browser Use 用于 Task 自己创建的 Chromium 浏览器；原生桌面窗口操作见 [Computer Use](computer-use.md)，截图裁剪、比较和历史见 [视觉观察](visual-observation.md)。

## 使用与工具

Main 先调用 `enable_tools({groups: ["browser"]})`，再使用五个工具。CLI 与桌面宿主使用相同实现，默认 headless；工具不会连接用户已有 Chrome、读取已有 profile/cookies，或连接任意 CDP endpoint。

| 工具              | 参数 / 行为                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `browser_open`    | `{url, observation?, timeoutMs?}`，打开绝对 HTTP(S) URL，返回新 `pageId` 与所选观察；不接受 URL 中的用户名/密码 |
| `browser_observe` | `{pageId, frameId?, observation?, timeoutMs?}`，获取所选观察、URL/title、frame 和页面列表                       |
| `browser_act`     | `{pageId, action, observationId?, frameId?, observation?, timeoutMs?}`，一次动作和所选后续观察                  |
| `browser_wait`    | `{pageId, condition, frameId?, observation?, timeoutMs?}`，等待明确条件，返回 `condition_met` / `timeout`       |
| `browser_close`   | `{pageId?}`，关闭一页；省略 ID 关闭整个浏览器，归档和已下载文件保留                                             |

`pageId` 只属于创建它的 Task controller；其他 Task、关闭、取消或会话切换后不能复用。每个 controller 独立拥有一个临时 Chromium context，最多 8 个受控页面（含 popup）；操作串行，同 Task 当前 context 的页面共享 cookies，Task 之间隔离。初始化 viewport 为 1280×800，`deviceScaleFactor=1`、`scale="css"`，返回当前宽高和 CSS 像素截图。截图通过普通 image block 交给多模态模型，文本 metadata 不复制 base64；归档后返回可供裁剪/比较的 `imageRef`。

## 选择观察成本

`observation` 支持 `both`（默认）、`aria`、`screenshot`、`none`。`aria` 只取辅助结构文本，`screenshot` 只取 viewport PNG；`none` 只返回页面、URL、frame 等元数据，不抓屏或读取 ARIA。已确定的语义操作可连续使用 `none`，在阶段边界再取观察；新界面、不确定结果与最终验收应明确观察。

观察返回 `observationMode` 和 `observationStatus`。`captured` 表示已获取选定的真实观察，`omitted` 表示调用者明确选择 `none`。动作/等待的观察放在 `observation` 字段；`none` 时省略此字段，成功动作返回 `requiresObservation:false`。这与观察失败的 `failed`、`requiresObservation:true` 不同。`browser_observe({observation:"none"})` 不会解除失败后的观察门槛。

## 语义动作与等待

定位器精确匹配；多于一个目标会报 `ambiguous_target`，不会自动选择第一项。目标可附 `scope`（最多四个由外向内的语义定位器）和显式从零开始的 `nth`；每层 scope 默认也必须唯一，可用该层自己的 `nth` 消歧。索引越界返回 `target_not_found`。支持额外的 `region` / `group` 角色，无 CSS、XPath 或任意页面代码接口。

```javascript
const target = { kind: "role", role: "button", name: "Export" };
// 其他 target 形式：
// {kind: "label", text: "File name"}
// {kind: "text", text: "Completed"}
// {kind: "testId", text: "export-button"}

browser_act({ pageId, action: { type: "click", target } });
browser_act({
  pageId,
  action: { type: "fill", target: { kind: "label", text: "File name" }, value: "report" }
});
browser_act({
  pageId,
  action: { type: "press", target: { kind: "label", text: "File name" }, key: "Enter" }
});
browser_act({ pageId, action: { type: "select", target: { kind: "label", text: "Format" }, value: "pdf" } });
browser_act({ pageId, action: { type: "navigate", url: "https://example.com/reports" } });
browser_act({
  pageId,
  observation: "none",
  action: {
    type: "click",
    target: { ...target, scope: [{ kind: "role", role: "region", name: "Annual reports" }], nth: 1 }
  }
});

browser_wait({
  pageId,
  condition: { type: "element", target, state: "visible" },
  timeoutMs: 5000
});
```

元素条件支持 `visible` / `hidden` / `attached` / `detached` / `enabled`；URL 条件为 `{type:"url",url:"https://example.com/reports"}`，匹配规范化后的精确 URL，不是 glob。等待不循环调用模型。默认等待 5 秒，其他操作 10 秒，可设置 1 至 30000 ms；操作使用同一截止时间，反馈捕获有最多 2 秒的关闭宽限。

## iframe、popup 与坐标操作

观察的 `frames` 列出当前 page 的 `frameId`、name、url 和可选 `parentFrameId`（最多 64 项，超出标记 `framesTruncated`）。目标上的 `frameId` 明确选择定位所属 frame，省略时使用主 frame；跨 page、已 detach 的 ID 返回 `frame_not_found`。`browser_observe`、`browser_act`、`browser_wait` 顶层的 `frameId` 选择返回 ARIA 的 frame，截图仍是整页 viewport。例如在子 frame 操作并检查其结果：

```javascript
browser_act({
  pageId,
  frameId,
  observation: "aria",
  action: { type: "click", target: { kind: "role", role: "button", name: "Save", frameId } }
});
```

同 context 的 popup 自动登记到 `pages`，带 `openerPageId`，在 `events` 报告 `opened`。原操作的返回观察仍属于原 page；使用返回的 popup `pageId` 明确观察或操作它。全部页面共用八页上限，超限 popup 关闭并报告 `closed_page_limit`；关闭/reset 会回收所有所属页面。

`screenshot` / `both` 返回的 `observationId` 可授权一次 viewport 坐标动作，最长有效 30 秒。每次动作、重新观察、frame 导航/增删或 viewport 尺寸变化使旧凭据失效；凭据不能跨 page 使用。坐标必须在原截图宽高内，单位为 CSS viewport 像素，支持 canvas 等缺少语义元素的界面：

Pi 工具要求当前模型支持 image 输入才允许 `click_at` / `drag` / `scroll`；文本模型即使拿到截图 ID，也会在派发前收到 `image_input_required` 与 `dispatchStatus=not_sent`。文本模型的 `open` / `observe` / `act` / `wait` 显式 `observation:"screenshot"` 请求也在派发前拒绝，避免只抓屏但未交付图像就清除失败门槛；可用 `aria` / `both` 获取 ARIA 证据并使用语义定位操作。可信宿主已掌握图像时可直接调用底层 Browser API。

```javascript
browser_act({ pageId, observationId, action: { type: "click_at", x: 120, y: 300, button: "left" } });
browser_act({
  pageId,
  observationId,
  action: { type: "drag", from: { x: 120, y: 300 }, to: { x: 400, y: 350 } }
});
browser_act({ pageId, observationId, action: { type: "scroll", x: 400, y: 350, deltaX: 0, deltaY: 500 } });
```

上述每次调用都必须使用各自最新截图的凭据；例子不能连续复用同一个 ID。`aria` 和 `none` 不发放坐标凭据。拖动固定使用左键和有限中间步数；滚动在给定位置发出 wheel，delta 各限 ±10000。抓屏后页面仍可能变化，关键操作前应重新观察。

捕获开始时记录当前页面代次、URL 和 viewport，截图、ARIA、popup 注册与标题读取全部完成后再次核对。捕获期间发生页面或 frame 导航/增删、关闭或 viewport 变化时返回 `observation_changed`，不发放旧画面的坐标凭据，并要求成功重新观察后才能继续输入；已发送动作的反馈保留 `dispatchStatus=sent` 和 `requiresObservation=true`。初次 `browser_open` 遇到这类变化会在同一截止时间内重取一次观察，以处理 `DOMContentLoaded` 后才完成加载的 iframe；不重放导航或任何输入。

## 下载与结果证据

下载点击必须在发送输入前声明 `expectDownload: true`，工具先注册 download listener：

```javascript
browser_act({
  pageId,
  action: {
    type: "click",
    target: { kind: "role", role: "link", name: "Download report" },
    expectDownload: true
  }
});
```

成功返回 `download: {path, scope:"task", filename, bytes, sha256}`。保存到 `<Task>/visual/downloads/dl_<UUID>_<sanitized-name>`；文件名规范化、目录拒绝越界/symlink，目标以 `wx` 创建。Chromium 临时下载完成后，先检查默认 20 MiB 的接收限额，再有界复制并计算 hash；拒绝超限文件，不把它保存到 Task。限额约束接收文件，不保证浏览器临时网络下载大小。未声明期望的下载被取消并在事件中报告。取消/超时清理监听并取消尚未接收的下载；context 关闭清理 Chromium 临时文件，已接收文件保留。

`dispatchStatus` 为 `not_sent` / `sent` / `unknown`：click 的 actionability 预检查失败属于未发送；实际动作开始后失败保守报告 unknown；成功送达属于 sent。`effectVerified:false` 表示工具未判断业务完成。

发送后所选观察失败返回 sent + `observationStatus:"failed"` + `requiresObservation:true`；归档失败保留当前观察及发送状态。sent/unknown 错误或任何实际观察捕获失败后，后端对该 page 的全部动作返回 `observation_required`，直到成功 `browser_observe` / `browser_wait` 获取 `aria`、`screenshot` 或 `both`。显式 `browser_observe` 即使没有发送输入，捕获失败也返回 `requiresObservation:true`；无效参数或 frame 在捕获前拒绝，不会新加门槛。

新建脚本对象、重置 VM、选择 `none` 均不能绕过；关闭 context 会使整个 pageId 失效。等待命中、下载和 hash 是证据，仍应核对业务结果；未知结果先观察，不能自动重复点击或提交。

## 运行与生命周期

生产依赖为 `playwright-core@1.63.0`，安装 CoworkOS 不自动下载浏览器。优先使用 Playwright 默认 Chromium 安装位置；可信宿主可用 `COWORK_BROWSER_EXECUTABLE` 指定可执行文件绝对路径，模型工具不能修改它。缺失时返回安装指令：

```bash
npx --yes --package=playwright-core@1.63.0 playwright-core install chromium
```

调用取消会关闭 controller 的 context/browser、失效原 pageIds；以后可明确重新 `browser_open`。Pi 会话切换调用 `closeAll`，shutdown 调用 `dispose`；旧排队操作拒绝继续，永久 dispose 后不能再打开。实现位于 [controller](../src/gui/browser-use.ts)、[输入合同](../src/gui/browser-contracts.ts) 与 [Pi 工具](../.pi/runtime/tools/browser-use.ts)。

会话复用仅限当前 controller/context 生命周期：同 Task 新开页面可复用本 context 已建立的登录 cookies；关闭全部页面、取消、reset、会话切换或重启会清空登录状态。本版不持久化 storageState/profile，不承诺跨重启登录；重开后需要重新登录。不会读取用户浏览器资料，也不提供 CDP 接管。

[真实 Chromium 回归](../test/browser-use.test.js) 覆盖输入/等待/下载、取消/reset、Task cookie 隔离和复用、popup/page limit/风暴生命周期；[增强接口回归](../test/browser-advanced.test.js) 验证 scope/nth、iframe 归属、四种观察模式、canvas 点击/拖动/滚动、捕获期间导航的凭据边界与后端失败门槛；[工具反馈回归](../test/browser-tool-feedback.test.js) 覆盖归档失败时的当前图像与发送证据，以及文本模型坐标动作、截图单模式派发前拒绝与 ARIA 恢复；[真实 Pi 链路](../test/browser-use-pi.test.js) 验证 Main hook → Chromium → PNG 归档与文件重读。测试使用隔离临时 Task 与本地页面/假模型；缺少 Chromium 时明确跳过。实际模型规划、商业网站兼容性和其他平台安装需要分别验收。

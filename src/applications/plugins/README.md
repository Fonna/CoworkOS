# Harness 插件（plugins）

本目录放置「harness」类应用：它们不实现建模引擎，而是把**外部 stdio MCP 服务器**的工具暴露给智能体，用于驱动 FreeCAD / Blender 原生应用、CAD viewer 或 OfficeHarness Impress 工作区。

## 与原生应用的区别

|          | 原生应用（`src/software/` + `adapters/`） | harness 插件（本目录）                       |
| -------- | ----------------------------------------- | -------------------------------------------- |
| 几何引擎 | 自己实现（bpy / JSCAD / CadQuery）        | 无，驱动外部应用                             |
| 工具来源 | Adapter 的 `agentTools`（进程内）         | 外部 MCP 服务器的工具                        |
| 资源     | 真实文档/工程（revision、历史、导出）     | 最小「会话描述」`{ host, port }`，仅用于绑定 |
| 绑定后   | 打开文档即开始编辑                        | 绑定会话描述即启动 MCP 服务器并暴露其工具    |

## 接入模式

一个插件 = 一个目录 + 一份技能，四件事（后端的 MCP/资源部分）：

1. **`paths.ts`** — 解析插件的**外部目录**与路径/host/port。根目录优先来自 CoworkOS 自己的注册表 `~/.atria/plugin-registry.json`（与 coderix_main 的注册表相互独立），回退 env 覆盖（`CAD_HARNESS_PATH` / `BLENDER_MCP_DIR` 等）与机器默认。`uv` 路径必须返回绝对路径：MCP SDK 的 stdio 子进程只继承白名单环境变量，裸 `uv` 会解析失败。
2. **`mcp.ts`** — 构建 `McpServerSpec`（`command`/`args`/`env`），启动参数指向外部插件目录下的 MCP server。平台（`McpSupervisor`）在窗口打开时惰性启动它，最后一个窗口关闭时停止它。
3. **`adapter.ts`** — 一个 `WorkbenchRuntimeAdapter`，`definition.mcpServer` 指向外部服务器，`agentTools` 留空（工具来自 MCP）。资源是会话描述 JSON，声明 `edit` 能力以出现在应用面板。
4. **`.pi/skills/<name>/SKILL.md`** — 本地兜底技能；插件的**完整技能树**与 workflow prompt 从外部目录的 `skills/`、`prompt.md` 加载，通过 `definition.skillRoots` / `systemPrompt` 引用。

在 `index.ts` 的 `registerHarnessPlugins()` 里注册新插件，并在 `builtins.ts` 的 `defaultRegistry()` 调用它；同时在 [前端 registry](../../../web/assets/workbench/registry.js) 注册 UI adapter，否则应用面板会过滤掉该应用。应用专用的本地兜底技能通过 `application: <appType>` frontmatter 限定绑定作用域；应用技能根优先于通用技能根，Main 的技能目录、`load_skill` 与委派/恢复使用同一作用域。

## 外部插件目录（仅注册）

`cad-harness` 与 `blender-harness` 的**内容**（MCP server、技能、workflow prompt、`.env`）不在本仓库内，而在自包含的外部目录，由 `~/.atria/plugin-registry.json` 按名注册；`office-harness` 同理，其 MCP server 用插件自带的 `runtime/bin/node` 启动，编辑器是浏览器内嵌的 Impress WASM 工作区，由桌面 `desktop/office-harness.cjs` 通过插件的 `managed-host.cjs` 起停/复用同一个 host：

```json
{
  "plugins": [
    { "name": "cad-harness", "path": "/absolute/plugins/cad-harness" },
    { "name": "blender-harness", "path": "/absolute/plugins/blender-harness" },
    { "name": "office-harness", "path": "/absolute/plugins/office-harness" }
  ]
}
```

示例中的目录必须替换为实际绝对路径；注册表不会展开 `~`。共享解析逻辑在 `plugin-registry.ts`（`readPluginRegistry` / `resolveRegisteredPluginDir` / `loadDotEnv` / `readPluginManifest`）。项目内只保留「注册」：解析目录、读 `plugin.json` 的 `agent.systemPromptFile`，其余（服务端脚本、技能、提示词）都在外部目录。

## 打开方式（对话 + 贴靠到 CoworkOS 右侧）

harness 是「对话模式」应用：点击应用面板里的磁贴会**创建一个对话**并绑定会话资源，加载该应用的 MCP 工具与 prompt。FreeCAD/Blender **拉起外部 GUI 二进制、把窗口贴到 CoworkOS 右侧**（左右并排 + 跟随移动/缩放），不打开工作台标签页；CAD/Office 打开工作台标签，由当前可见编辑器激活内嵌 viewer/Impress 视图。

- 对话创建/资源绑定由前端 `web/assets/controllers/workbench-controller.js` 的 `onOpenHarness` 编排（`createTask` + `createResource` + `bindResourceToTask` + 导航）。
- 启动 + 贴靠由 **Electron 主进程** 的 [`desktop/harness-tiling.cjs`](../../../desktop/harness-tiling.cjs) 负责，经可信 IPC `bookmanDesktop.harnessLaunch(appType)` 触发；需要 `screen`/`BrowserWindow`，只有主进程能拿到。
- 贴靠重定位从外部应用**内部**完成，无需辅助功能权限：FreeCAD 用 `execute_code`（Qt `Gui.getMainWindow().setGeometry`），Blender 用 `ctypes`/ObjC（`NSWindow.setFrame`）。
- 工作台通过 `setVisible` 交接内嵌视图的激活令牌；隐藏标签、迟到的加载或关闭回调不能覆盖当前可见标签。CAD 的扫描目录由当前会话引用的 `storageRoot` 与 `taskId` 解析，不能拼接资源根 `workspaceRoot`。桌面宿主重新创建主窗口时重新挂载原生视图。

## 边界

- 外部 MCP 服务器不是 CoworkOS 的「有状态资源」服务器：它忽略 `_meta["atria/resource"]`，返回纯文本结果。`McpSupervisor` 只提取 text、丢弃 ImageContent，模型工具里的截图类输出（如 Blender `get_screenshot_of_area_as_image`）不会回传。
- **不做界面内截图预览**：CoworkOS 不显示外部应用的截图，改为贴靠窗口让用户直接看真实应用。Blender 贴靠依赖 `ctypes`/ObjC，arm64-only；FreeCAD 用 Qt 的 `setGeometry`。
- 外部二进制路径默认沿用 coderix 的机器约定，可用 `FREECAD_BIN` / `BLENDER_BIN` 等 env 覆盖。

相关指引：[应用 AGENTS](../AGENTS.md)、[软件接入](../../../docs/software-integration.md#harness-应用)。

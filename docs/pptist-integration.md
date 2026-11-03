# PPT 演示文稿应用接入

PPT 演示文稿是工作台中的内置应用，编辑画布使用 PPTist，遵循现有 v1 应用协议。默认 Mac 包包含 PPTist 浏览器编辑器，随 CoworkOS 更新；在“设置 → 应用与组件”查看状态。缺失编辑器时，工作台提供“在设置中安装”按钮进入修复说明，当前通过重新安装完整 CoworkOS 包修复。

CLI 的 `coworkos components install pptist` 保留为进阶命令，见 [应用与组件](optional-components.md)。用户界面统一使用“PPT 演示文稿”，内部应用类型、工具 ID 和原生格式保持兼容。

编辑资源是原生结构的 UTF-8 JSON（`presentation/pptist+json`，文件后缀 `.pptist.json`）；PPTX、PPTIST 和图片是导入/导出格式。

## 接入边界

| 责任                                                               | 实现                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 应用声明、格式校验、原子操作、逆操作、选区、上下文、领域工具、导出 | `src/applications/adapters/pptist-runtime-adapter.ts`                                     |
| JSON 模型与服务端 PPTX 转换                                        | `src/software/pptist/`                                                                    |
| 前端挂载与生命周期、调用现有 API、草稿恢复                         | `web/assets/workbench/adapters/pptist-editor.js`、`web/assets/pptist/document-session.js` |
| 编辑画布、富文本、导入转换、放映、完整前端导出                     | `vendor/pptist/`，通过 iframe 内部消息协议连接 UI Adapter                                 |
| 注册入口                                                           | `src/applications/builtins.ts`、`web/assets/workbench/registry.js`                        |

资源的版本、CAS、幂等、历史、撤销、任务引用和绑定统一由现有 `ResourceStore` 管理。Agent 工具返回原子操作，由现有应用工具桥执行；声明 `requiresFreshRead`，必须先读取再修改。`pptist_get_schema` 不替代读取入口。CLI 使用同一 Runtime Adapter，不启动浏览器编辑器。

内部 postMessage 只负责 UI Adapter 与嵌入编辑器的文稿/选区交换，不是新的资源 API。消息核对 origin、source 和每次挂载的 channel。放映退出也由此内部协议交给 UI Adapter；macOS 利用现有 preload 的窗口状态通知等待原生全屏进入结束后退出，避免 iframe 卡在全屏。PPTist 不直接读取工作空间或调用后端路由。

编辑器通过 `ready.capabilities` 声明 `host-commands-v1`，加载完成后由嵌入的单行命令栏承担文件、插入、放映、侧栏和保存操作。宿主通过 `host-state` 同步标题、忙碌状态与保存状态，编辑器通过 `host-command` 请求固定白名单中的文档操作；仍由 UI Adapter 执行版本保存、重命名、历史、导出和保存副本。旧版编辑器或组件失败时保留宿主操作栏；所有新增消息沿用来源与通道校验。

PPT 挂载使用 `GET /api/components?id=pptist` 检查本地编辑器，避免等待其他应用的运行时探测。组件缺失和禁用时仍显示原有设置修复入口。

通用平台提供以下与软件类型无关的扩展：可信 `ApplicationDefinition.contentBytes` 声明（其他应用默认仍为 2 MiB，最大 32 MiB）；静态资源按实际扩展名返回 MIME；`fileImportFormats` 声明需要 UI 转换的文件格式。核心服务、Host、页面控制器、Pi 桥没有 PPTist 类型分支。

## 功能与使用

在会话中打开时沿用工作台的左侧会话、右侧应用布局（窗口宽度至少 1100px）；全屏编辑、恢复并排、收起和宽度调整均由原有 Host 管理。未关联会话时使用独立工作台，通过工作台更多菜单选择“在对话中使用”，或新建对话，再在输入区的应用菜单中载入演示文稿并进入并排协作。

从“应用 → PPT 演示文稿”打开空窗口，手动新建；也可以在对话中创建、绑定并继续修改。新建文件使用既有 createAndOpen，文件切换由工作台管理。支持文本、图片、形状、线条、图表、表格、公式、音视频、主题、动画配置、演讲备注、放映与演讲者/观众窗口。

修改自动保留为 CoworkOS 恢复草稿；关联本地 PPTX/JSON 的原文件只在点击“保存”或按 ⌘/Ctrl+S 时写回。切换文稿、导出、关闭和工作台 flush 只保留恢复草稿，不覆盖原文件。保存按钮的提示和读屏状态区区分恢复草稿与原文件状态；错误及恢复操作显示在编辑器底部。

显式保存与 flush 都先取得最新编辑器快照。保存确认同步规范化内容时保留编辑器选区与撤销/重做记录；撤销或重做也要再次手动保存才更新原文件。

断网保留草稿及操作 ID，重试不会重复提交；CAS 冲突保留本地草稿，可下载备份后明确放弃草稿并重新载入。浏览器草稿受 localStorage 容量与 origin 限制，容量不足时会提示。已保存资源使用工作空间文件，不依赖浏览器存储，桌面后端换端口或退出重启后均可恢复。

首次调用 `pptist_read_presentation({})`，省略 `slideId`，从目录 `outline` 取得真实页 ID；其中 `page` 是页码、`id` 才是后续读取/编辑使用的标识。`pptist_get_schema` 中的 `intro` 等示例 ID 用于说明新建格式。找不到页面时，错误返回 `availableSlides` 和读取目录的 `nextAction`，应按此恢复，避免继续猜 ID。

`pptist_read_presentation` 返回目录和指定页元素；嵌入媒体只返回占位说明，修改既有元素时仅提供变动字段，不能把占位说明写回。`pptist_edit_presentation` 支持页面增删/重排、属性更新、元素增删改与主题更新。完整文稿替换是 UI 保存操作，所有修改都支持现有历史与撤销。新增文本元素默认 `inset: [0,0,0,0]`，既有文稿未指定内边距时仍沿用 PPTist 的 10px 默认值。读取结果包含 `layoutWarnings`（越界、固定文本框高度、页码换行风险）；这是结构检查，不代表已经完成字体和画面的视觉验收。

编辑器文件菜单内的“打开 PPTX / 打开 JSON”通过工作台打开独立文稿；桌面原生文件选择器保留所选文件路径，后续正文、标题、备注修改在手动保存时写回该文件。打开另一份文稿前保留当前恢复草稿，不隐式写回原文件；取消选择或打开失败保留当前文稿。“插入 PPTX 幻灯片 / 插入 JSON 幻灯片 / 插入源文件幻灯片”明确向当前文稿追加页面，仍保存到当前文稿的原文件；空白文稿会被替换。打开和插入采用不同入口，避免把另一份文件拼入当前文稿后误用旧保存目标。

导入 JSON/PPTIST 会在渲染前验证并清理富文本；PPTX 由上游转换器在本机转换。通用 `importResource` 接口支持 JSON/PPTIST 原文件。导出 JSON/PPTIST 保留完整源数据；编辑器的导出面板提供 PPTX、PNG/JPEG 和系统打印/PDF。

空白应用的“打开已有文件”及编辑区域拖入均支持 `.pptx`，无需先转成 `.pptist.json`。旧版导出曾将 CSS 字体名的引号重复写入 Office XML，导致导入时表格内容被截断并报“表格单元格或列宽无效”；本机导入会在内存中兼容这一已知属性形式，打开过程不改写原文件。浏览器和服务端导出均将 CSS 字体列表转换为单个 XML 安全的字体名，避免再次生成同类文件。

产出物中的 PPTX 可点击“编辑”，或在详情中点击“在应用中打开”。通用工作台根据 `fileImportFormats` 找到 UI Adapter 的 `importFile(file)`，由隔离的编辑器 iframe 复用上游 PPTX 转换器，转换成功后通过既有 `createResource` 创建原生 JSON 副本，再打开并绑定。原导出文件不变；失败或超时不创建空白资源。此声明不是 `resourceKinds`：二进制 PPTX 不会被当成 UTF-8 原生文件，CLI 的 `importArtifact` 仍不执行浏览器转换。已有文稿内的本地 PPTX 导入入口继续可用。

通用 `export_resource` 支持 JSON、PPTIST、PPTX，通过原有 Artifact Store 生成产出物。服务端 PPTX 转换支持基本可编辑文本、图表、表格和嵌入媒体，图表导出保留文字颜色和显式图例、数值标签设置，表格导出保留单元格颜色、字体、边框和合并信息；复杂视觉样式请使用编辑器的完整 PPTX 导出或图片模式。PPTX 的复杂布局、动画等受上游兼容性转换限制，不能代替原生源文件备份。服务端导出不会联网抓取远程媒体；远程音视频也需要目标机器能访问。

每份文稿最多 32 MiB、200 页，每页最多 500 个元素。上传的本地媒体转为随文稿保存的 base64，避免临时 blob 地址在重开后失效。大媒体应压缩后导入。每次保存保留版本历史，历史中的重复媒体共享外置内容，读取时按字节预算加载完整事件，避免反复保存后整份历史驻留内存。不同媒体与快照仍会增加磁盘使用量；备份和版本兼容边界见 [操作历史布局](task-workspace-layout.md#外部修改并发与恢复)。

## 构建和上游

上游固定为 PPTist `1d5dc853f77e99c0d3d9485ea9e52774f870ee78`（2.0.0）。源码、AGPL-3.0 许可及修改说明保存在 `vendor/pptist/`；编辑器“开源许可”入口可下载本版本的完整编辑器源码。没有使用上游托管 AI、图库搜索或在线字体服务，AI 由 CoworkOS 对话处理。字体采用本机字体，跨机器可能有字体替换。

`npm run build` 包含 `build:pptist`，首次构建会在 vendor 目录安装锁定依赖；锁文件变更会重新安装。生成文件位于 `web/assets/pptist/generated/`，不入 Git，桌面打包通过现有 web 资源规则包含它。源码打包需要系统 tar。

## 验证

- `npx playwright test e2e/pptist-fidelity.spec.js e2e/conversation-retry.spec.js`：深色图表和表格经过两条 PPTX 导出路径再导入，页码单行、主题颜色与页面顺序，以及 HTTP 524 自动重试提示和停止记录持久化。

- `node --test test/pptist-*.test.js`：原子修改、输入校验、逆操作、5 MiB 文件持久化、冲突、导出文件内容、草稿与重试竞态。
- `node --import ./test/isolate-user-data.mjs --test test/application-history-storage.test.js`：反复整体保存的媒体共享、历史分页、旧回执与撤销、事务恢复，以及受限 heap 下读取旧大历史。
- `npx playwright test e2e/pptist.spec.js e2e/pptist-chat.spec.js`：真实编辑器交互、保存重开、导入导出、协作、冲突恢复与放映。
- `npx playwright test e2e/pptist-quoted-fonts.spec.js e2e/original-file-desktop.spec.js`：旧版重复字体引号与正常 PPTX 的拖入、完整表格、重开、导出后 XML 校验及桌面原文件保存；夹具由测试生成，不保留用户文稿。
- `npx playwright test e2e/pptist-desktop.spec.js`：使用隔离数据目录启动真实 Electron 应用，保存后退出重开、重命名、放映与导出。
- `ATRIA_PPTIST_NPM_DESKTOP=1 npx playwright test e2e/pptist-desktop.spec.js --workers=1`：通过实际 `npm run desktop` 启动和重启，包含构建与开发启动脚本，再执行同一组桌面操作；调试端口仅供测试连接。

对话端到端测试只替换外部模型响应，工作台、Pi 调用、工具发现和资源提交均使用真实实现；不能据此声称评测了实际模型的排版质量。PDF 测试检查真实打印事件及打印文稿，系统“存为 PDF”对话框属于 OS 交互。

表格单元格与正文使用允许的富文本过滤，服务端、导入、显示和编辑边界均执行；允许的文字、颜色和强调保留，两条 PPTX 导出路径解析富文本而非输出 HTML 字面。人工表格输入同步更新文档快照，立即保存或退出不会保存输入前的旧值；历史仍合并短时间连续输入。回归见 [表格内容](../e2e/pptist-table-content.spec.js)。

内容规划和视觉验收见 [PPT 工作流](presentation-workflow.md)。绑定文稿通过既有应用操作修改，独立文件生成器不能绕过已打开资源的版本协议。

# 演示文稿工具参考

中文 | [English](en/presentation-reference.md)

已有 PPTist 文稿通过应用工具读取、原子修改和导出，保留人工编辑与修订。独立 PPTX 文件可通过 `presentations` 技能的组件生成器创建；两条路径共用结构检查、真实渲染和逐页视觉审阅。生成器不会替换已绑定文稿的版本化协议。

## 生成与修改

先确定受众、资料和逐页结论，再选择主要视觉、字体、配色与边距。定量图表必须注明来源和单位；演示数据明确标注。内容过密时精简或拆页，不能依赖缩小字体通过检查。

绑定文稿使用 `pptist_read_presentation` 获取真实页面 ID，以 `pptist_edit_presentation` 修改并处理 `layoutWarnings`，再用 `export_resource` 导出。导出 PPTX 是兼容转换，交付时保留原生 JSON/PPTIST 源文件。

独立文件使用 [组件规范](../.pi/skills/presentations/references/deck-spec.md)，支持封面、结尾、对比、流程、时间线、图表、图片、结论页，以及图片主视觉、图库、图片标注和原生节点连接图。组件支持深浅表面、图片左右布局及保持比例的包含/裁切；自定义构图仍可使用 PptxGenJS，不能为了适配组件削弱逐页设计。生成原生可编辑对象，以及记录元素 ID 和几何的 `.layout.json`；保留输入 JSON 或自定义 PptxGenJS 源码，便于修订。源码模式命令：

```sh
npm run slides:build -- deck.json deck.pptx
npm run slides:validate -- deck.pptx
npm run slides:render -- deck.pptx --output-dir preview
```

产品内 Agent 通过 `load_skill({name:"presentations"})` 获取实际技能目录和脚本路径，不猜安装位置。最终文件使用 `publish_artifact` 发布，临时预览留在工作目录。

从项目工作目录运行技能脚本 `check_backend.mjs`，会同时发现常见素材目录中的图片，报告路径、格式、大小及可读的像素尺寸。素材清单用于筛选，不能替代看图；只检查计划采用且裁切、主体或内嵌标签会影响构图的图片。多页且包含外部来源的任务，可让一位异步协作者独立核对资料，Main 同时规划和制作；已有可靠资料或简单任务可跳过。保持一位源码作者，避免多个 Agent 修改同一文稿。

## 验收与证据

结构检查使用 Python 3 标准库，检查包内 XML、关系引用、页面顺序和越界，报告文字框重叠、文字容纳估算及字体可用性。字体检测使用可选的 fontconfig；无法确认字体时报告警告，`--strict-fonts` 将其作为失败。分组、旋转、继承字体及跨机器差异仍需查看实际渲染。

PPTX 渲染需要 LibreOffice、Poppler 的 `pdftoppm` 和 Python 3。联系表使用 Python 标准库拼接 Poppler 缩略图，不要求 ImageMagick 或 Pillow。已有 PDF 可以直接作为输入，不需要 LibreOffice。`check_backend.mjs` 分别报告创建、校验、PPTX 渲染及 PDF 渲染能力；不会自动安装依赖。可用 `COWORK_SOFFICE_PATH`、`COWORK_PDFTOPPM_PATH` 和 `COWORK_PYTHON_PATH` 指定已有可执行文件。

渲染输出 PDF、逐页 PNG、联系表和 `render-manifest.json`，包含源文件与最终图片的 SHA-256。源文件在渲染期间变化或渲染失败时，不留下可用的成功清单。清单只证明渲染产物的对应关系，不能证明视觉质量。

配置视觉连接后，`review_slides` 可在一次调用中检查全部最终 PNG，并把联系表作为 `overview` 放入同一队列。默认并发 2，提供方容量已知时可设为 1 至 4；一个检查完成就继续下一页，无需先等待联系表返回。

参数与路径以当前工具声明为准：Main 默认 `scope:"project"`，子智能体默认 `scope:"work"`，共享 Task 预览使用 `scope:"task"`。单页及联系表从选定的图片根目录解析，可使用根内相对或绝对路径。

`reportPath` 独立解析到当前 Agent 自己的报告目录：Main 使用 Task 内的 `agents/main/work/`，子智能体使用自己的工作目录。可传报告目录内相对或绝对路径，返回的 `reportScope:"work"` 标识此基准。

`scope:"task"` 扩大图片读取范围，不扩大写入范围。工具拒绝目录及符号链接逃逸。

```json
{
  "slides": [
    { "path": "preview/slide-01.png", "goal": "本页说明输入如何变为预测，检查图示方向、标签和可读性" }
  ],
  "overview": { "path": "preview/contact-sheet.png" },
  "reportPath": "preview/review.json",
  "concurrency": 2
}
```

实际调用须按页序列出所有最终页；示例只展示单页格式。工具保存每张图的哈希、模型、问题、状态和尝试历史；修改后沿用同一 `reportPath` 和逐页目标，再提交全部最终 PNG，复用未变化的检查。`everySubmittedPagePassed` 仅覆盖提交的页面，Main 仍须核对整份文稿的覆盖情况。报告是审阅记录，不能手写通过结果或替换真实检查；修订决定另行记录。

未配置视觉连接或批量工具不可用时，使用 `read_image` 检查联系表，并逐页审阅。联系表检查一致性和版式节奏，不能证明单页可读。Main 的读图路径默认相对项目目录（`scope:"project"`），子智能体默认相对工作目录（`scope:"work"`）；`scope:"task"` 只读共享 Task。`read_image` 优先使用相对路径，也接受选定根目录内的绝对路径；工具验证真实路径，拒绝目录及符号链接逃逸。

原生图像模型直接接收像素，由 Main 记录结论；纯文本模型通过指定的视觉连接取得报告。`review:true` 要求 `pass`、`needs_revision` 或 `unreviewed`、摘要及最多六条有位置和修改建议的问题。批量工具始终通过所选视觉连接取得结构化证据。检查图示语义及来源事实，并将其与裁切、重叠、对比度等视觉缺陷分开；视觉模型不能认证外部事实。

先读完整套结果，再集中修订并统一重建、渲染和复查；默认一轮修订，第二轮只处理仍存在的重大缺陷。每个失败检查最多重试一次，报告未检查页、失败及未解决问题。批量记录按图片与目标持久复用证据和尝试历史；不要更换措辞绕过重试限制。

`read_image` 对相同连接、图片、路径和目标的成功分析按工具会话缓存；同一取消范围内的并发调用复用请求。两次相同失败后停止重试；取消不耗费该读图重试预算，并向模型请求传递取消信号。取消和缺失响应均不会成为通过证据。缓存及批量记录都不是跨进程的服务方计费控制。

## 视觉连接

在现有“模型连接”中保存支持图像的配置，勾选“用此连接分析图片，供纯文本模型使用”。只保存该配置即可，聊天继续使用当前连接。图片会发送到所选视觉服务；桌面密钥继续使用 safeStorage 加密保存，Web/CLI 使用已有私有配置。两种消息格式均复用现有连接协议。配置和环境变量详见 [模型配置](configuration.md)。

## 验证入口

文件生成、包校验及 PDF 渲染见 [文件测试](../test/presentation-files.test.js)；视觉协议、取消、路径边界和重试见 [视觉测试](../test/vision-model.test.js)；批量队列、增量记录和证据复用见 [批量审阅测试](../test/slide-review.test.js)；真实 Pi 工具调用见 [Pi 回归](../test/vision-pi.test.js)。测试使用隔离工作目录和本地假模型，不证明实际模型的排版质量。真实模型、原生桌面与最终安装包分别验收。

## 多图比较

`read_image` 推荐使用 `paths:["image.png"]` 读取单图或按顺序比较多图，也保留单图 `path` 别名；未使用的字段应省略。兼容模型同时填写相同的 `path` 与 `paths:[path]`，只读取一次；空字符串或空列表占位不算额外选择。两者指向不同图片时仍拒绝，不会静默丢弃比较图片。一次 1 至 4 张 PNG/JPEG/GIF/WebP，默认单图上限与比较总上限均为 20 MiB。图片按列表顺序发送，返回每张图片的路径和哈希；改变顺序、内容或目标会使比较缓存失效。原生图像模型接收全部图片，纯文本模型通过所选视觉连接在同一次请求中比较。

```json
{
  "paths": ["preview/before.png", "preview/after.png"],
  "scope": "task",
  "goal": "比较标题遮挡和手机布局变化"
}
```

比较用于判断变化；`review:true` 仍要求每次只审阅一页。所有图片先通过相同真实路径、格式和大小检查；取消信号传递给读图及模型请求。

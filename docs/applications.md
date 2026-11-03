# 应用功能

中文 | [English](en/applications.md)

应用入口提供文本、PPT、CAD 和 Blender 四种内置工作台，直接在 CoworkOS 中编辑。已有外部应用会话仍可从原会话或应用文件列表打开。

在侧栏点击应用名称可展开或收起已有实例，点击右侧“+”新建独立实例。实例菜单中的“在对话中使用”会返回该实例已关联的会话；首次使用时创建新的会话（无项目时为临时会话），不会自动关联到当前或最近的其他会话。要加载到已有会话，请在该会话输入区选择应用。

应用顶栏直接提供“在对话中使用”和“任务面板”图标按钮；会话已经可见时隐藏前者。应用与其会话并排显示时，任务面板替代左侧全局导航，任务面板按钮可收起或展开它。收起或关闭应用显示后恢复原导航与任务面板状态。

## 内置应用

### 文本编辑

编辑纯文本与 Markdown，可手动撰写，也可选中段落交给 CoworkOS 接续修改。

- 打开、编辑和下载 TXT、Markdown 文件。
- 按选区或指定范围修改，保留文档其他内容。
- 自动保存、查看修改对比与历史，处理并发编辑冲突。

[文本编辑参考](text-editor.md)

### PPT

制作和修改演示文稿，在画布上调整页面，也可让 CoworkOS 读取并修改指定幻灯片。

- 导入 PPTX、JSON/PPTIST 文稿，编辑文本、图片、形状、图表和表格。
- 调整页面顺序、主题与版式，保留演讲备注。
- 导出 PPTX，保留 JSON/PPTIST 源文件用于后续编辑。

[PPT 编辑参考](presentation-workflow.md)

### CAD 工作台

创建或打开 CAD 工程，在 CoworkOS 内编辑和查看模型。CadQuery 工程的精确计算需要 CAD 组件就绪。

- 修改 CadQuery/Python 或 JSCAD 源码及已有参数。
- 查看部件、尺寸与计算结果，使用剖切、线框和爆炸图检查模型。
- 导出工程 JSON、源码、STL 和 PNG；CadQuery 工程还可导出 STEP。

[CAD 工作台参考](cad-workflow.md)

### Blender 工作台

创建或打开 Blender 工程，在 CoworkOS 内编辑和查看场景。建模执行、原生导入和渲染需要 Blender 组件就绪。

- 调整对象位置、旋转、缩放与基础材质。
- 编辑 Python/bpy 源码和参数，执行后更新场景。
- 导入或导出 `.blend`，导出 GLB、渲染 PNG 和 Python 源码。

[Blender 工作台参考](blender-workflow.md)

## 外部应用兼容

以下接入保留对已有会话和资源的支持，不再作为默认新建入口。

### Blender Harness

通过外部 Blender 操作场景、材质和灯光。需要另行安装 Blender、启用 Blender MCP 插件，并准备可用的 MCP 服务环境。

- 在真实 Blender 窗口中与 CoworkOS 接续编辑。
- 保存 `.blend` 工程，导出 GLB 等模型文件。

[Blender Harness 接入参考](external-applications.md#blender-harness)

### FreeCAD Harness

通过外部 FreeCAD 创建和修改文档。需要另行安装 FreeCAD、加载 freecad-mcp 插件并配置对应运行环境。

- 创建、修改和查询对象，读取属性并核对尺寸。
- 在 FreeCAD 中继续手动编辑，保存原生工程并导出模型。

[FreeCAD Harness 接入参考](external-applications.md#freecad-harness)

### CAD Harness

通过 build123d 进行参数化建模，并在对话旁查看三维结果。需要另行安装并注册 CAD Harness，准备 build123d/Python 环境和 CAD Viewer。

- 从尺寸与几何要求生成模型，保留 `.step.py` 参数化源码。
- 检查模型尺寸与几何，生成渲染并打开三维查看器。
- 导出 STEP、STL、GLB 和 3MF。

[CAD Harness 接入参考](external-applications.md#cad-harness)

### OfficeHarness

在外部 Impress 工作区中编辑 PPTX，用户和 CoworkOS 操作同一份文稿。需要另行安装并注册 OfficeHarness 插件及其运行环境。

- 读取和修改幻灯片、对象与文字，在工作区中继续人工编辑。
- 打开和保存已明确挂载目录中的本地 PPTX 文件。

[OfficeHarness 接入参考](external-applications.md#officeharness)

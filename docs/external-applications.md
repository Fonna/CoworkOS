# 外部应用参考

中文 | [English](en/external-applications.md)

先安装对应软件、插件和运行环境，并完成[插件注册](../src/applications/plugins/README.md#外部插件目录仅注册)。在桌面版“应用”中选择入口，等待连接与视图就绪后发送请求；入口本身不安装依赖。

## Blender Harness

需要外部 Blender、已启用的 Blender MCP 插件和可用的 MCP 服务环境。桌面端会尝试启动 Blender，并将真实窗口放到 CoworkOS 旁边。

请求中写明对象、尺寸、材质和输出路径。例如：

```text
在当前场景中制作一个半径 1、高 2 的蓝色圆柱，命名为 sample-cylinder。保存 deliverables/sample-cylinder.blend，并导出同名 GLB。回复中列出实际保存路径。
```

外部场景按 Blender 自身的方式保存，不使用内置 Blender 编辑器的版本历史。

## FreeCAD Harness

需要外部 FreeCAD、已加载的 freecad-mcp 插件及其运行环境。先确认连接可用；桌面端会尝试启动 FreeCAD，并将真实窗口放到 CoworkOS 旁边。

可请求创建或修改文档，并用对象属性核对尺寸。例如：

```text
创建一块 50 × 30 × 5 mm 的平板，在中心开直径 8 mm 的通孔。核对外形与孔径，保存 deliverables/plate.FCStd 并导出 deliverables/plate.step，报告实际路径。
```

## CAD Harness

需要外部 CAD Harness、build123d/Python 建模环境和 CAD Viewer。桌面端在对话旁显示查看器，外部工具负责建模、检查和导出。

支持 STEP、STL、GLB、3MF 等交付格式。继续修改需要同时保留 `.step.py` 生成器和 `.step` 产物。各应用的入口与能力见[应用功能](applications.md)。

## OfficeHarness

需要已安装并注册的 OfficeHarness 插件及其运行环境。等待对话旁的 Impress 工作区加载完成，再编辑或发送修改请求。正在输入文字时，先结束编辑。

打开或保存本地 PPTX，需要明确选择并挂载所在目录。例如：

```text
打开我已挂载目录中的 report.pptx，把第 2 页标题改为“本周进展”，保留其他内容。另存为 report-revised.pptx，并核对保存路径和文件状态。
```

复杂表格、母版、动画和中文输入仍有兼容限制，交付前检查页面和保存结果。CoworkOS 自带的 PPT 编辑器见[PPT 编辑参考](presentation-workflow.md)。

## 保存与恢复

Harness 会话记录用于恢复连接，工程文件仍需由外部软件保存。备份时保留文档与素材依赖。[组件管理](optional-components.md)只管理对应受管组件，不负责安装这些外部插件。

接入机制、路径和开发约定见[软件接入](software-integration.md#harness-应用)。

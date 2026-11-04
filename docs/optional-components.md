# 组件管理

[English](en/optional-components.md) | 中文

Mac App 自带 PPT 编辑器，并在首次启动后自动准备 CAD/Blender 资源及导入工具使用的 CadQuery/Python 和 Blender 运行时，无需另装 Python 或提供 GitHub 账号。下载期间可以继续普通对话，使用相关原生功能前需等待组件就绪。

“应用”面板提供文本、PPT 两个编辑器和四个 Harness 入口；已有 CAD/Blender 资源仍可打开和编辑。

各编辑器及外部应用入口见[应用总览](applications.md)。本页介绍 CoworkOS 管理的组件；Harness 所需的外部软件和插件需单独准备，见[外部应用](external-applications.md)。

## 组件范围

| 组件    | 准备方式                     | 使用指南                             |
| ------- | ---------------------------- | ------------------------------------ |
| PPT     | 随 App 提供，无需额外下载    | [演示文稿](presentation-workflow.md) |
| CAD     | 首次自动下载 CadQuery/Python | [CAD 建模](cad-workflow.md)          |
| Blender | 首次自动下载 Blender         | [Blender 场景](blender-workflow.md)  |

原生组件目前面向 Apple Silicon macOS，具体支持范围见发行说明。

Windows 可另行配置本机 WSL2 Blender 执行环境，见 [Windows Blender](windows-blender.md)。该环境不使用 Mac 组件安装器。

## 选择与恢复

在“设置 → 应用与组件”查看状态和下载进度，下载失败可重试，也可启用或停用组件。停用后不会自动重新启用；兼容的已安装组件会在 App 更新后继续使用。

首次准备需要网络和足够磁盘空间。需要离线使用时，提前在联网环境中完成安装；若发行说明提供离线完整包，也可选择该包。组件尚未就绪时仍能进行普通对话。

卸载只删除 CoworkOS 管理的组件，不删除文稿、任务或系统中的其他安装。PPT 编辑器缺失时，按提示重新安装 CoworkOS。使用自定义运行时遇到问题，见[组件路径与 CLI 命令](components-reference.md)。

## CLI 与源码开发

CLI 用户可手动安装组件；安装、启停和路径设置见[组件参考](components-reference.md)。

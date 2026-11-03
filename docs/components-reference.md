# 组件路径与 CLI 命令

中文 | [English](en/components-reference.md)

App 操作见[组件管理](optional-components.md)。

```sh
coworkos components list
coworkos components list --refresh
coworkos components install cadquery
coworkos components install blender
coworkos components install pptist
coworkos components upgrade cadquery
coworkos components cancel cadquery
coworkos components disable cadquery
coworkos components enable cadquery
coworkos components uninstall cadquery
```

安装会输出进度并等待完成；按 Ctrl-C 取消。失败后可重试，已有可用版本会保留。停用后需手动启用；卸载只删除受管组件，不删除系统安装或用户文件。

## 自定义运行时

`COWORK_CADQUERY_PYTHON` 和 `COWORK_BLENDER_EXECUTABLE` 可指定外部运行时，并优先于 CoworkOS 管理的版本。设置页会显示实际版本；路径无效时，先修复或撤销覆盖。

## 存储位置

组件默认位于 `~/.atria/components/`。`ATRIA_HOME` 修改整体数据根目录，`ATRIA_COMPONENTS_HOME` 仅修改组件目录。更新 App 会复用兼容组件；数据布局见[工作区与持久化](task-workspace-layout.md)。

构建和分发组件见 [Mac 发布](mac-release.md#公开组件发行)。

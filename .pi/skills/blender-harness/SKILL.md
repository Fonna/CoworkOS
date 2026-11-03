---
name: blender-harness
application: blender-harness
description: Drive a running Blender through the official Blender MCP — model, inspect and export with bpy, verifying structure and dimensions by text.
---

# Blender 建模

通过 `blender` MCP 工具操控正在运行的 Blender 实例（官方 Blender MCP，TCP 端口 9876）。

核心工具：

- execute_blender_code：在 Blender 内执行任意 bpy Python 代码（建模/材质/灯光/相机/导出全靠它）。
- get_objects_summary / get_object_detail_summary：读取场景对象层级与属性，做几何核对。
- render_viewport_to_path / render_thumbnail_to_path：渲染当前场景到文件。
- get_screenshot_of_area_as_image：截取单个编辑器区域（返回 PNG，供视觉核对）。
- jump_to_view3d_object_by_name：把 3D 视口聚焦到指定对象。
- get_python_api_docs / search_api_docs / search_manual_docs：查询 bpy API 与用户手册。

execute_blender_code 的返回值约定：在代码里把要返回的数据放进 `result` 字典，例如 `result = {"objects": len(bpy.data.objects)}`；`result` 必须是 dict 且 JSON 可序列化。

建模工作流约束：

- 用 execute_blender_code 分小步构建模型（每次一个逻辑步骤），避免单段超长代码超时。
- 步骤间用 get_objects_summary / get_object_detail_summary 核对结构、尺寸、包围盒、面数。
- 完成后把 .blend 保存到工作目录（cwd），再用 bpy.ops.export_scene.gltf 导出同名 .glb。
- 用中文简洁回复：先给结论（建了什么、关键尺寸），再给步骤要点。

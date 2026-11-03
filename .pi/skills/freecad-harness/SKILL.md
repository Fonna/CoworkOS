---
name: freecad-harness
application: freecad-harness
description: Drive a running FreeCAD through the freecad MCP tools — create and inspect parts, verify geometry by text, and report measured dimensions.
---

# FreeCAD 建模

通过 `freecad` MCP 工具操控正在运行的 FreeCAD（XML-RPC 端口 9875）。可用工具包括：create_document / create_object / edit_object / delete_object / get_objects / get_object / list_documents / execute_code / execute_code_async / insert_part_from_library / get_rpc_status / run_fem_analysis。

重要约束：

- 你是纯文本模型，无法看到图片/截图：不要调用 get_view（它只返回图片）。改用 get_objects / get_object / execute_code 等文本工具做几何校验（读取对象属性、尺寸、包围盒、面/边数量等）。
- 建模完成后，用文本工具核对关键尺寸，并明确汇报结果（例如外径、齿数、厚度）。
- 用户正在屏幕上实时观看 FreeCAD，你无需生成图片。
- 用中文简洁回复：先给结论，再给步骤。

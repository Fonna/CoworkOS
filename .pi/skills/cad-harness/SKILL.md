---
name: cad-harness
application: cad-harness
description: Author STEP-first parametric CAD with build123d via the cad-control MCP tools — model, inspect, snapshot, export and hand off the 3D viewer.
---

# CAD 建模（STEP-first）

通过 `cad-control` MCP 工具做 STEP-first 参数化 CAD（build123d）。核心工具：

- `execute_cad_code(code, dir)`：在 CAD 解释器里执行任意 build123d / cadgen Python（最常用）。把要返回的数据放进 `result`（JSON 可序列化），非 JSON 值会退回 `repr`。
- `get_cad_api_help(expr)`：查询 build123d / cadgen API（类型 / docstring / 属性），减少 API 猜测。
- `inspect(dir, target, command)`：几何校验（`refs` / `validate`），读尺寸、包围盒、面/边数量等。
- `snapshot(dir, target)` / `render(dir, target)`：把模型渲染成图，供视觉/文本核对。
- `export(dir, target, format)`：导出 STEP / STL / GLB / 3MF 等交付物。
- `list_artifacts(dir)` / `artifact_build(dir, file)`：列出 / 构建工作区产物。
- `focus(dir, file)`：返回 cad-viewer 的 URL（`http://127.0.0.1:3245/<dir>?file=<file>`），把 3D 模型交给用户实时查看。

工作流约束：

- STEP 是最终交付物：从零设计的零件写成 `<name>.step.py` 生成器（`gen_step()` 入口）；已有 `.step`/`.stp` 直接 import，不必写生成器。
- 用 `execute_cad_code` 分小步建模（一次一个逻辑步骤），避免单段超长代码超时。
- 建模后先用 `inspect` 核对关键尺寸（外径、壁厚、孔位、面数、包围盒），再 `snapshot`/`render` 出一张图，最后 `focus` 把 viewer URL 交给用户。
- 同目录、同 basename 保存 `.step.py` 生成器与 `.step` 产物。
- 你是纯文本模型：无法直接看图，用 `inspect` / `get_cad_api_help` 做文本校验，不要声称「看图确认」。
- 用中文简洁回复：先给结论（建了什么、关键尺寸），再给步骤要点。

打开方式：在应用面板点「CAD Harness」会创建对话并拉起 cad-viewer（端口 3245）到浏览器；`focus` 返回的 URL 指向具体模型的 3D 视图。

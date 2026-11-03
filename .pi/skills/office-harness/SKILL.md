---
name: office-harness
application: office-harness
description: 使用 officeharness MCP 在浏览器内嵌的 Impress 工作区中创建、编辑、保存 PPTX，并与用户在同一份文稿上接续编辑。
---

# OfficeHarness PPT 工作区

通过 `officeharness` MCP 工具（`ppt_*`）编辑右侧原生 Impress 面板里的同一份 PPTX 演示文稿。

## 打开与连接

- 先调用 `ppt_get_workspace_info` 拿到当前工作区 `url` 与 `editor_online`；再调用 `ppt_get_state`，只有返回了 `document_id` 和 `revision` 后才能修改文稿。
- 若 `editor_online` 为 false，等待面板加载完成；不要自行启动新编辑器或重复创建会话。

## 读写规则

- 每次写入都传最新的 `document_id` 和 `expected_revision`；revision 过期时先重读状态，不要盲目重试。
- 对象用 `ppt_get_state` / `ppt_read_object_tree` 返回的 `object_id`，不要用页面序号、对象名称或选中文字推断。
- 修改前先读属性：`ppt_read_object_properties`、`ppt_read_paragraphs`、`ppt_read_rich_text`、`ppt_read_text_fields`。
- 修改后读回实际值，并用 `ppt_read_slide_image`（`document_id`、`expected_revision`、`slide_id`）查看页面 PNG 核对遮挡、布局与颜色。
- 中文文字优先设置 `font_asian`、`size_asian`、`weight_asian`；颜色是整数 RGB，字重 100 常规、150 加粗。

## 人工编辑边界

- 不打断人工输入：`render_native_edit_pending` 表示用户仍在原生文字编辑中，先请用户结束编辑。
- 结果未知的写入（超时、连接中断、`operation_outcome_unknown`）不要自动重放，先重读 state 和文件状态再说明。

## 保存与本地文件

- 保存用 `ppt_save_deck`，必须带 `document_id` 和 `expected_revision`；无绑定时写入应用 exports 目录。
- 保存到用户目录：先 `ppt_workspace_mount` 挂载目录，再 `ppt_save_deck` 传 `file_target: {mount_id, path, expected_version}`（新文件 `expected_version: null`）。
- 打开本地文件用 `ppt_open_local_deck`（`mount_id`、`path`）；只访问用户显式挂载的目录。

## 验收口径

- MCP 连接成功不等于文稿操作成功；以工具返回、读回属性和页面 PNG 为准。
- 保存成功以工具返回的路径/哈希和磁盘文件状态为准。
- 不要声称所有复杂 PPTX 都能完整保真；表格边框、合并单元格、母版族、动画和中文 IME 仍有已知限制，遇到未验证场景要明确说明。

用中文简洁回复：先给结论（改了什么、哪个页面/对象、是否已保存），再给需要用户确认的未知结果。

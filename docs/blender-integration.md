# Blender 工作台

Blender 工作台可在现有 Web/Electron 界面中显示三维场景，支持对象点选、局部位置/旋转/缩放、名称与基础材质编辑。它还支持 bpy Python 建模、源码草稿、参数、撤销、真实渲染和 `.blend` / GLB / PNG / Python 导出。工具职责、参数、兼容语义和后续扩展见 [接口契约](blender-api.md)。原生 Blender 插件和实时未保存场景同步仍在后续范围。

## 运行

原生执行隔离支持 macOS；安装脚本提供 Apple Silicon 的 Blender 4.5.11 LTS。应用先检查组件停用策略；显式 `COWORK_BLENDER_EXECUTABLE` 始终优先。完整桌面包随后只选择内置 `Resources/blender/Blender.app`，缺失时提示修复，不回退旧用户版本。开发、CLI 与内部基础包按顺序检查受管 `~/.atria/components/blender/versions/`、旧用户目录 `~/Library/Application Support/Atria/runtimes/blender/Blender.app`、项目 `.tools/blender-runtime/Blender.app` 和 `/Applications/Blender.app`。`COWORK_BLENDER_RUNTIME` 可覆盖用户运行时目录。使用 Blender 自带的 Python，不依赖系统 `bpy` 包。

```sh
npm run blender:setup
npm run ui
```

默认 Mac 包把官方 Blender 运行时内置在 `Resources/blender`，通过独立进程执行，随 CoworkOS 整体升级。用户在“设置 → 应用与组件”查看状态、启用或停用；缺失时点击“在设置中安装”进入修复说明，当前需重新安装完整 CoworkOS 包，不要求提供私有仓库下载凭据。

CLI 与 `npm run blender:setup` 保留受管安装服务，写入用户组件目录，不需要管理员权限，升级 CoworkOS 后保留。安装脚本下载固定版本并核对固定 SHA-256，官方服务不可访问时可使用同一校验值验证的 Berkeley 镜像。后端退出会中断安装，重新安装可复用已校验的下载。也可自行安装 `/Applications/Blender.app`，或显式指定可执行文件；失效的显式覆盖需修复或撤销。其他 Blender 版本需要单独兼容性验收。官方来源：[4.5 下载目录](https://download.blender.org/release/Blender4.5/)、[Python API](https://docs.blender.org/api/4.5/)。

无需 Blender 也可打开工作台、创建工程、保存/恢复源码草稿；需要真实建模、原生导入或渲染时显示缺少运行时的错误。

## 编辑与 Agent 工作流

从应用面板打开 Blender，创建空工程；也可以由对话调用 `create_resource` 创建 `project/atria-blender+json`。新建不预置样例。工程创建后复用既有窗口、资源引用和绑定；下一次模型请求即可看到 Blender 领域工具及 `.pi/skills/blender`。

人工对象属性在本地草稿中调整，保存后执行候选修改并更新三维场景。源码可独立保存，即使 Python 不可运行也不丢失；“运行并保存场景”才执行代码。默认加载当前场景，运行源码后调用可选 `main(p)`。参数支持嵌套 JSON，顶层字段显式覆盖，保持其他人工参数。临时修补可使用 `saveSource=false` 保留建模草稿。“运行前清空场景”必须显式选择。重复运行时，代码应查找已有命名对象或稳定 ID，避免不断新增副本。位置为 Blender 场景单位，旋转为度，变换是对象在父节点下的局部变换。

Agent 使用 `blender_read_scene` → `blender_run_python` 或 `blender_apply_operations`。后两者声明 `requiresFreshRead`，同资源调用由既有 Pi 桥接串行；最终提交仍检查 revision。成功返回实际求值后的对象/三角面/包围盒、诊断和原生 PNG；图像仅在连接声明图像输入时投递，纯文本连接明确标识未投递。`blender_read_scene` 支持对象过滤/分页；`blender_query` 在原生副本中查询任意 bpy 数据并返回 JSON，不保存副本修改。API/查询/预览不能替代修改前的场景读取。其他工具为 `blender_preview`、`blender_render` 和 `blender_get_api_reference`。通用 `export_resource` 生成真实任务产出物。

`.blend` 导入上限为 64 MiB，须预先打包贴图、本地化链接库；读取禁止自动执行文件内脚本。导入生成候选快照，版本冲突或失败不提交；原始上传文件不会被修改。导出 `.blend` 包含完整场景和打包依赖。GLB 是用于工作台和引擎交换的派生文件，其修改器求值、材质转换等行为与完整 Blender 场景有区别；完整工程不会经 GLB 反向重建。

## 保存与恢复

参数 JSON 校验失败时保留原始输入并写入本机草稿；刷新后仍可修复，不会用 `{}` 覆盖错误内容。参数无效时禁止保存和运行，避免把上次解析成功的参数误当作本次输入。保存结果待确认期间禁用源码和参数编辑；有改动时重命名先完成保存。320/474px 窄窗口将代码区放在模型视图下方，整个工作区可滚动，运行、参数和底部关联动作保持可达。独立工程的关联入口复用工作台的对象参数协议。

工作台的 UTF-8 `*.blender.json` 是工程清单，包含版本、工程 ID、快照 ID、建模源码草稿和参数。清单继续使用原有 v1 文件、数值 revision、CAS 和事务日志；二进制场景独立存储。原生场景由 [BlenderProjectProvider](../src/software/blender/project-provider.ts) 的软件 v2 `project` 驱动管理：

```text
applications/blender/files/<title>.blender.json
applications/blender/resources/<resourceId>/metadata.json
applications/blender/resources/<resourceId>/operations.jsonl
applications/blender/projects/<projectId>/snapshots/<snapshotId>/
  scene.blend
  preview.glb
  render.png
  snapshot.json
```

v2 `read` 返回当前目标的文件及内容 hash 清单；`apply` 生成新的不可变目标版本，清单提交才选择这个新版本。原生执行在临时候选中进行，成功后原子发布快照目录，再由现有 ResourceStore 的持久事务更新工程清单。`validateOperation` 在资源锁内校验原生快照；异步建模不占用资源锁。人工保存期间，旧候选不能覆盖新 revision。

快照 ID 由原生文件 hash、规范化场景报告和建模信息计算，读取报告校验 ID，读取二进制校验完整 SHA-256。拒绝符号链接、越出项目根目录的目标、伪造工程身份和损坏快照。撤销追加一次恢复操作并指向已有快照；源码与完整场景一起恢复。中断的候选不会成为当前版本。生成成功但未提交的候选也可能留在快照目录，自动垃圾回收尚未实现；每个工程原生快照总量有 1 GiB 预算，接近预算时拒绝新生成并提示备份。

重启后从清单和快照恢复。网络结果待确认时，工作台保留操作 ID，重试已提交的命令不会重新执行建模；冲突保留源码和对象草稿，并提供备份/重新载入。原生导入的文件字节不会放入浏览器草稿存储；导入被中断时应重新载入确认保存状态，再重新选择文件。

工程备份必须包含整个 `applications/blender/`，或下载原生 `.blend`；单独复制工作台清单不是可移植的 Blender 工程。清单与原生项目是共享应用资源，多个对话只是引用，删除对话不会搬走原生工程。

## 执行与边界

执行器使用独立 Blender 进程、macOS OS 隔离、限定的文件读写路径、最小环境、关闭网络及文件自动脚本、任务时限和内存预算。macOS 的用户查询及 Metal 初始化需要限定的系统 Mach/IOKit 访问；不能直接复制 CadQuery 的配置。模型 Python 不能读取用户/工作区文件、继承模型凭据或执行任意宿主命令，相关拒绝路径由原生权限回归验证。隔离仅覆盖 Blender 执行路径，既有 bash/jobs 等路径保留各自权限语义。

源码上限为 256000 字符，场景最多 1000 个对象、200 万求值三角面，单文件输出上限为 128 MiB，进程 RSS 上限为 2 GiB。运行时限可设为 1 至 600 秒；建模、编辑和导入默认 180 秒，独立渲染和 PNG 导出默认 300 秒，只读查询默认 60 秒。工作台与 Agent 工具使用同一份时间策略；复杂场景可选择 600 秒，不需要降低模型或渲染精度。用户取消会立即终止候选进程，失败和超时不提交工程。

快速预览是 384 像素/8 samples 的 CPU Cycles 图；单独渲染可选择 64 至 2048 像素及 1 至 128 samples。临时自动构图相机和灯光只用于渲染，不写回已保存场景。有保存相机时使用它及现有灯光。渲染支持相机 ID/名称、指定帧、矩形 width/height 和降噪，覆盖只作用于本次副本。

PNG 导出接受相同选项，并独立重渲染；未传选项时使用 768×768、32 samples，不沿用先前预览或保存场景的渲染分辨率。需要特定尺寸与采样数时，在 `export_resource` 的 `options` 再次传入；成功结果的 `width`、`height` 来自实际 PNG 文件。

当前只提供对象级编辑和基础 Principled 材质；复杂拓扑、动画、节点、骨骼通过 bpy 或原生 Blender 处理。GLB 预览关闭动画播放。暂未提供原生窗口嵌入、Blender 插件、实时未保存编辑协调、GPU 渲染、远程 Worker、跨平台执行隔离和磁盘垃圾回收。

## 开发入口

- 模型与预算：[model.ts](../src/software/blender/model.ts)
- 原生生命周期/隔离：[engine.ts](../src/software/blender/engine.ts)、[runner.py](../src/software/blender/runner.py)
- v2 工程与 hash：[project-provider.ts](../src/software/blender/project-provider.ts)
- 工作台桥接/工具：[blender-runtime-adapter.ts](../src/applications/adapters/blender-runtime-adapter.ts)
- UI/草稿/视图：[blender-editor.js](../web/assets/workbench/adapters/blender-editor.js)、[document-session.js](../web/assets/blender/document-session.js)、[viewport.js](../web/assets/blender/viewport.js)
- 实际原生、HTTP、Pi 与浏览器验证：[blender-application.test.js](../test/blender-application.test.js)、[blender-bootstrap-pi.test.js](../test/blender-bootstrap-pi.test.js)、[blender.spec.js](../e2e/blender.spec.js)

组件状态、路径覆盖、桌面修复与进阶受管安装的生命周期见 [应用与组件](optional-components.md)。

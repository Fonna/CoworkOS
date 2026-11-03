# Blender 接口契约

状态：现行接口。消费者是 Pi 应用桥接、工作台 UI 和资源命令 HTTP；实现见 [Adapter](../src/applications/adapters/blender-runtime-adapter.ts)。运行、存储与安全边界见 [Blender 工作台](blender-integration.md)。本页区分已经实现的契约和后续扩展，不能据此声称超出当前预算的场景已经验收。

## 设计原则

完整 `.blend` 是原生工程的权威来源。Harness 管理工程身份、版本、执行、取消和产出物；Blender 管理拓扑、材质节点、Geometry Nodes、集合、骨骼、约束和动画。GLB、PNG、对象摘要是派生视图，不是能力上限，也不用于反向重建原生工程。

核心接口只有四种职责：读取当前状态、查询原生数据、执行修改、渲染检查。复杂能力通过完整 bpy 表达，不再添加 `create_chair`、`add_room` 或一套与 Blender 平行的建模 DSL。对象属性编辑、缓存预览和 API 文档查询是快捷接口；原生导入、导出、历史和资源绑定复用 Harness 通用协议。

| 职责             | 工具                        | 写入工程                         | 结果                                                                     |
| ---------------- | --------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| 当前状态与定位   | `blender_read_scene`        | 否                               | revision、snapshot、参数、可选源码、对象分页、全场景统计、选区、运行预算 |
| 任意原生数据查询 | `blender_query`             | 否；副本中的修改全部丢弃         | 固定 revision/snapshot 的 JSON value 与 print 诊断                       |
| 完整 bpy 修改    | `blender_run_python`        | 成功后一次原子提交               | 新 snapshot、真实场景、诊断、原生预览图                                  |
| 视觉检查         | `blender_render`            | 否；相机/帧/渲染覆盖只作用于副本 | 固定 revision/snapshot 的原生 PNG 图像                                   |
| 对象属性快捷修改 | `blender_apply_operations`  | 成功后一次原子提交               | 与 Python 修改相同的提交语义                                             |
| 缓存预览         | `blender_preview`           | 否                               | 已保存预览与真实几何报告                                                 |
| 运行时文档       | `blender_get_api_reference` | 否                               | 安装版 bpy / bmesh / mathutils 文档                                      |

## 身份、读取与提交

`resourceId` 是 Harness 的共享资源引用，`projectId` 是原生工程身份；重命名不会改变它们。数值 `revision` 用于协作 CAS；内容 hash `snapshot` 标识不可变原生快照。对象 `atria_id` 用于跨命名、查询与属性修改定位。对象名称适合 bpy 脚本，但重命名后可能变化；相机可使用稳定 ID 或精确名称。位置与尺寸使用场景单位，Inspector 旋转使用度，变换相对于父级；bpy 自身的角度仍使用弧度。

`blender_read_scene` 无参数可调用。对象默认分页为 100 项，支持 `ids`、大小写不敏感名称子串 `name`、精确 Blender 对象类型 `type`、`offset`、`limit`（1–1000）。`objectCount` 是全部对象数量，`matchedCount` 是过滤后的数量，`nextOffset=null` 表示结束；`triangles`、`bounds` 始终为全场景统计。`includeSource=false` 省略建模源码。`interfaceVersion=2` 与 Adapter version=2 标识分页读取契约，不改变工程清单 version=1。修改与缓存预览工具也返回相同的前 100 对象投影，避免执行后把完整对象列表再次塞入上下文；其余对象用读取工具获取。工作台的原生报告保持完整，不经过 Agent 分页。旧版读取接口无分页，依赖一次读取全部对象的工具消费者应检查 interfaceVersion 并遍历 nextOffset；旧读取参数仍可调用，旧存储、UI 报告、修改命令和导出选项兼容，无需工程数据迁移。

分页属于某个 revision。下一页 revision 改变时应从第一页重读，不能把不同版本的页面拼成同一个场景。大量对象与材料的细节用 `blender_query` 投影所需字段，不向模型塞入完整 `.blend` 或所有节点树。

Pi 本次运行的首次修改前必须调用声明的场景读取入口。API 查询、缓存预览、原生查询都不能刷新这个修改前提；用户在读取后保存时，修改被拒绝并返回重读入口。Python 在锁外构建候选，提交时仍检查 revision。失败、超时、取消或冲突不替换原生工程；已经提交后取消不能撤回已完成的提交。HTTP 修改使用既有 `baseRevision` 与 `operationId`，幂等重试不会重新执行已提交的代码。错误沿用 Harness 的 `code`、`message`、`details`，不解析日志判断是否成功。

## Python 与参数

脚本在独立进程中加载当前保存场景，顶层代码执行后调用可选 `main(p)`。可使用完整 bpy、bmesh、mathutils 和 Blender 内置 Python 库。`resetScene` 默认 false；只有明确要求整体重建才清空。重复运行应定位或复用对象，保护无关对象和人工修改。

`parameters` 是 JSON 对象，支持嵌套对象、数组、null、有限数值、字符串与布尔值。顶层键必须为字母开头的标识符；最多 100 个顶层键、8 层嵌套、64000 字符、每个容器最多 1000 项。更新只覆盖明确提供的顶层键，不做隐式深层合并；例如传入新的 `layout` 就替换整个 `layout`。旧的标量参数保持相同含义，旧清单无需迁移。

`blender_run_python` 省略 source 时使用保存草稿；默认保存所运行的源码。临时修补使用 `saveSource=false`，代码仍修改原生工程，但不替换建模草稿。参数仍遵循显式合并语义。运行失败不会保存这次代码；工作台另有保存草稿操作，可保存尚不可运行的源码。

```json
{
  "source": "bpy.data.objects['Desk'].modifiers['Bevel'].width = 0.025",
  "saveSource": false
}
```

`blender_query` 要求 source，在当前已保存场景的副本中执行；`main(p)` 的返回值或全局 `result` 必须为 JSON。默认时限 30 秒。返回最多 64000 字符，JSON 同样限制嵌套和容器大小；不接受 bpy 对象、NaN、Infinity。查询不会保存源代码、参数、临时场景修改，也不运行保存草稿。它提供宿主层面的不提交保证，不声称 Python 内的 bpy 只能读取。

```python
def main(p):
    obj = bpy.data.objects['Desk']
    return {
        'modifiers': [{'name': m.name, 'type': m.type} for m in obj.modifiers],
        'materials': [m.name if m else None for m in obj.data.materials],
        'nodes': [n.bl_idname for n in obj.active_material.node_tree.nodes],
    }
```

## 渲染与交付

`blender_render` 与通用 PNG 导出接受相同 options：`camera`、`frame`、`width`、`height`、`samples`、`denoise`、`timeoutSeconds`。不指定相机/帧时使用保存状态；只有场景没有相机时才自动构图并添加临时照明。不覆盖已保存的透明背景设置。临时相机、帧与渲染设置不写回 `.blend`。

旧的 `resolution` 仍表示正方形画幅，默认 768；与 `width`/`height` 互斥，矩形的两个维度必须一起提供。分辨率 64–2048，默认 32 samples，范围 1–128；渲染默认时限 120 秒，所有任务最多 300 秒。多个机位按独立调用执行，每张结果标明对应 snapshot，可用于逐视角反馈；当前不是动画渲染或异步任务服务。

```json
{
  "camera": "Interior",
  "frame": 24,
  "width": 1280,
  "height": 720,
  "samples": 64,
  "denoise": true,
  "timeoutSeconds": 180
}
```

模型支持图像输入时返回原生图片块，纯文本连接明确报告未投递，不能声称进行了视觉验收。通用 `export_resource` 产生实际 `.blend`、GLB、PNG、Python 文件；图片工具反馈不能替代可下载的交付文件。`.blend` 保留完整节点、动画和依赖，GLB 是受该格式表达能力约束的派生文件。

## 扩展边界与后续约束

接口不按场景题材限制 bpy；当前执行实现仍有 1000 对象、200 万求值三角面、2 GiB RSS、单文件 128 MiB 和工程历史 1 GiB 的预算。快速 GLB/PNG 生成目前是候选成功条件，只有相机、材质或暂时没有网格的中间场景还不能提交；外部贴图和库必须已嵌入导入的 `.blend`。这些是扩大工程规模前必须解决的实现约束，不能靠放宽工具描述宣称已支持。

后续扩展维持上面四个职责，优先补足以下宿主能力，而不是增加更多建模工具：

- **可信资产接入**：宿主导入、校验并复制资产，给脚本提供 job 内受控路径。外部请求使用 assetId，不接收任意宿主路径；记录来源与内容 hash，打包依赖。素材库、HDRI、贴图和字体都走同一条路径，不开放脚本的网络和用户目录。
- **独立派生产出**：原生工程提交与 GLB/PNG 生成分离。每份派生文件显式记录 snapshot、生成参数与 ready/failed 状态；预览失败不丢失成功的原生修改。UI 和附件消费者必须处理缺失/失败状态，旧快照兼容读取。纯材质、骨骼、相机等中间工程应能保存。
- **持久长任务**：4K、动画、多机位批量通过统一任务服务排队，提交固定 snapshot，返回 jobId；观察、取消、日志、部分产出与重启恢复复用同一作业协议。任务的结果不能偷偷切换工程 revision。CPU/GPU/远程 Worker 是执行配置，不改变 bpy 建模语义。
- **规模配置**：运行预算由宿主配置并通过读取接口发现，区别源场景、求值几何和派生产物的限制；提供磁盘回收与历史保留策略。不能让模型自行绕过内存、时间和资产边界。
- **引擎交换**：引擎适配器消费固定 snapshot 的导出及明确的材质、单位、实例、相机与交互元数据；完整项目保留在 Blender。动画、碰撞和交互不能假定一次 GLB 导出已等价转换。

以上五项尚未实现；当前提供四类核心接口及协作保护。原生插件、实时未保存编辑同步也仍在后续范围。

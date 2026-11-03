# 参数化 CAD

## 装配与运动链路

CadQuery 的 cq.Assembly 保留父子层级、稳定路径、父坐标系中的刚体矩阵及继承颜色，并逐零件返回有效实体数、面数、体积和静止包围盒。STEP 用原生装配导出，保留层级/名称/颜色/静止放置；非装配输出也包装为具名 STEP 装配，STL 仍为静止网格。旧 Python/JSON、JSCAD 及 version:1 文件兼容，不迁移既有内容。

可选 get_motion(p) 返回 duration/tracks，由现有 cad_run_program 一次计算和校验后提交。平移与轴角旋转使用父坐标系增量，局部变换为 T(translation)·T(pivot)·R(axis,angle)·T(-pivot)·restLocal；角度为度，连续角度保留多圈旋转。子装配继承父运动。节点最多 2048/32 层，轨道最多 256，每轨道最多 1024 帧/合计 16384 帧，周期最多 3600 秒。验证目标、有限数值、刚体矩阵、非零轴、严格递增时间和一一对应的关键帧；无效候选不提交。轨道格式验证不等于运动学/无干涉验证，工程要求仍用 assert/print 检查。没有新增任意前端代码执行或文件/网络权限。

源码查看器使用独立零件网格和装配场景树，播放时只更新变换，不逐帧重建 CAD。部件树可搜索、显隐和隔离；观察支持实体/透明/线框、爆炸比例、XYZ 剖切、播放/暂停/时间拖动/倍速和当前视图 PNG。选择保留完整 path，源码返回顺序变化后可重新映射。观察操作不写源码、参数或文档版本；源码尚未更新/失败时暂停运动并禁用检查控件，避免旧模型作为新验证依据。旧基础形体编辑手柄仍使用原有视口路径。

模型仍只需要 cad_read_model/cad_run_program/cad_preview/cad_get_api_reference。module:"Motion" 返回 harness 契约、坐标顺序、预算及可运行示例；cad_preview 的可选 view 支持 timeSeconds/paths/explode/section，输出对应的真实四视图及派生网格包围盒。顶层精确指标仍是静止几何。派生视图与失败视图不污染基线缓存；changeSummary 可区分装配或仅运动变化。cad_read_model 不重复传输相同几何报告。模型 skill 按需说明如何验证行程/端点/相位；未修改通用任务规则或模型视觉声明。

验收样例 test/fixtures/cad-inline-four.py 是可参数化四缸曲柄/连杆/活塞机构，含透明缸套、21 个独立部件、26 个装配节点和 13 条运动轨道。用于验证 720° 周期、36 mm 默认行程、连杆端点闭合与树/颜色/放置的 STEP 往返；它不是完整可制造汽车发动机。自动测试位于 test/cad-assembly.test.js 与 e2e/cad-assembly.spec.js。

## 交互与建模诊断

新建 CadQuery/JSCAD 文件使用空工程，不预置带孔支架、圆柱或尺寸参数。编辑器显示「尚未生成模型」，首个设计生成后再显示实体；显式提供初始源码的文件仍显示其真实内容。空实体数组可预览为空状态，不声称 BRep 有效；STEP/STL 导出和 Agent 的 cad_run_program 提交仍要求有效非空实体。已有文件内容不迁移、不清空。

默认界面只保留模型视图、观察方向、显示完整模型、尺寸参数、保存和文件导出。部件列表由「部件」按钮展开；代码面板包含手动更新及生成时限，内核/体积/实体信息在「模型信息」展开。参数修改自动更新显示，代码离开输入框后自动更新；显示更新不等于保存，保存或 Command/Ctrl-S 后才同步人工修改到 Agent。失败保留草稿并明确显示上次模型，提供重试。源码本身仍能独立保存/下载/撤销。

打开工程不自动选择第一个部件，默认以正常材质显示；点击部件才高亮，点击空白处清除选区并同步对话上下文。源码更新后失效的选区也清除，不擅自选中另一个部件。

文件导航只显示在当前会话的工作区顶栏；放大与恢复并排共用同一按钮，右上角侧栏按钮统一收起或恢复工作区。需要进入对话协作时，从工作区更多菜单选择「在对话中使用」。收起工作台只改变布局，不删除文档或更改绑定。布局行为不改变应用无关的任务规则。

CadQuery 的 print 输出作为有界 diagnostics 返回（最多 4096 字符），错误及成功计算都可检查局部尺寸/体积；assert 可让建模要求不满足的候选失败，阻止保存。cad_run_program 从已有预览缓存获得基线并返回 changeSummary，不为对比额外运行旧源码。源码/参数变化但尺寸、体积、实体/面数及包围盒指标相同会提示模型检查；它不拒绝合理的代码重构，也不宣称这些指标是几何等价证明。内核 API 查询提供 Plane 及运行时取得的六个命名平面基向量，可用于核对坐标方向。所有这些规则和计算仍在 CAD 模块/skill 中，TXT 不加载几何依赖。

模型的设计能力仍需实测。复杂设计质量应结合真实需求和已验证的视觉反馈评估，内核验证有效不能证明专业设计质量。

## Agent 接口与应用隔离

新 CadQuery 文档只启用 cad_read_model、cad_run_program、cad_preview、cad_get_api_reference 四个领域工具。源码文件不展示旧基础形体工具；JSCAD 仍保留原源码保存接口，旧 version:1 仍可升级。工具名称来自当前文件内容，context-builder 与 boundCapabilities 使用同一集合；重绑 TXT 后立即停用 CAD 工具，普通任务与通用工具不受绑定规则约束。

cad_run_program 接收可选 source/parameters/engine/timeoutSeconds：只合并显式参数覆盖，候选验证通过才返回一次版本操作。失败、空实体和取消不覆盖已保存设计；计算期间发生人工修改时 CAS 拒绝提交，模型应读取最新设计后合并重试。人工编辑器仍允许独立保存错误源码以便修复；这是草稿保存，不是模型完成验收。

skill 主文件只路由工作流，Python/JSCAD/旧形体细节位于 references/ 并按实际文档格式加载。JSCAD 的宿主 API 目录与依赖改为查询时加载；普通 TXT 启动、保存不会加载 JSCAD/QuickJS/Three.js。原生计算仍在受隔离的子进程中，超时后 TXT 保存及通用任务可继续。

通用 export_resource 调用所属 adapter 导出，并通过已有 Artifact Store 写入当前任务产出物，返回真实路径和元数据。它不修改绑定、资源或标签；不把二进制/base64 放入模型上下文。STEP 导出需要 CadQuery，格式由各应用声明，不在通用工具硬编码 CAD。

当前支持 CadQuery 2.6.1 / OpenCascade 精确实体引擎，新设计默认 `model/atria-cadquery+json`。应用 ID 仍为 `cad`；JSCAD 和旧基础形体文件继续兼容。

## CadQuery 精确实体路径

开发环境执行 `npm run cad:setup`（macOS arm64，需要 uv），下载独立 CPython 3.11.15 并按带哈希的锁文件安装依赖到 `.tools/cadquery-runtime`。不修改系统 Python。默认 `desktop:pack` / `desktop:dist` 生成小包，App 首次启动后自动准备 CadQuery，用户在“设置 → 应用与组件”查看状态；显式离线完整包内置 `Resources/cadquery`。旧内置、受管安装和显式 Python 路径继续兼容；CLI 的 `coworkos components install cadquery` 保留为进阶命令，见 [应用与组件](optional-components.md)。原生内核目前仅在 macOS 启用，其他平台缺少操作系统隔离时拒绝执行，JSCAD 继续可用。

新资源默认创建 Python 工程，定义 `main(p)` 和 `get_parameter_definitions()`，返回 Workplane/Shape/Assembly 或命名实体数组。模型可直接使用完整 CadQuery API，不通过基本形体枚举。`cad_get_api_reference` 查询真实安装类/方法签名和说明，`cad_run_program` 一次验证并提交完整源码/指定参数，返回真实四视图；`cad_preview` 仅检查已保存工程。尺寸/体积和 BRep 有效性来自 OpenCascade；网格只负责展示。

预览保留默认线性/角度公差 0.1/0.1，不因模型复杂而自动降低显示精度、不省略零件。单部件及全模型分别允许最多 1,000,000 个三角形；线性公差为相对偏差，角度以弧度计。成功结果中的 `tessellation` 返回实际 `linearTolerance`、`angularTolerance` 和 `adjusted:false`。精确尺寸直接从 BRep 计算，体积和 STEP 不依赖显示网格。超过硬上限、无效几何及源码断言仍明确失败，`cad_run_program` 不提交候选；此时导出针对已保存设计。统一限制由 [计算策略](../src/software/cad/compute-limits.ts) 定义，回归见 [原生网格与 STEP](../test/cad-native.test.js)、[计算预算](../test/cad-compute-limits.test.js) 和 [显示元数据](../test/cad-tessellation.test.js)。

`engine` 支持 cadquery/jscad。源码保存、历史和 CAS 共用原有协议；失败的 Python 源码也能保存、读取、下载和撤销。改变引擎需要显式指定 engine 并重写完整源码；不会自动翻译任意 JavaScript，也不会给已有文件创建重复标签。

Python / JSON 导出不执行源码；STEP / STL 重新计算精确实体后导出。STEP 路径不做预览三角化，所以不受显示网格数量限制。STEP 保留实体/曲面，不保留 Python 建模过程和参数历史；后续参数化修改使用 Python/JSON。原生装配可作为建模结果显示和导出，尚未提供工作台草图约束、交互装配约束或二维尺寸工程图。

Python 在独立进程运行，macOS sandbox-exec 默认拒绝访问，仅允许读取运行时、脚本、系统库和临时目录；禁止用户/工作区文件读取、网络和任意宿主程序，环境不继承模型凭据。每次新建进程，CPU/文件/描述符限制、父进程壁钟超时与 2 GiB RSS 监控；最多同时执行两个计算，另允许十六个排队。

排队最多等待 600 秒，入队等待不消耗获准后的计算时间；超时及取消移除排队任务或终止进程组，并清理临时目录。计算与四视图生成共用一次时限，不为每一阶段重置时钟。结果 JSON 上限 480 MiB，STEP/STL 文件上限 512 MiB，Python 文件大小限制同步到导出上限。服务退出也清理活动进程。此隔离独立于 Python 语言本身。显示结果仍验证有限数值、实体和网格预算，保存不受计算失败影响。

浏览器通过通用 Adapter previewResource 接口提交草稿，不写回资源，不污染修订；请求取消会中止后端工作。Three.js 渲染仍在原界面，已有 JSCAD 浏览器 Worker 不变。

## JSCAD 兼容路径

## 源码建模与人工协作

选区协议 `cad.program-solid/v1` 与 `cad.feature/v1` 使用 `{id}` 表示选中部件，使用空对象 `{}` 表示取消选择。点击视口空白处同步清除共享选区，Agent 收到“未选中模型部件”；选区变化不改变文档 revision。关联对话、重开编辑器或刷新网页后，从资源读回共享选区并恢复高亮。非法 ID 和非对象数据仍拒绝。

JSCAD 工程可显式选择 `model/atria-jscad+json`；工作台新建入口默认 CadQuery。它创建空源码工程，生成模型后按参数声明提供可编辑控件。Agent 先发现应用、创建资源，再 `cad_read_model → cad_run_program`，无需先打开工作台。源码采用 JSCAD 2 CommonJS，使用完整 `@jscad/modeling` API，`main(params)` 返回 geom3 或嵌套实体数组；可以表达轮廓旋转、拉伸、切片放样、曲线、布尔、凸包、函数、循环和程序化阵列，不再被三个基础形体枚举限制。`cad_get_api_reference` 返回实际安装内核的函数目录、类型声明、API 注释、官方文档和模板；指定 module/member 可直接查询准确签名，避免让模型猜测接口。

`getParameterDefinitions` 声明的数字、整数、文本、布尔和选项参数直接生成右侧控件。人调整参数后保存或 Command/Ctrl-S；建模过程可在“源码”修改。保存和计算分开，状态栏分别显示源码保存状态与几何是否更新。观察方向提供等轴、正面、右侧、顶部；计算预算可选 20/60/180/300/600 秒，CadQuery 默认 180 秒、JSCAD 默认 60 秒；超时后的重试会提升至下一档，最高 600 秒。失败时明确标记上次成功的旧预览，禁止从旧画面提交选区。源码实体任意拖动不能反向改写程序，位置/角度应声明为参数；旧形体模式仍有手柄。

Agent 每轮首次修改前读取文件；`cad_write_program` 的 `parameters` 省略时保留人工覆盖，参数调整用 `cad_set_parameters`。应保持参数名和返回顺序，改名时迁移覆盖值。源码和参数共用 CAS、幂等提交、历史和撤销；文档格式校验仍拒绝空源码、非法参数类型等错误。语法错误、几何错误和超时不阻止非空源码保存，模型必须区分“已保存源码”和“设计已验证”。`cad_read_model` 不运行程序，因此失败设计总能读回与修复。

保存后使用 `cad_preview({})` 按引擎默认时限计算真实几何并检查四视图；复杂设计可用 `timeoutSeconds:300` 或 `600` 延长时限，不必为满足预览修改保存的精度。反馈包含 revision/contentVersion、尺寸、体积、三角形数、各实体包围盒和 768×768 PNG（等轴/正面/右侧/顶部）。图片由实际网格经深度缓冲光栅化生成，不是生成式图片。原生图像块通过应用工具桥接传给 Pi，文字结果不携带 base64。空模型有明确提示；计算成功不等于工程正确。每个失败只影响派生预览，不新增资源版本。

模型连接默认按纯文本处理，避免向未知网关发送不支持的图片。确认模型与网关支持视觉时，网页配置文件设置 `supportsImages:true` 或环境变量 `COWORK_SUPPORTS_IMAGES=1`；Mac 的“模型连接”提供图像输入复选框。未启用时仍可使用文字几何诊断、下载四视图，但工具明确报告图片未投递，Agent 不能声称看过图片。每个连接应独立验证图片输入能力，再启用该声明。

旧文件工具读回包含 `editableSource`，保留特征 ID、尺寸和变换的完整 JSCAD 程序。点击“升级为源码建模”或让 Agent 基于它继续设计，会在同一资源、文件与工作台窗口中升级；不生成第二份同名文件。撤销升级可以恢复旧编辑器。存在未保存草稿时不自动切换编辑模式，保留本地设计并显示冲突。

工程 JSON 保存 `{version:2,engine:"jscad"|"cadquery",units:"mm",source,parameters}`。`.jscad` 导出不执行程序，包含保存的人工覆盖，保留源码内默认参数；错误源码也能下载。STL 和 PNG 从真实几何导出，失败提供原因。PNG 使用当前 UI 计算预算，通用下载接口的 `options` 由 Adapter 校验。导入 `.jscad/.js` 替换草稿并清除旧覆盖，保存后可撤销；完整工程可备份草稿。工程仍是 UTF-8 单文件，使用应用 v1 协议；文档版本 2 与软件驱动 v2 不同。

## 执行与能力边界

JSCAD 源码只在独立 QuickJS WASM 解释器执行，内核也在解释器中；没有桥接宿主函数、文件、网络、DOM 或 process。只允许 `require('@jscad/modeling')`，不支持额外包。单次解释器内存预算为 512 MiB、1 MiB 栈，默认 60 秒、最多 600 秒；源码最多 1 MiB UTF-8（文件导入、草稿恢复及工具采用同一字节限制），CAD 文档上限为 8 MiB，容纳 JSON 转义；最多 1024 实体，网格上限与原生路径一致。STL 字节预算为 512 MiB。浏览器使用可取消 Worker，加载与计算共用一次时限；旧形体不等待 WASM。

后端预览使用独立 worker_threads，Worker 老生代内存上限 1024 MiB，每个任务新建解释器，最多 2 个活动任务和 16 个排队任务；取消移除排队任务或终止活动 Worker。CPU 计算不会阻塞 HTTP 保存。

验证元数据缓存最多 16 份，以完整源码与参数哈希索引；完整成功预览最多缓存 8 份、256 MiB，重复打开或派生视图复用已验证网格，源码或参数变化重新计算。缓存不持久化网格/图片；进程重启后为 not_checked，而非误称已经验证。

曲面仍是分段网格，不承诺制造精度。数组体积为各实体体积合计，重叠部件应先合并再测整体净体积。JSCAD 路径不含 BRep/STEP；精确实体与 STEP 使用上面的 CadQuery 路径。当前工作台仍不含 DWG/DXF 导入、交互约束草图或二维尺寸工程图。模型可发挥完整 JSCAD 的建模能力，但任意格式的 CAD 源码不能由同一个内核执行；CadQuery/OpenCascade 已作为独立引擎接入；FreeCAD GUI 控制仍未实现。

## 旧基础形体模式（兼容）

从左侧“应用 → 参数化 CAD”打开窗口，再选择“基础形体（兼容模式）”。该模式支持添加长方体、圆柱和球体。新形体默认放在现有实体旁边，自动选中、调整视野并进入移动模式，避免被主体遮住。空模型的第一个形体仍放在原点。达到 64 个特征时禁用新增/复制，并显示原因；已有 32 个特征的模型可继续编辑和添加。

也可以在未绑定应用的新对话中直接要求创建 CAD，无需先打开窗口。Agent 通过 `list_applications` 获得应用的 `creationHint`，再调用 `create_resource`，省略 `initialContent` 即创建有效空模型。工具在返回前绑定资源并注册专用工具，结果报告 `editorOpened`、`bound`、`availableTools` 和 `nextAction`；应用声明的 `entryReadTool` 使下一次模型请求明确从 `cad_read_model` 开始，再调用 `cad_edit_parts`。CLI 没有标签存储时仍绑定并启用工具，但不声称编辑器已打开。

`initialContent` 支持文本字符串或结构化对象；CAD 初始模型为 `{version:1,units:"mm",parts:[]}`，兼容该格式的序列化 JSON 字符串。未知字段及无效参数仍拒绝。通用操作 `payload` 在模型接口中明确为对象，避免模型反复传 JSON 字符串。应用创建、工具启用和绑定状态由工具结果解释，CAD skill 负责新建/编辑的领域流程，不把 CAD 格式加入全局提示词。

`position` 为形体中心的模型坐标；`rotation` 仅绕形体自身中心改变方向，不会带动中心绕模型原点公转。径向排列必须同时设置各个中心位置与朝向，工具参数描述和 CAD skill 提供四翼排列示例。

点击三维形体或左侧特征列表选择对象，橙色半透明形体和轮廓标出选区；埋在内部的切除特征也可从列表选择。移动模式拖动箭头、平面或中心手柄，旋转模式拖动圆环；松手只保存一次，Esc 或系统取消手势会恢复拖动前的草稿。一轮拖动对应一条历史记录，可撤销。吸附开关提供 1 mm 移动和 15° 旋转步长。点选/移动/旋转快捷键为 V/G/R，F 定位选中对象；在参数输入框中不会抢占这些按键。

右侧可精确编辑名称、尺寸、中心位置、旋转和合并/切除作用，点击保存或 Command/Ctrl-S。复制保留尺寸、角度和作用，生成新 ID 并放在模型旁边。添加/复制/删除特征和导入模型尝试立即保存；修改数值先保留为草稿。退出或切换文档时，未结束的拖动取消，先前的参数草稿仍走保存握手。

所有尺寸为毫米，形体以中心为原点，圆柱沿 Z 轴。特征按列表顺序求值：add 合并实体，cut 从此前实体切除。第一个特征必须是实体。空白处拖动旋转相机、滚轮缩放、右键平移，顶部支持等轴/正视/俯视/适应/定位选中。体积与尺寸来自几何内核，不是页面估算。

关联到对话后，每轮用户请求的首次修改前，Agent 先用 `cad_read_model` 读取当前保存模型；上一轮读取和上下文摘要不能替代本轮读取。多个特征优先用 `cad_edit_parts` 的 `upsert`/`remove` 数组一次修改；单个修改保留 `cad_upsert_part`/`cad_remove_part`。写入与用户操作共用 CAS、历史和撤销，Agent 不需要传递或递增 revision。更新时传完整特征，遗漏字段使用默认值；未涉及的特征保持不变，已有 ID 保持顺序，新 ID 按数组顺序追加。整批只校验最终模型，成功保存一次、失败全部不提交、一次撤销恢复整批。

“复杂一点”“更真实一些”等续写请求修改当前绑定文件并保留人工特征。`create_resource` 始终创建独立文件和标签，即使标题相同；只有明确要求新文件、独立方案或副本时才再次创建。对话标签显示“对话”标记，文件标签保留应用图标；相邻对话已展示的标题不再重复写入文件标签，关联关系仍可通过提示和无障碍名称查看。文件标签按资源 ID 唯一，不按文件名合并不同资源。

同一会话对同一资源的专用工具在读取之前排队，适用于进程内 Adapter 和 MCP，防止自身并发调用产生旧版本。CAD 替换工具声明 `requiresFreshRead`：会话上次读取/提交后若用户或其他会话已修改模型，运行时返回真正的冲突，让 Agent 重新读取并重算；不会用最新 revision 自动覆盖基于旧模型的参数。其他进程及读取到提交期间的竞争仍由存储 CAS 保护。

工具 description 说明调用和事务语义，绑定时按需加载 [CAD skill](../.pi/skills/parametric-cad/SKILL.md) 获取建模约定。CAD 规则不加入全局提示词；通用提示词仅要求进展聚焦用户目标，不向用户猜测内部调用细节。

保存失败保留本地草稿并允许重试；响应丢失时复用 operationId。并发冲突不覆盖另一方，用户可下载本地 JSON 备份，或明确选择重新载入保存版本。浏览器草稿使用同源 sessionStorage，在同一标签页刷新后恢复；桌面退出由已有保存握手提交草稿。

## 旧形体文件与能力边界

JSON 保存版本 1 的参数模型，支持导入、下载、重命名和重新编辑。下载 JSON 包含当前本地模型，可用于草稿备份；未通过参数校验的草稿可能需要修正后才能重新导入。导入是替换当前模型，成功保存后可撤销至原保存版本。

STL 从独立 Worker 导出真实二进制三角网格；空实体拒绝导出。STL 不携带参数历史，也不声明单位，使用毫米约定。当前 CAD 保存文件是同步 UTF-8 JSON，走既有 v1 Adapter；生成的 STL 是 Worker 的二进制下载，不把二进制写进 v1 序列化器。

当前最多 64 个特征；尺寸、位置、角度、文件大小与预览网格有上限，几何 Worker 默认时限为 60 秒，并可延长到 600 秒。曲面使用 32 段离散化，体积和 STL 属于网格近似；不承诺制造精度。尚未实现 STEP/DWG/DXF、草图约束、圆角/倒角、装配和外部 CAD 二进制文件编辑。

## 代码边界

源码模块：[program.ts](../src/software/cad/program.ts) 定义工程格式与参数校验；[program-engine.ts](../src/software/cad/program-engine.ts) 管理隔离解释器和结果校验；[program-guest.js](../src/software/cad/program-guest.js) 在解释器内构建几何；[program-migration.ts](../src/software/cad/program-migration.ts) 保留旧设计；[cad-program-tools.ts](../src/applications/adapters/cad-program-tools.ts) 定义源码领域工具；[cad-program-editor.js](../web/assets/workbench/adapters/cad-program-editor.js) 管理源码与参数交互。`build-cad-runtime.mjs` 生成解释器内的内核 bundle，生成文件不提交，必须先执行 `npm run build`。

[program-preview.ts](../src/software/cad/program-preview.ts) 管理 Worker 队列、取消和派生元数据；[program-preview-worker.ts](../src/software/cad/program-preview-worker.ts) 执行单个隔离任务；[program-render.ts](../src/software/cad/program-render.ts) 只处理校验后的三角网格与 PNG，不执行用户代码。预览工具及异步导出使用此路径，资源创建、读取与操作 reducer 不调用计算内核。

| 模块                                                                                             | 职责                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [model.ts](../src/software/cad/model.ts)                                                         | 版本化参数模型、严格校验、领域操作，无 DOM/文件/执行代码 |
| [interaction.ts](../src/software/cad/interaction.ts)                                             | 新增/复制的默认摆放、旋转后的包围盒，无 DOM/持久化       |
| [geometry.ts](../src/software/cad/geometry.ts)                                                   | JSCAD 实体、变换、布尔运算、网格与几何测量               |
| [cad-runtime-adapter.ts](../src/applications/adapters/cad-runtime-adapter.ts)                    | 应用声明、JSON、可逆操作、选区、上下文和专用工具         |
| [document-session.js](../web/assets/cad/document-session.js)                                     | 草稿及手势快照、保存、revision、幂等重试、冲突与恢复     |
| [cad-editor.js](../web/assets/workbench/adapters/cad-editor.js)                                  | 特征列表、参数表单与 UI 生命周期                         |
| [worker.js](../web/assets/cad/worker.js)、[kernel-client.js](../web/assets/cad/kernel-client.js) | 独立几何计算、取消过时任务、超时、STL                    |
| [viewport.js](../web/assets/cad/viewport.js)                                                     | Three.js 视图、射线点选、变换手柄、相机与 GPU 资源释放   |
| [build-cad.mjs](../scripts/build-cad.mjs)                                                        | 本地浏览器 bundle 和第三方许可证；由 npm run build 调用  |

Worker 分别返回布尔结果网格与特征网格。视图用特征网格点选和高亮；切换选区不重算布尔模型，拖动只更新选区预览，松手后重算实体。射线点选优先匹配可见布尔表面，避免内部原始形体抢走点击。手势期间暂停远端刷新，提交仍使用原 revision；外部修改引发冲突时保留本地草稿，不覆盖其他人的版本。

仅在前后端注册表装配应用；通用 ResourceStore、HTTP 应用路由和 Pi 绑定机制没有 CAD 领域分支。标签图标通过 UI Adapter 声明，Host 读取通用展示元数据。

浏览器资产生成在 `web/assets/cad/generated/`，不提交；干净安装需执行 `npm ci` 和 `npm run build`。资产随 `web/` 进入桌面包，运行时无 CDN 和额外 CAD 可执行程序。三维依赖在 CAD 窗口中按需加载，TXT 不加载 Three.js 几何视图。

## 开源参考

完整源码使用 [QuickJS WASM](https://github.com/justjake/quickjs-emscripten) 隔离执行。采用 [JSCAD](https://github.com/jscad/OpenJSCAD.org) 的模块化 CSG 内核和 STL serializer、[Three.js](https://github.com/mrdoob/three.js) 的三维渲染。也调研了 [Replicad](https://github.com/sgenoud/replicad) 的 OpenCascade/B-rep 路线；首版选择 JSCAD；现在新增 CadQuery/OpenCascade，保留同一个界面和参数协议。未复制第三方完整编辑器。

锁定 @jscad/modeling 2.13.0、@jscad/stl-serializer 2.1.23、Three.js 0.186.0；构建时从实际依赖复制 MIT 许可证到 `generated/THIRD_PARTY_LICENSES.txt`，bundle 保留 legal comments。升级内核必须重跑真实几何和 STL 回归。

## 验证

在完成当前源码构建后，使用 [本地验证指南](testing-local-run.md) 选择相关回归：

- `npm run test:unit -- --skip-build --match cad-`：文档校验、参数与人工覆盖、失败候选、CAS、取消、预览、导出、装配和运动契约。
- [应用工具串行与版本测试](../test/application-agent-tools.test.js)、[Pi 接入测试](../test/application-bootstrap-pi.test.js)：读取前提、绑定发现、工具切换和失败传播。工具结果 `ok:false` 应产生错误结果，前端保留已保存设计并显示失败。
- [源码浏览器回归](../e2e/cad-program.spec.js)、[装配回归](../e2e/cad-assembly.spec.js)、[检查视图回归](../e2e/cad-inspection.spec.js)、[协作回归](../e2e/cad-chat.spec.js)：草稿、参数、布局、装配树、运动、选区、真实图像和导出。
- [原生内核回归](../test/cad-native.test.js)、[装配内核回归](../test/cad-assembly.test.js)：真实几何和 STEP、文件/网络/命令/凭据隔离、预算、超时及取消。需要支持的 macOS 环境和锁定运行时；记录实际 skip 原因。

本地模型协议夹具验证 Dashboard、Pi、领域工具和资源提交的连接，不证明实际模型的专业设计或视觉能力。最终安装包需按 [Mac 发布指南](mac-release.md) 独立安装、搬移、重启和升级验收；源码测试结果不能代替包内原生运行时验证。

## 原生引擎新增文件

CAD 工作区按当前状态显示功能：模型生成前收起属性栏；有可调参数或选中零件时显示相应属性，窄工作区可通过「属性」按需打开。画布常驻观察方向和适配操作，外观、爆炸、剖切、导航与测量位于「视图」。设计验收、计算日志和模型信息集中在「检查」；零件引用位于选中对象属性和右键菜单。测量开启后显示结果，模型导出归入「文件 → 导出」，保存副本位于文件菜单。显示调整与面板切换不修改模型源码或设计版本。

装配树支持整组选择、整组显示/隐藏、部分可见状态、固定树、搜索及全部展开/折叠。树与三维表面的右键菜单提供引用复制、取消选择、隔离、隐藏其他/选中、其他淡化、聚焦、恢复缩放及展开操作。`cad.assembly-node/v1` 选区传递稳定 `path` 和子实体数，与原有 `cad.program-solid/v1` 兼容。复制引用为 `cad://资源ID@r版本#路径`，是对话标识。

逐零件爆炸与按子装配爆炸使用前后端共享变换函数；后者按根装配下的子节点分组移动。三轴剖切可独立启用、定位和反向，保留半空间交集，不封口。旋转/选择、平移、缩放百分比和可点击方向坐标轴可与运动并用。两点测量使用当前可见表面网格，显示距离及 XYZ 分量；改变时间、爆炸、剖切后清除测量，避免沿用旧位置。它不是精确 BRep 面边测量。

“运动仿真”打开可交互的大视图并播放既有轨道，关闭后恢复同一个查看器。支持下载一周期 WebM（最长 60 秒），保持速度设置，录制过程中可旋转观察，帧率由浏览器/设备决定；不支持录制的浏览器给出明确提示，仍可导出 PNG/Python/JSON。运动学关键帧播放不等于动力学或碰撞计算。

模型接口继续使用原有四个 CAD 工具；`cad_get_api_reference({module:"Viewer"})` 提供显示契约，`cad_preview.view` 新增 `hiddenPaths`、`explodeMode`、`sections`（最多三个不同轴；与单轴 `section` 互斥）。剖切面的 `inverted:true` 保留轴坐标 >= offset。所有显示操作保持源码、参数、BRep 指标及设计版本不变。[浏览器检查回归](../e2e/cad-inspection.spec.js) 验证实际选择上下文、测量、录制下载、关闭恢复及宽窄窗口；[装配回归](../test/cad-assembly.test.js) 验证路径预算、多轴网格裁切、子装配刚体拆解和基线不变。

- `src/software/cad/cadquery-engine.ts`：操作系统隔离、进程、取消/预算、原生导出和 API 查询。
- `src/software/cad/cadquery-runner.py`：CadQuery 执行、参数、精确诊断、网格和 STEP/STL。
- `src/software/cad/program-geometry.ts`：共享显示结果类型和验证，不加载 JSCAD。
- `scripts/setup-cadquery.mjs`、`scripts/cadquery-requirements.txt`：独立可打包运行时及依赖哈希锁。
- `test/fixtures/cad-rocket.py`：薄壁、样条旋转整流罩、喷管、圆角尾翼、孔阵列法兰及内部框示例。

CadQuery 来源：[官方安装说明](https://cadquery.readthedocs.io/en/stable/installation.html)、[STEP 导出及格式边界](https://cadquery.readthedocs.io/en/stable/importexport.html)。Python wheel 的许可证保留在包内 `.dist-info`，运行时包含许可证索引。依赖升级必须验证 STEP 重新导入后尺寸/实体/体积、原生隔离、人工参数以及 Mac 搬迁后的运行时路径。

### 显示外观和设计验收

查看器默认使用工程灰。曲面按 30 度折角做法线平滑并保留锐边，使用本地生成的环境反射、色调映射和补光。用户可切换零件色或声明材质；这些显示操作不修改源码、BRep、STEP 或材料物性。

`cad_get_api_reference({module:"Design"})` 返回 `atria-cad-design/v1`。CadQuery 可提供 `get_design_manifest(p)`，声明用途、需求部件路径与最小独立实体数量、显示材质、源码检查及简化限制。材料为 aluminum/steel/cast-iron/brass/rubber。passed 检查须提供 evidence，仍明确标为源码声明，运行器不会将其升级成独立工程认证。

预览与提交返回 `assessment`，查看器“设计检查”同步显示：真实非空零件匹配数量、缺失部件、未验证/失败检查、循环首尾姿态不闭合及省略项。路径包含子孙，重叠路径去重。没有需求清单时完整度为 not_declared；全部数量满足为 declared_components_present，不能推断结构正确、无干涉或可制造。旧预览不显示为当前验收通过。源码断言失败和清单格式错误仍阻止候选提交；缺件和未验证项作为反馈，允许保存仍在完善的设计。

---
name: parametric-cad
description: 创建或修改 CoworkOS CAD 工程，验证几何并保留人工编辑。
---

只用于 CAD 设计、修改和导出，不改变问答、TXT、调研或项目开发的工作方式。

委派时 Main 必须通过 resources 明确共享模型。read 只能检查；candidate 中工具生成私有候选和真实预览，不保存共享模型。交付最新 candidatePath 与验证证据，由 Main 验收后提交；不要把候选描述为已保存到用户模型。 委派中直接使用明确共享的模型，不另建资源；下面的新建流程只适用于 Main。

新设计先 enable_tools({groups:["applications"]})，再用 create_resource({kind:"model/atria-cadquery+json",title:"设计.cad.json"})，省略 initialContent；不用先打开应用。工具按需启用，不搜索 harness 源码。继续已有设计时使用绑定的同一文件；只有用户明确要新设计、副本或版本时才新建。

新建得到空工程，没有示例形体或默认尺寸；创建文件本身不代表完成建模。按用户要求提交首个完整设计，不先提交与需求无关的方盒子或占位形体。

先 cad_read_model 读取当前源码和人工参数。根据返回的实际格式按需读取一份说明：

- engine:"cadquery"：[Python / 精确实体契约](references/cadquery.md)。
- engine:"jscad"：[JSCAD 兼容](references/jscad.md)。
- version:1：[旧形体编辑](references/legacy.md)。

源码设计常用 cad_run_program({source:"完整源码"})：计算通过后在同一文件提交，返回测量和真实四视图；无需另调 cad_preview。仅调整尺寸可传 parameters，未涉及的人工参数会保留。已知 API 直接使用，不确定时才 cad_get_api_reference。失败依据真实错误修正重试；超时可提高预算。冲突时重新读取、结合人工修改重算。运行时管理版本和队列，不向用户讨论内部调度。

源码是上述工具的 source 参数，不是待 edit/write 的工作区文件。候选失败后，直接修正自己刚提交的完整源码，再调用 cad_run_program；不要用 edit/write/bash 改资源文件或覆盖已保存设计。

需要交付文件时 export_resource({resourceId:已读资源ID,format:"step"})，真实文件会进入当前对话产出物；不生成重复 CAD 文件。其他格式按当前引擎说明选择。

保留完整设计表达，不降级成几个基本形体；为主要尺寸提供简洁的人工参数。模型应满足用户要求，几何验证成功不等于设计质量合格。支持图像输入时检查预览比例和布局，不支持时如实使用文字诊断。

复杂装配首次建模先查询 cad_get_api_reference({module:"Design"})，在 get_design_manifest(p) 中声明需求部件、数量、显示材质、验证结果及省略项。按用户需求确定清单，不按已生成内容反推一个必定通过的清单。发动机应表达缸体/缸盖、曲轴轴承、活塞连杆、配气与正时、必要连接件；若作剖开教学模型，可简化外壳，但要明确省略弹簧、密封、紧固件等结构及原因。为主要边缘加入合理倒角/圆角，避免用悬空方块代替真实连接；不要仅靠显示材质弥补几何不足。材料预设只表示外观，不是工程材料参数。

检查 cad_run_program 返回的 assessment：缺失部件、未验证检查和循环不闭合须修正或如实说明。passed 必须有真实计算依据及 evidence；用 assert 验证重要行程、相位、连接和间隙。仅有 BRep/轨道格式通过时，不声称装配完整、无干涉、可制造或动力学已通过。源码声明检查与 harness 独立验证分开报告。无清单时完整度是未知。

CadQuery 的 main 可用 print 返回局部几何诊断，用 assert 验证孔槽、连接和尺寸；断言失败不提交。工具在已有计算基线时返回 changeSummary，注意“代码变化但几何指标未变化”的提示，核对布尔是否真正生效。坐标或 API 不确定时查询准确签名；精确坐标、旋转及验证示例在 references/cadquery.md。

涉及机构、发动机、装配或运动时，main 返回具有稳定名称的 cq.Assembly，保留独立零件和子装配，不将需要运动的零件融合成一个实体。可选 get_motion(p) 定义运动关键帧，首次使用查询 cad_get_api_reference({module:"Motion"})。返回的 assembly/path 和逐零件 BRep 是实际检查依据；cad_preview({view:{timeSeconds:时刻,paths:[装配路径]}}) 检查运动帧或隔离内部零件，也可爆炸、剖切。用源内断言验证端点闭合、行程、相位和间隙；轨道格式有效不等于无干涉或物理仿真通过。具体契约见 references/cadquery.md。

普通使用只需要用户描述设计、查看结果、调整参数或继续提要求；无需用户指定引擎、查 API、执行代码或手工运行验证。回复所做的设计修改及真实验收结果，不倾倒源码和工具调用过程。

用户的选区可能是整组子装配，依据选区摘要中的稳定 path 操作，不将它误当成一个实体。查看器复制的 cad://资源ID@r版本#路径是引用标识。按需 cad_get_api_reference({module:"Viewer"}) 查询隔离/隐藏路径、逐零件或子装配爆炸、三轴剖切协议。cad_preview 的这些选项仅用于观察，不改变保存设计。用户仅要求隐藏、拆解观看或播放已有运动时，不为显示效果改写零件几何。

# CadQuery 建模契约

原生 Python 可使用完整 CadQuery/OpenCascade API。import cadquery as cq；main(p) 返回 cq.Workplane、cq.Shape、cq.Assembly，或命名实体列表 {"name":名字,"shape":实体}。可以组合曲线、草图、旋转、放样、扫掠、薄壁、布尔、圆角、倒角和装配；二维轮廓需要生成封闭有效三维实体。

尺寸 mm，Z 向上，rotate 角度为度。查询不确定的签名时调用 cad_get_api_reference({module:"Workplane",member:"loft"})；module 也支持 Sketch/Shape/Solid/Face/Wire/Edge/Assembly/Vector/Location。不需要先查一遍所有 API。

坐标和接口不确定时查询真实签名，不反复凭记忆推导。Plane 也可查询，返回命名平面的局部 x/y/normal 基向量：XY 是 X/Y/+Z；XZ 是 X/Z/−Y；ZX 是 Z/X/+Y。二维草图坐标用局部 x/y，extrude 沿 normal；revolve 的轴坐标属于工作平面的局部坐标，不能混用世界轴。rotate(axisStart, axisEnd, angleDegrees) 的轴点是三维点；圆锥用 Solid.makeCone，Workplane 没有 cone 方法。

按用户目的主动完成设计层次和比例，完整源码能表达曲面、内腔、阵列和装配，不要把“可运行的圆柱加圆锥”当成复杂设计已完成。主要尺寸用稳定参数名，部件用清晰名字；精细建模无需增加一整套编辑器按钮。

对关键要求直接在 main 中使用 assert 和 print。print 输出会作为 diagnostics 返回（最多 4096 字符），既可观察局部几何，也可验证布尔是否生效；assert 失败会阻止保存候选并返回错误行。例如：

```python
before = body.Volume()
body = body.cut(cutter)
removed = before - body.Volume()
print("slot removed volume:", removed)
assert removed > 1e-4, "散热槽没有切到壁面，检查切割体位置和方向"
assert len(body.Solids()) == 1, "应当连成单实体"
```

孔、槽和圆角需要检查实际作用，薄壁和装配需要检查厚度、间隙及连接关系；必要时使用更小的诊断候选迅速确认 API。工具的 changeSummary 使用已缓存的当前保存设计做前后比较，不重复计算基线；指标不变会提示核对，而不会阻止合理的代码重构。尺寸/体积/面数相同也不能证明完整几何相同。没有图片反馈时，不声称检查了视觉比例；结合包围盒、实体数、体积和源内断言验收。

最小参数工程：

```python
import cadquery as cq

def get_parameter_definitions():
    return [
        {"name": "width", "type": "float", "initial": 60, "min": 20, "max": 200, "caption": "宽度 (mm)"},
        {"name": "hole", "type": "float", "initial": 10, "min": 1, "max": 15, "caption": "孔径 (mm)"},
    ]

def main(p):
    return (cq.Workplane("XY").box(p["width"], 40, 20)
            .edges("|Z").fillet(3)
            .faces(">Z").workplane().hole(p["hole"]))
```

参数支持 float/int/slider/text/checkbox/choice，main(p) 获得源码默认值和已保存人工覆盖的合并结果。参数名称尽量稳定，只传希望改动的覆盖；重命名参数时迁移人工值。给主要尺寸提供参数即可，不为每个内部细节堆控件。

cad_run_program 在预算内验证候选，然后由版本协议提交。sourceSaved:false 表示没有保存候选，当前工程仍在；根据错误行修正自己的候选代码并重试，不必重新创建文件。并发人工修改导致 revision_conflict 时读取最新设计，合并改动后重算。CadQuery 默认 180 秒；复杂计算可按需提高到 300/600 秒，保持设计细节和预览精度。

返回的 BRep.valid 表示几何有效，不代表满足制造规范。多个实体体积相加，重叠未扣除，净体积先融合。四视图来自实际几何；visualFeedback.delivered:false 时只能使用文字诊断，不能声称看过图片。

显示网格单部件及全模型上限均为 1,000,000 个三角形，预览保持默认 0.1/0.1 精度，不自动降低质量或省略零件。`tessellation.adjusted:false` 表示保持默认精度；尺寸、体积与 STEP 来自精确 BRep。超出硬网格/内存/结果大小预算仍失败，提高 timeoutSeconds 只延长计算时间，不会扩大其它预算；不要为通过工具检查擅自删掉设计要求或缩减部件。`sourceSaved:false` 时本次候选未提交，导出仍是已保存版本，不能把旧 STEP 当作候选结果。

STEP 保留精确曲面及实体，但不携带 Python 参数历史；Python/JSON 保留设计源码和参数，STL 是网格。导出用应用接口，不访问内部资源文件。运行器禁止用户文件、联网和宿主命令；无需用户授权普通建模。还没有交互草图约束编辑器或二维尺寸工程图。

## 装配与运动

`cq.Assembly(name="engine")` 中每个节点使用稳定名称和 `loc=cq.Location(...)`，可指定 `color=cq.Color(...)`。装配层级、局部坐标和继承颜色会传给查看器，STEP 保留装配树和静止放置。运动零件应保持独立；前端支持部件树搜索、显隐/隔离、爆炸图、透明/线框、XYZ 剖切和当前视图截图。所有观察动作不改源码和人工参数。

可选 `get_motion(p)` 使用与 main 相同的有效参数，返回 `{duration:秒,tracks:[轨道]}`。完整且可运行的示例通过 `cad_get_api_reference({module:"Motion"})` 获得。目标 path 是 `cad_run_program` 返回的装配节点路径，例如 `/engine/crank`。名称包含特殊字符时路径按 URL 分段编码；使用实际读回的路径，不猜测。可驱动整个子装配，子节点继承运动。

- 平移：`{"path":"/engine/piston","type":"translation","times":[0,1,2],"values":[[0,0,0],[0,0,-20],[0,0,0]]}`，单位 mm。
- 旋转：`{"path":"/engine/crank","type":"rotation","axis":[1,0,0],"pivot":[0,0,0],"times":[0,2],"values":[0,720]}`，角度为度，轴须非零。
- 轨道是**父坐标系中的增量**，顺序为 `T(平移) * T(pivot) * R(轴,角度) * T(-pivot) * 节点静止局部变换`。pivot 是旋转中心在父坐标系中的坐标。绕自己的轴转动时，不能把有位置偏移的零件默认绕父原点转动。
- 时间严格递增，从 0 到 duration，times/values 等长。线性插值；旋转用连续角度，如 0→720，而不是折回 0→0。连杆、凸轮等非线性运动用足够密的采样。循环末帧应与首帧姿态一致，否则回放会跳变。
- 周期最多 3600 秒，最多 256 条轨道、每轨道 1024 帧、总计 16384 帧。每节点同类轨道至多一条。装配最多 2048 节点/32 层。无任意前端脚本和文件/网络桥接。

运动轨道在候选提交前验证；无效目标/数值/时间返回 sourceSaved:false。`changeSummary.motionChanged` 能识别仅运动变化，不误报“代码改变但结果没有变化”。主尺寸/体积/BRep 是静止精确模型；运动摘要仅说明关键帧契约通过校验，几何有效也不证明工程可制造。

检查当前工程的某帧和内部结构：

```json
{
  "timeoutSeconds": 180,
  "view": {
    "timeSeconds": 1,
    "paths": ["/engine/pistons"],
    "explode": 0,
    "section": { "axis": "x", "offset": 0 }
  }
}
```

上述作为 cad_preview 参数；view 每项可独立省略。返回的 `view.bounds` 和 `view.objects` 是该帧/隔离/剖切后的真实网格包围盒与三角形数，图片也是该视图；顶层精确指标仍来自静止模型。派生视图不写回资源、不改变版本、参数或几何基线。剖切保留坐标小于等于 offset 的一侧，不封口，不用于 STEP 制造导出。timeSeconds 范围为 0 到 duration，paths 必须存在。

在 Python 中检查曲柄连杆端点闭合、活塞行程、四缸相位和四冲程 720° 周期；静态/离散采样的检查不能保证全周期无干涉。STEP/STL 不携带本契约的动画；Python/JSON 保存运动源码。不要将关键帧运动演示称为已完成燃烧、受力或动力学仿真。

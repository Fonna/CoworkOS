/** The harness contract is separate from the installed CadQuery API. */
export const motionReference = {
  module: "Motion",
  contract: "atria-cad-motion/v1",
  entryPoint:
    "可选 def get_motion(p)，使用与 main(p) 相同的有效参数，返回 {duration:秒,tracks:[...]}。只返回 JSON 数值，不调用查看器、不写文件。",
  assembly:
    "main(p) 返回 cq.Assembly；给每个节点稳定且唯一的名称。完整路径如 /engine/crank，从 cad_run_program 的 assembly 读回。层级、局部变换、继承颜色及逐零件有效性会保留。",
  coordinates:
    "mm，旋转角度为度。每条轨道是节点在父坐标系中的增量：local(t)=T(translation)*T(pivot)*R(axis,angle)*T(-pivot)*restLocal。子节点继承父节点的运动。绕自身轴时 pivot 使用节点静止位置在父坐标系中的坐标。初帧通常使用零增量。",
  tracks: {
    translation: {
      path: "/engine/piston",
      type: "translation",
      times: [0, 1, 2],
      values: [
        [0, 0, 0],
        [0, 0, -20],
        [0, 0, 0]
      ]
    },
    rotation: {
      path: "/engine/crank",
      type: "rotation",
      axis: [1, 0, 0],
      pivot: [0, 0, 0],
      times: [0, 2],
      values: [0, 720]
    }
  },
  interpolation:
    "时间严格递增，首帧 0、末帧 duration；使用线性插值。旋转保留连续角度（0→720 表示两圈），不要把所有角度折回 0–360。非线性连杆/凸轮运动需足够密的采样。循环末帧应回到首帧姿态（旋转可差整圈），否则播放会跳变。",
  budgets: {
    durationSeconds: 3600,
    tracks: 256,
    keyframesPerTrack: 1024,
    totalKeyframes: 16384,
    assemblyNodes: 2048,
    assemblyDepth: 32
  },
  validation:
    "运行器验证目标、矩阵、轴、时间和值。运动学正确性用 Python assert/print 验证行程、连杆端点、相位和间隙；关键帧有效不等于无碰撞或动力学仿真通过。",
  inspection:
    "cad_preview({view:{timeSeconds:1,paths:['/engine/piston'],explode:0,section:{axis:'x',offset:0}}})。view 各字段可省略，检查某时刻或隔离子装配、爆炸图、剖切。view.bounds/objects 是展示网格包围盒；顶层尺寸/体积/BRep 是静止精确模型。派生视图不保存、不改参数、不污染基线。剖切不封口、不作为制造几何。",
  export:
    "STEP 保留装配树、名称、颜色及静止放置；Python/JSON 保留 get_motion 源码。STEP/STL 不携带本契约的动画。",
  example: `import cadquery as cq
def main(p):
    a = cq.Assembly(name="engine")
    a.add(cq.Workplane("XY").box(40,8,8), name="crank", color=cq.Color("steelblue"))
    a.add(cq.Workplane("XY").circle(10).extrude(12), name="piston", loc=cq.Location(cq.Vector(0,0,40)))
    return a
def get_motion(p):
    return {"duration":2,"tracks":[
        {"path":"/engine/crank","type":"rotation","axis":[1,0,0],"pivot":[0,0,0],"times":[0,2],"values":[0,720]},
        {"path":"/engine/piston","type":"translation","times":[0,1,2],"values":[[0,0,0],[0,0,-20],[0,0,0]]}
    ]}`
};

export const viewerReference = {
  module: "Viewer",
  contract: "atria-cad-view/v1",
  selection:
    "用户可选单个实体或整组。cad.program-solid/v1 带 id/path；cad.assembly-node/v1 带 path。以 cad_read_model 返回的选区摘要与 assembly/path 为准。稳定路径不依赖 solid_i 顺序。",
  references: "查看器复制 cad://资源ID@r版本#装配路径，作为对话中的引用标识；它不是网络地址或新的工具。",
  preview: {
    timeSeconds: "有运动时为 0..duration 秒；省略使用初帧。",
    paths: "1..256 个真实装配路径，包含子孙；仅展示这些路径。",
    hiddenPaths: "1..256 个真实装配路径，包含子孙；从展示中移除，优先于 paths。",
    explode: "0..1 爆炸比例。",
    explodeMode: "parts（默认逐零件）或 groups（按根装配下的子装配移动，保持组内相对位置）。",
    section: "单个 {axis:'x'|'y'|'z',offset:mm,inverted?:boolean}；默认保留坐标<=offset，反向保留>=。",
    sections: "最多三个不同轴的剖切面，保留各半空间的交集；不能和 section 同时提供。"
  },
  example: {
    view: {
      timeSeconds: 1,
      hiddenPaths: ["/engine/cylinders"],
      explode: 0.4,
      explodeMode: "groups",
      sections: [
        { axis: "x", offset: 0 },
        { axis: "z", offset: 50, inverted: true }
      ]
    }
  },
  limits:
    "所有显示操作只生成派生视图；不保存源码/参数，不改变 BRep 或制造几何。剖切网格不封口。view.bounds/objects 为显示网格包围盒；顶层尺寸/体积/BRep 为静止模型。整组体积为实体求和，重叠未扣除。",
  viewer:
    "用户界面支持树展开/折叠、按组隐藏、隔离、其他淡化、聚焦、网格两点测量、运动播放/时间/速度、独立大视图与 WebM 录制。两点测量是显示网格距离，不是精确 BRep 面边测量。视频记录真实浏览器播放，受设备帧率影响；不是物理仿真。"
};

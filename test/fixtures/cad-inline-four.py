"""Inline-four crank/rod/piston demonstrator. Dimensions and kinematics are checked.

This is a mechanism fixture, not a complete manufacturing design or combustion model.
"""
import math
import cadquery as cq


def get_parameter_definitions():
    return [
        {"name": "crankRadius", "type": "float", "initial": 18, "min": 10, "max": 24, "caption": "曲柄半径 (mm)"},
        {"name": "rodLength", "type": "float", "initial": 60, "min": 45, "max": 85, "caption": "连杆长度 (mm)"},
        {"name": "period", "type": "float", "initial": 4, "min": 1, "max": 20, "caption": "循环时间 (s)"},
    ]


def main(p):
    r, length = p["crankRadius"], p["rodLength"]
    assert length > r, "连杆长度必须大于曲柄半径"
    engine = cq.Assembly(name="engine")
    crank = cq.Assembly(name="crank", color=cq.Color("steelblue"))
    shaft = cq.Workplane("YZ").circle(6).extrude(240).translate((-120, 0, 0))
    crank.add(shaft, name="shaft")
    pistons = cq.Assembly(name="pistons", color=cq.Color(0.75, 0.75, 0.78))
    rods = cq.Assembly(name="rods", color=cq.Color(0.85, 0.65, 0.2))
    for i, x in enumerate([-90, -30, 30, 90]):
        sign = 1 if i in (0, 3) else -1
        arm = cq.Workplane("XY").box(8, 10, r+8).translate((x, 0, sign*r/2))
        pin = cq.Workplane("YZ").circle(4).extrude(12).translate((x-6, 0, sign*r))
        crank.add(arm, name=f"arm_{i+1}")
        crank.add(pin, name=f"pin_{i+1}")
        rod = cq.Workplane("XY").box(7, 9, length).translate((0, 0, length/2))
        rods.add(rod, name=f"rod_{i+1}", loc=cq.Location(cq.Vector(x, 0, sign*r)))
        piston = (cq.Workplane("XY").circle(17).extrude(20)
                  .faces(">Z").workplane().circle(14).cutBlind(-16))
        pistons.add(piston, name=f"piston_{i+1}", loc=cq.Location(cq.Vector(x, 0, length+sign*r)))
    engine.add(crank)
    engine.add(rods)
    engine.add(pistons)
    # Separate thin-wall cylinder sleeves make transparency/section inspection useful.
    cylinders = cq.Assembly(name="cylinders", color=cq.Color(0.3, 0.55, 0.7, 0.35))
    for i, x in enumerate([-90, -30, 30, 90]):
        sleeve = cq.Workplane("XY").circle(21).circle(18).extrude(2*r+28)
        cylinders.add(sleeve, name=f"sleeve_{i+1}", loc=cq.Location(cq.Vector(x, 0, length-r-4)))
    engine.add(cylinders)
    print(f"four cylinders; stroke={2*r:.3f} mm; rod={length:.3f} mm; cycle=720 degrees")
    return engine


def get_motion(p):
    r, length, duration = p["crankRadius"], p["rodLength"], p["period"]
    times = [duration*i/180 for i in range(181)]
    angles = [4*i for i in range(181)]
    tracks = [{"path": "/engine/crank", "type": "rotation", "axis": [1,0,0],
               "pivot": [0,0,0], "times": [0,duration], "values": [0,720]}]
    for i, x in enumerate([-90, -30, 30, 90]):
        phase = 0 if i in (0,3) else math.pi
        rest_pin = r*math.cos(phase)
        translations, tilts, piston_positions = [], [], []
        for degrees in angles:
            theta = math.radians(degrees)+phase
            y, z = -r*math.sin(theta), r*math.cos(theta)
            span = math.sqrt(length**2-y**2)
            assert abs(math.hypot(y, span)-length) < 1e-8, "连杆端点不闭合"
            translations.append([0,y,z-rest_pin])
            tilts.append(math.degrees(math.asin(y/length)))
            piston_positions.append([0,0,z+span-(length+rest_pin)])
        stroke = max(v[2] for v in piston_positions)-min(v[2] for v in piston_positions)
        assert abs(stroke-2*r) < 1e-7, "活塞行程错误"
        assert abs(piston_positions[-1][2]-piston_positions[0][2]) < 1e-8, "循环不闭合"
        path = f"/engine/rods/rod_{i+1}"
        tracks += [
            {"path":path,"type":"translation","times":times,"values":translations},
            {"path":path,"type":"rotation","axis":[1,0,0],"pivot":[x,0,rest_pin],"times":times,"values":tilts},
            {"path":f"/engine/pistons/piston_{i+1}","type":"translation","times":times,"values":piston_positions},
        ]
    return {"duration":duration,"tracks":tracks}


def get_design_manifest(p):
    return {
        "intent": "kinematic-demo",
        "components": [
            {"label": "四组活塞", "paths": ["/engine/pistons"], "minimumCount": 4, "material": "aluminum"},
            {"label": "四根连杆", "paths": ["/engine/rods"], "minimumCount": 4, "material": "brass"},
            {"label": "曲轴", "paths": ["/engine/crank/shaft"], "material": "steel"},
            {"label": "四个缸套", "paths": ["/engine/cylinders"], "minimumCount": 4, "material": "cast-iron"}
        ],
        "checks": [{"label": "连杆端点、活塞行程及首尾闭合", "status": "passed",
                    "evidence": f"get_motion 以181个姿态检查连杆长度、{2*p['crankRadius']} mm行程及720度循环，assert容差1e-7 mm"}],
        "limitations": ["曲柄连杆机构示例，未建模缸盖、气门弹簧、紧固件和正时机构", "未验证全周期干涉或制造公差"]
    }

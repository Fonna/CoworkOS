import cadquery as cq
import math


def get_parameter_definitions():
    return [
        {"name": "radius", "type": "float", "initial": 20, "min": 12, "max": 35, "caption": "机身半径 (mm)"},
        {"name": "body_height", "type": "float", "initial": 120, "min": 80, "max": 200, "caption": "机身长度 (mm)"},
        {"name": "nose_height", "type": "float", "initial": 55, "min": 30, "max": 90, "caption": "鼻锥长度 (mm)"},
        {"name": "wall", "type": "float", "initial": 1.8, "min": 1, "max": 3, "caption": "壳体厚度 (mm)"},
        {"name": "fin_count", "type": "int", "initial": 4, "min": 3, "max": 8, "caption": "尾翼数量"},
    ]


def main(p):
    r, h, n, wall = p["radius"], p["body_height"], p["nose_height"], p["wall"]
    body = cq.Workplane("XY").circle(r).circle(r - wall).extrude(h)
    # Native spline-based surface of revolution, not a polygonal cone.
    nose_profile = (cq.Workplane("XZ").moveTo(0, h).lineTo(r, h)
                    .spline([(r * .95, h + n * .2), (r * .73, h + n * .5),
                             (r * .38, h + n * .78), (0, h + n)], includeCurrent=True).close())
    nose = nose_profile.revolve(360, (0, 0), (0, 1))
    inner = (cq.Workplane("XZ").moveTo(0, h - 1).lineTo(r - wall, h - 1)
             .lineTo(r - wall, h).spline([((r - wall) * .90, h + n * .25),
                                        ((r - wall) * .55, h + n * .6),
                                        (0, h + n - 2 * wall)], includeCurrent=True).close()
             .revolve(360, (0, 0), (0, 1)))
    nose = nose.cut(inner)
    nozzle = (cq.Workplane("XZ").polyline([(8, 5), (6, -5), (11, -22),
                                            (12.8, -22), (7.8, -5), (9.8, 5)])
              .close().revolve(360, (0, 0), (0, 1)))
    flange = cq.Workplane("XY", origin=(0, 0, 3)).circle(r + 4).circle(r - wall).extrude(4)
    flange = flange.faces(">Z").workplane().polarArray(r + 2, 0, 360, 8).hole(1.5)
    fin = (cq.Workplane("XZ").polyline([(r - .5, 8), (r + 23, 5), (r + 12, 37), (r - .5, 48)])
           .close().extrude(1.3, both=True).edges("|Y").fillet(.6))
    items = [{"name": "薄壁机身", "shape": body}, {"name": "曲面整流罩", "shape": nose},
             {"name": "收扩喷管", "shape": nozzle}, {"name": "八孔连接法兰", "shape": flange}]
    for index in range(p["fin_count"]):
        items.append({"name": f"尾翼 {index + 1}", "shape": fin.rotate((0, 0, 0), (0, 0, 1), index * 360 / p["fin_count"])})
    for index, z in enumerate([h * .25, h * .55, h * .85]):
        frame = cq.Workplane("XY", origin=(0, 0, z)).circle(r - wall).circle(r - 4).extrude(2)
        items.append({"name": f"内部加强框 {index + 1}", "shape": frame})
    return items

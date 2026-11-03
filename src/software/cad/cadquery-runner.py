"""Wire-only CadQuery worker. The parent enforces OS isolation and a wall deadline."""
import contextlib
import inspect
import json
import math
import os
import resource
import sys
import traceback


def parameters(namespace, overrides):
    definitions = namespace.get("get_parameter_definitions", lambda: [])()
    if not isinstance(definitions, list) or len(definitions) > 2048:
        raise ValueError("无效参数定义")
    effective, seen = {}, set()
    for d in definitions:
        name, kind = d.get("name"), d.get("type")
        if not isinstance(name, str) or name in seen:
            raise ValueError("无效或重复参数名")
        seen.add(name)
        value = overrides.get(name, d.get("initial"))
        if kind in ("float", "number", "slider", "int"):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"参数 {name} 须为有限数值")
            if kind == "int" and int(value) != value:
                raise ValueError(f"参数 {name} 须为整数")
            if value < d.get("min", -math.inf) or value > d.get("max", math.inf):
                raise ValueError(f"参数 {name} 超出范围")
        elif kind == "checkbox":
            if not isinstance(value, bool):
                raise ValueError(f"参数 {name} 须为布尔值")
        elif kind == "text":
            if not isinstance(value, str):
                raise ValueError(f"参数 {name} 须为文字")
        elif kind == "choice":
            if value not in d.get("values", []):
                raise ValueError(f"参数 {name} 不在选项中")
        else:
            raise ValueError(f"参数 {name} 使用未知类型")
        effective[name] = value
    return definitions, {**effective, **overrides}


def shapes(output, cq):
    """Keep the native assembly tree and local placements alongside world-space meshes."""
    from urllib.parse import quote
    result, nodes, paths = [], [], set()

    def node(name, parent=None, location=None):
        name = str(name)[:80]
        path = (parent or "") + "/" + quote(name, safe="")
        if path in paths:
            raise ValueError(f"装配名称重复：{path}；请为零件提供唯一名字")
        if len(nodes) >= 2048 or path.count("/") > 32 or len(path) > 512:
            raise ValueError("装配节点/层级/路径超过预算")
        paths.add(path)
        t = (location or cq.Location()).wrapped.Transformation()
        matrix = [t.Value(r + 1, c + 1) if r < 3 else float(c == 3)
                  for c in range(4) for r in range(4)]
        nodes.append({"path": path, "name": name, "transform": matrix,
                      **({"parent": parent} if parent else {})})
        return path

    def append(item, name, path, location, color=None):
        if isinstance(item, cq.Workplane):
            item = cq.Compound.makeCompound([s for s in item.vals() if isinstance(s, cq.Shape)])
        if not isinstance(item, cq.Shape) or item.ShapeType() not in ("Solid", "Compound", "CompSolid") or not item.Solids():
            raise ValueError("main 必须返回封闭实体；请拉伸/旋转轮廓后再返回")
        if not item.isValid() or any(not solid.isValid() for solid in item.Solids()):
            raise ValueError(f"无效 BRep 实体：{name}")
        result.append((str(name)[:80], item if location is None else item.moved(location), path,
                       list(color.toTuple()) if color else None))
        if len(result) > 1024:
            raise ValueError("实体数超过 1024")

    def assembly(item, parent=None, placement=None, prefix=None, color=None):
        path = node(item.name, parent, item.loc)
        world = (placement or cq.Location()) * item.loc
        name = f"{prefix}/{item.name}" if prefix else item.name
        color = item.color or color
        if item.obj:
            append(item.obj, name, path, world, color)
        for child in item.children:
            assembly(child, path, world, name, color)

    def visit(item, name=None):
        if isinstance(item, (list, tuple)):
            for child in item:
                visit(child)
        elif isinstance(item, dict):
            visit(item["shape"], item.get("name"))
        elif isinstance(item, cq.Assembly):
            assembly(item)
        elif isinstance(item, cq.Workplane):
            for child in item.vals():
                visit(child, name)
        elif isinstance(item, cq.Shape):
            label = name or f"实体 {len(result) + 1}"
            # A Workplane may contain several solids sharing a human-readable name.
            unique = label if "/" + quote(str(label)[:80], safe="") not in paths else f"{label}_{len(result) + 1}"
            path = node(unique)
            append(item, label, path, None)
        else:
            raise ValueError("main(p) 返回 Workplane、Shape、Assembly 或命名实体数组")

    visit(output)
    return result, nodes


def api_reference(cq, request):
    classes = {name: getattr(cq, name) for name in ("Workplane", "Sketch", "Shape", "Solid", "Face", "Wire", "Edge", "Assembly", "Vector", "Location", "Plane")}
    def basis(vector):
        return [0 if value == 0 else value for value in vector.toTuple()]
    frames = {name: {"x": basis(cq.Plane.named(name).xDir),
                     "y": basis(cq.Plane.named(name).yDir),
                     "normal": basis(cq.Plane.named(name).zDir)}
              for name in ("XY", "XZ", "YZ", "YX", "ZX", "ZY")}
    module, member = request.get("module"), request.get("member")
    if module is None:
        return {"coordinateFrames": frames, "modules": {name: [m for m in dir(cls) if not m.startswith("_")] for name, cls in classes.items()}}
    if module not in classes:
        raise ValueError("未知 CadQuery 类，请查询模块目录")
    cls = classes[module]
    names = [member] if member else [m for m in dir(cls) if not m.startswith("_")]
    result = {}
    for name in names:
        if not isinstance(name, str) or name.startswith("_") or not hasattr(cls, name):
            raise ValueError("未知 CadQuery 方法")
        method = getattr(cls, name)
        try:
            signature = str(inspect.signature(method))
        except (TypeError, ValueError):
            signature = "见本版本 API 说明"
        result[name] = {"signature": signature, "documentation": (inspect.getdoc(method) or "")[:10000 if member else 500]}
    return {"module": module, "installedApi": result, **({"coordinateFrames": frames} if module == "Plane" else {})}


def display_meshes(items, limits):
    """Preserve the default tessellation quality and reject only the hard mesh ceiling."""
    meshes, count = [], 0
    for _name, shape, _path, _color in items:
        vertices, triangles = shape.tessellate(0.1, 0.1)
        count += len(triangles)
        if len(triangles) > limits["maxPartTriangles"] or count > limits["maxTotalTriangles"]:
            raise ValueError(f"显示网格超过预算（单部件 {limits['maxPartTriangles']}、"
                             f"总计 {limits['maxTotalTriangles']} 个三角形）；"
                             "预览精度未降低，本次候选未提交。STEP 导出仍仅针对已保存设计")
        if not triangles:
            raise ValueError("有效实体未生成显示网格；请检查建模源码")
        meshes.append((vertices, triangles))
    return meshes, {"linearTolerance": 0.1, "angularTolerance": 0.1, "adjusted": False}


def brep_bounds(shape, cq):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    # CadQuery's default box can use an existing display mesh and its deflection.
    BRepBndLib.AddOptimal_s(shape.wrapped, box, False, False)
    return cq.BoundBox(box)


def run(request):
    import cadquery as cq

    if request["operation"] == "api":
        return {"engine": "cadquery", "version": cq.__version__, **api_reference(cq, request)}
    program = request["program"]
    namespace = {"__name__": "atria_design"}
    exec(compile(program["source"], "design.py", "exec"), namespace)
    definitions, effective = parameters(namespace, program["parameters"])
    if not callable(namespace.get("main")):
        raise ValueError("请定义 main(p) 返回 CadQuery 实体")
    output = namespace["main"](effective)
    items, nodes = shapes(output, cq)
    design_fn = namespace.get("get_design_manifest")
    design = design_fn(effective) if request["operation"] == "mesh" and callable(design_fn) else None
    if not items:
        if request["operation"] != "mesh":
            raise ValueError("空模型不能导出；请先生成有效实体")
        return {"positions": [], "features": [], "dimensions": [0, 0, 0],
                "volume": 0, "definitions": definitions, "parameters": effective,
                **({"design": design} if design is not None else {})}
    compound = cq.Compound.makeCompound([shape for _, shape, _path, _color in items])
    bbox = brep_bounds(compound, cq)
    solids = [solid for _, shape, _path, _color in items for solid in shape.Solids()]
    metadata = {
        "engine": "cadquery",
        "version": cq.__version__,
        "valid": True,
        "solids": len(solids),
        "faces": sum(len(s.Faces()) for s in solids),
        "bounds": [[bbox.xmin, bbox.ymin, bbox.zmin], [bbox.xmax, bbox.ymax, bbox.zmax]],
    }
    if request["operation"] in ("step", "stl"):
        path = os.path.join(os.getcwd(), "model." + request["operation"])
        if request["operation"] == "step" and isinstance(output, cq.Assembly):
            # CadQuery's STEP exporter doesn't inherit colors from group-only nodes.
            # Propagate on a copy so the export matches the preview without changing main's tree.
            export_assembly = output._copy()
            def inherit_color(part, parent_color=None):
                part.color = part.color or parent_color
                for child in part.children:
                    inherit_color(child, part.color)
            inherit_color(export_assembly)
            export_assembly.export(path, exportType="STEP", mode="default")
        elif request["operation"] == "step":
            export_assembly = cq.Assembly(name="model")
            for i, (name, shape, _path, color) in enumerate(items):
                export_assembly.add(shape, name=f"{name}_{i}", **({"color": cq.Color(*color)} if color else {}))
            export_assembly.export(path, exportType="STEP", mode="default")
        else:
            cq.exporters.export(compound, path, exportType="STL", tolerance=0.1, angularTolerance=0.1)
        return {"file": os.path.basename(path), "brep": metadata}
    motion_fn = namespace.get("get_motion")
    motion = motion_fn(effective) if callable(motion_fn) else None
    meshes, tessellation = display_meshes(items, request["limits"])
    features, positions = [], []
    for i, (name, shape, path, color) in enumerate(items):
        vertices, triangles = meshes[i]
        mesh = [v for t in triangles for index in t for v in vertices[index].toTuple()]
        b = brep_bounds(shape, cq)
        features.append({"id": f"solid_{i}", "name": name, "positions": mesh, "path": path,
                         **({"color": color} if color else {}),
                         "brep": {"valid": True, "solids": len(shape.Solids()),
                                  "faces": sum(len(s.Faces()) for s in shape.Solids()),
                                  "volume": sum(s.Volume() for s in shape.Solids())},
                         "bounds": [[b.xmin, b.ymin, b.zmin], [b.xmax, b.ymax, b.zmax]]})
        positions.extend(mesh)
    return {
        "positions": positions,
        "features": features,
        "assembly": nodes,
        **({"motion": motion} if motion is not None else {}),
        **({"design": design} if design is not None else {}),
        "dimensions": [bbox.xlen, bbox.ylen, bbox.zlen],
        "volume": sum(s.Volume() for s in solids),
        "definitions": definitions,
        "parameters": effective,
        "brep": metadata,
        "tessellation": tessellation,
    }


if __name__ == "__main__":
    request = json.load(sys.stdin)
    budget = math.ceil(request["timeoutMs"] / 1000)
    resource.setrlimit(resource.RLIMIT_CPU, (budget + 1, budget + 2))
    export_bytes = request["limits"]["maxExportBytes"]
    resource.setrlimit(resource.RLIMIT_FSIZE, (export_bytes, export_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    # macOS does not reliably enforce RLIMIT_AS/DATA; the parent watches RSS.
    wire = sys.stdout
    try:
        # Design print output must never corrupt the JSON transport.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        json.dump({"ok": True, "result": result}, wire, allow_nan=False, separators=(",", ":"))
    except BaseException as error:
        frames = traceback.extract_tb(error.__traceback__)
        line = next((f.lineno for f in reversed(frames) if f.filename == "design.py"), None)
        json.dump({"ok": False, "error": f"{type(error).__name__}: {error}", "line": line or getattr(error, "lineno", None)}, wire)

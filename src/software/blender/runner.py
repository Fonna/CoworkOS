"""Trusted bridge. All model Python runs in the host's restricted Blender process."""
import contextlib
import io
import json
import math
import os
import sys
import traceback
import uuid

import bpy
from mathutils import Quaternion, Vector

MAX_OBJECTS = 1000
MAX_TRIANGLES = 2_000_000


class BoundedLog(io.TextIOBase):
    def __init__(self):
        self.text = ""

    def write(self, value):
        self.text = (self.text + str(value))[-4096:]
        return len(value)

    def flush(self):
        pass


def object_ids():
    seen = set()
    for obj in bpy.context.scene.objects:
        value = obj.get("atria_id")
        if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value) or value in seen:
            value = uuid.uuid4().hex
            obj["atria_id"] = value
        seen.add(value)


def material_values(obj):
    color = list(obj.color)
    metallic, roughness = 0.0, 0.5
    material = obj.active_material
    if material:
        color = list(material.diffuse_color)
        metallic, roughness = material.metallic, material.roughness
        if material.use_nodes:
            node = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if node:
                color = list(node.inputs["Base Color"].default_value)
                metallic = node.inputs["Metallic"].default_value
                roughness = node.inputs["Roughness"].default_value
    return color, metallic, roughness


def rotation_degrees(obj):
    # Inspector writes XYZ Euler angles; report the equivalent rotation for all native modes.
    if obj.rotation_mode == "QUATERNION":
        rotation = obj.rotation_quaternion
    elif obj.rotation_mode == "AXIS_ANGLE":
        angle, x, y, z = obj.rotation_axis_angle
        rotation = Quaternion(Vector((x, y, z)), angle)
    else:
        rotation = obj.rotation_euler.to_quaternion()
    return [math.degrees(v) for v in rotation.to_euler("XYZ")]


def inspect_scene(diagnostics=""):
    objects = list(bpy.context.scene.objects)
    if len(objects) > MAX_OBJECTS:
        raise ValueError("场景对象超过 1000 项预算")
    object_ids()
    graph = bpy.context.evaluated_depsgraph_get()
    report, bounds, triangles, warnings = [], [], 0, []
    for obj in objects:
        vertices, faces = 0, 0
        if obj.type in {"MESH", "CURVE", "SURFACE", "FONT", "META"}:
            evaluated = obj.evaluated_get(graph)
            mesh = evaluated.to_mesh()
            try:
                if mesh:
                    mesh.calc_loop_triangles()
                    vertices, faces = len(mesh.vertices), len(mesh.loop_triangles)
                    triangles += faces
                    if triangles > MAX_TRIANGLES:
                        raise ValueError("场景三角面超过 200 万预算")
                    if faces:
                        bounds.extend([list(evaluated.matrix_world @ Vector(corner)) for corner in evaluated.bound_box])
            finally:
                evaluated.to_mesh_clear()
        color, metallic, roughness = material_values(obj)
        report.append({"id": obj["atria_id"], "name": obj.name, "type": obj.type,
                       "parent": obj.parent.get("atria_id") if obj.parent else None,
                       "position": list(obj.location), "rotation": rotation_degrees(obj),
                       "scale": list(obj.scale), "dimensions": list(obj.dimensions),
                       "color": color, "metallic": metallic, "roughness": roughness,
                       "vertices": vertices, "triangles": faces})
        if obj.modifiers:
            warnings.append(f"{obj.name} 的 GLB 预览包含求值后的修改器结果；完整修改器保存在 .blend 中")
    limits = [[min(v[i] for v in bounds) for i in range(3)], [max(v[i] for v in bounds) for i in range(3)]] if bounds else [[0, 0, 0], [0, 0, 0]]
    return {"blenderVersion": bpy.app.version_string, "objects": report, "triangles": triangles,
            "bounds": limits, "camera": bpy.context.scene.camera.get("atria_id") if bpy.context.scene.camera else None,
            "warnings": warnings[:20], "diagnostics": diagnostics}


def apply_edits(edits):
    lookup = {obj.get("atria_id"): obj for obj in bpy.context.scene.objects}
    # Resolve every target first. Missing targets never produce a partly applied batch.
    for edit in edits:
        if edit["id"] not in lookup:
            raise ValueError(f"对象不存在：{edit['id']}")
    for edit in edits:
        obj = lookup[edit["id"]]
        if "name" in edit:
            obj.name = edit["name"]
        if "position" in edit:
            obj.location = edit["position"]
        if "rotation" in edit:
            obj.rotation_mode = "XYZ"
            obj.rotation_euler = [math.radians(v) for v in edit["rotation"]]
        if "scale" in edit:
            obj.scale = edit["scale"]
        if any(key in edit for key in ("color", "metallic", "roughness")):
            if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT", "META"}:
                raise ValueError("这个对象不支持基础材质编辑")
            old = obj.active_material
            material = old.copy() if old else bpy.data.materials.new(obj.name + " 材质")
            material.use_nodes = True
            node = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if not node:
                raise ValueError("复杂材质请通过建模代码或原生 Blender 修改")
            if obj.data.users > 1:
                # Material slots belong to mesh data. A linked duplicate must retain its own appearance.
                obj.data = obj.data.copy()
            for key, socket in (("color", "Base Color"), ("metallic", "Metallic"), ("roughness", "Roughness")):
                if key in edit:
                    node.inputs[socket].default_value = edit[key]
                    attr = "diffuse_color" if key == "color" else key
                    setattr(material, attr, edit[key])
            if obj.data.materials:
                obj.data.materials[obj.active_material_index] = material
            else:
                obj.data.materials.append(material)
    bpy.context.view_layer.update()


def render_png(directory, report, options):
    scene = bpy.context.scene
    if options.get("camera") is not None:
        selector = options["camera"]
        camera = next((obj for obj in scene.objects if obj.get("atria_id") == selector), None)
        if camera is None:
            camera = scene.objects.get(selector)
        if camera is None or camera.type != "CAMERA":
            raise ValueError("渲染相机不存在或不是相机：" + selector)
        scene.camera = camera
    if not scene.camera:
        lower, upper = map(Vector, report["bounds"])
        center = (lower + upper) / 2
        radius = max((upper - lower).length / 2, 0.5)
        data = bpy.data.cameras.new("CoworkOS 预览相机")
        camera = bpy.data.objects.new("CoworkOS 预览相机", data)
        scene.collection.objects.link(camera)
        camera.location = center + Vector((1.4, -2.0, 1.3)).normalized() * radius * 4.5
        camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
        data.clip_start = max(0.001, radius / 1000)
        data.clip_end = max(100, radius * 100)
        scene.camera = camera
        for name, direction, energy in (("CoworkOS 主光", (1, -2, 3), 1000), ("CoworkOS 补光", (-2, 0, 1), 600)):
            light = bpy.data.lights.new(name, "AREA")
            light.energy = energy * radius * radius
            light.shape = "DISK"
            light.size = radius * 3
            obj = bpy.data.objects.new(name, light)
            scene.collection.objects.link(obj)
            obj.location = center + Vector(direction) * radius * 2
            obj.rotation_euler = (center - obj.location).to_track_quat("-Z", "Y").to_euler()
        world = bpy.data.worlds.new("CoworkOS 预览环境")
        world.use_nodes = True
        world.node_tree.nodes["Background"].inputs[0].default_value = (0.15, 0.17, 0.22, 1)
        world.node_tree.nodes["Background"].inputs[1].default_value = 0.4
        scene.world = world
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = options.get("samples", 16)
    scene.render.resolution_x = options.get("width", options.get("resolution", 512))
    scene.render.resolution_y = options.get("height", options.get("resolution", 512))
    if "denoise" in options:
        scene.cycles.use_denoising = options["denoise"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = os.path.join(directory, "render.png")
    bpy.ops.render.render(write_still=True)


def api_reference(request):
    allowed = {"bpy", "bpy.data", "bpy.ops", "bpy.types", "bmesh", "mathutils"}
    module = request.get("module", "bpy")
    if module not in allowed:
        raise ValueError("不支持这个 API 模块")
    value = __import__(module.split(".")[0])
    for part in module.split(".")[1:]:
        value = getattr(value, part)
    member = request.get("member", "")
    for part in member.split(".") if member else []:
        if not part.isidentifier() or part.startswith("_"):
            raise ValueError("无效 API 成员")
        value = getattr(value, part)
    return {"blenderVersion": bpy.app.version_string, "module": module, "member": member,
            "documentation": (getattr(value, "__doc__", "") or "")[:10000],
            "members": [name for name in dir(value) if not name.startswith("_")][:200]}


def execute_python(request, log):
    namespace = {"bpy": bpy, "__name__": "__atria_model__"}
    with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        exec(compile(request["source"], "model.py", "exec"), namespace)
        if callable(namespace.get("main")):
            return namespace["main"](request.get("parameters", {}))
        return namespace.get("result")


def run(request, directory, log):
    if request["operation"] == "api":
        return api_reference(request)
    if request.get("inputBlend"):
        bpy.ops.wm.open_mainfile(filepath=os.path.join(directory, "input.blend"), load_ui=False, use_scripts=False)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    if request.get("resetScene"):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    if request["operation"] == "query":
        value = execute_python(request, log)
        # No native save, derived export or commit. All changes in this process are discarded.
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if len(encoded) > 64_000:
            raise ValueError("查询返回 JSON 超过 64000 字符预算")
        return {"value": value, "diagnostics": log.text}
    if request["operation"] == "python":
        execute_python(request, log)
    elif request["operation"] == "edit":
        apply_edits(request["edits"])
    if request["operation"] == "render" and "frame" in request.get("renderOptions", {}):
        bpy.context.scene.frame_set(request["renderOptions"]["frame"])
    bpy.context.view_layer.update()
    report = inspect_scene(log.text)
    if request["operation"] in {"python", "edit", "import"}:
        if not any(obj["triangles"] for obj in report["objects"]):
            raise ValueError("候选场景没有可显示的网格，已保存工程未改变")
        # Pack dependencies so the snapshot survives job cleanup and app relocation.
        bpy.ops.file.pack_all()
        missing = [image.name for image in bpy.data.images if image.source == "FILE" and not image.packed_file and not image.has_data]
        if missing or any(library.filepath for library in bpy.data.libraries):
            raise ValueError("工程包含未打包的贴图或链接库。请先在原生 Blender 中打包资源并本地化链接对象：" + ", ".join(missing[:5]))
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, "scene.blend"), check_existing=False, compress=True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(directory, "preview.glb"), export_format="GLB",
                                  export_extras=True, export_apply=True, export_animations=False,
                                  export_cameras=False, export_lights=False, export_yup=True)
        render_png(directory, report, {"resolution": 384, "samples": 8})
    elif request["operation"] == "render":
        render_png(directory, report, request.get("renderOptions", {}))
    return report


if __name__ == "__main__":
    request_path = sys.argv[sys.argv.index("--") + 1]
    with open(request_path, encoding="utf8") as handle:
        request = json.load(handle)
    directory = request["directory"]
    log = BoundedLog()
    try:
        result = run(request, directory, log)
        response = {"ok": True, "result": result}
    except BaseException as error:
        response = {"ok": False, "error": f"{type(error).__name__}: {error}", "diagnostics": log.text + "\n" + traceback.format_exc()[-3000:]}
    with open(os.path.join(directory, "result.json"), "w", encoding="utf8") as handle:
        json.dump(response, handle, ensure_ascii=False, allow_nan=False)
    if not response["ok"]:
        raise RuntimeError(response["error"])

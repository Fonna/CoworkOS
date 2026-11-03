import bpy


def main(p):
    """Named components preserve their manual transform and material on repeated runs."""
    width = p.get("width", 2.4)
    assert 1 <= width <= 5, "机器人宽度应为 1–5"

    def box(name, size, position, color):
        obj = bpy.data.objects.get(name)
        if obj is None:
            bpy.ops.mesh.primitive_cube_add(size=1, location=position)
            obj = bpy.context.object
            obj.name = name
            material = bpy.data.materials.new(name + "Material")
            material.use_nodes = True
            node = material.node_tree.nodes.get("Principled BSDF")
            node.inputs["Base Color"].default_value = (*color, 1)
            node.inputs["Metallic"].default_value = 0.2
            node.inputs["Roughness"].default_value = 0.35
            obj.data.materials.append(material)
            bevel = obj.modifiers.new("SoftEdges", "BEVEL")
            bevel.width = 0.07
            bevel.segments = 2
        obj.dimensions = size
        return obj

    blue, dark, glow = (0.12, 0.35, 0.8), (0.025, 0.04, 0.07), (0.15, 0.9, 0.8)
    box("Body", (width, 1.2, 2), (0, 0, 2.8), blue)
    box("Head", (1.9, 1.35, 1.25), (0, 0, 4.65), blue)
    box("EyeLeft", (0.32, 0.12, 0.32), (-0.45, -0.72, 4.75), glow)
    box("EyeRight", (0.32, 0.12, 0.32), (0.45, -0.72, 4.75), glow)
    box("Mouth", (0.7, 0.12, 0.12), (0, -0.72, 4.3), dark)
    box("ArmLeft", (0.55, 0.75, 1.7), (-width / 2 - 0.4, 0, 2.85), blue)
    box("ArmRight", (0.55, 0.75, 1.7), (width / 2 + 0.4, 0, 2.85), blue)
    box("LegLeft", (0.65, 0.8, 1.1), (-0.65, 0, 1.1), dark)
    box("LegRight", (0.65, 0.8, 1.1), (0.65, 0, 1.1), dark)
    box("FootLeft", (0.8, 1.25, 0.35), (-0.65, -0.2, 0.35), blue)
    box("FootRight", (0.8, 1.25, 0.35), (0.65, -0.2, 0.35), blue)
    box("Chest", (0.75, 0.12, 0.6), (0, -0.65, 3.1), glow)
    print("robot_width", width)
    print("robot_components", len(bpy.context.scene.objects))

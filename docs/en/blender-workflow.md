# Blender workbench (compatibility)

English | [中文](../blender-workflow.md)

This workbench retains editing support for existing Blender documents. Use [Blender Harness](external-applications.md#blender-harness) for new 3D tasks. Modeling execution, native import, and rendering in existing projects still require the [Blender component](optional-components.md).

## Open an existing project

Open an existing Blender document from its original conversation or the Applications file list. In that workbench, choose File → Import .blend project to load a native file. Imports must be nonempty and no larger than 64 MiB. Pack textures and localize linked libraries in Blender before importing.

To continue editing with CoworkOS, load the project into a conversation and describe the scene, dimensions, materials, and output format.

## Edit a scene

Select an object in the view or list to edit its name, position, rotation, and scale. Supported objects also expose color, metallic, and roughness. Save to update the scene. Positions use Blender scene units; rotations use degrees.

Open Code to edit Python/bpy source and JSON parameters. Save keeps the source draft; Run and save scene executes it. Choose a time limit before running. Enable clearing the scene before running only when you intend to rebuild it.

View render switches to the rendered image, and fit shows the whole scene. Change comparison shows version differences; Undo restores the previous change. The property panel provides object and basic material editing. Complex topology, nodes, and rigs can be handled through bpy or external Blender.

## Save and export

Click Save or press ⌘/Ctrl+S. After a successful save, check the preview. Use Retry preview if it fails to load.

The File menu provides:

| Format | Contents                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------- |
| .blend | Native project for backup and further editing                                                     |
| GLB    | Derived model for previews, engines, or other tools; its format differs from a full Blender scene |
| PNG    | Rendered scene image                                                                              |
| Python | Modeling source draft                                                                             |

Exports other than Python require a successfully generated scene. Download `.blend` for a portable backup; copying the workbench project manifest alone does not preserve the full scene.

If a conflict occurs or a save result is uncertain, follow the editor's retry or draft backup options. Reload discards current changes. See [files and applications](../task-workspace-layout.md#产出物与草稿) for original files and managed copies, and the [Blender technical reference](../blender-integration.md) (Chinese) for execution limits and development details.

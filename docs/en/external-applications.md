# External application reference

English | [中文](../external-applications.md)

Install the relevant software, plugin and runtime, then [register the plugin](../../src/applications/plugins/README.md#外部插件目录仅注册) (Chinese). Choose its entry in the desktop App's Applications panel and wait for the connection and view before sending a request. The entry does not install dependencies.

## Blender Harness

Requires external Blender, an enabled Blender MCP addon and a working MCP server environment. The desktop App attempts to launch Blender and place its real window beside CoworkOS.

Name the objects, dimensions, materials and output paths in your request. For example:

```text
Create a blue cylinder in the current scene, radius 1 and height 2, named sample-cylinder. Save deliverables/sample-cylinder.blend and export a GLB with the same name. List the actual saved paths in your reply.
```

Save through Blender itself. The external scene does not use the built-in Blender editor's version history.

## FreeCAD Harness

Requires external FreeCAD, its loaded freecad-mcp addon and runtime. Check the connection first. The desktop App attempts to launch FreeCAD and place its real window beside CoworkOS.

Ask to create or modify a document and verify dimensions through object properties. For example:

```text
Create a 50 × 30 × 5 mm plate with a central through-hole of diameter 8 mm. Inspect the overall dimensions and hole diameter, save deliverables/plate.FCStd, export deliverables/plate.step, and report the actual paths.
```

## CAD Harness

Requires external CAD Harness, its build123d/Python environment and CAD Viewer. The desktop App shows the viewer beside the conversation. External tools handle modeling, inspection and export.

Output formats include STEP, STL, GLB and 3MF. Keep both the .step.py generator and .step output for revisions. See [application features](applications.md) for each application's entry point and capabilities.

## OfficeHarness

Requires an installed and registered OfficeHarness plugin and its runtime. Wait for the Impress workspace beside the conversation to load before editing or requesting changes. Finish active text input first.

Opening or saving a local PPTX requires an explicitly selected and mounted directory. For example:

```text
Open report.pptx in the directory I have mounted. Change the title on slide 2 to “This week's progress” and preserve the other content. Save as report-revised.pptx and verify the saved path and file state.
```

Complex tables, masters, animations and Chinese input still have compatibility limits. Check the slides and saved result before delivery. For CoworkOS's included PPT editor, see the [presentation editing reference](presentation-workflow.md).

## Saving and recovery

A Harness session record restores a connection. Save project files through the external application, and back them up with their assets. [Component management](optional-components.md) manages its own components and does not install these external plugins.

For integration, paths and development contracts, see [software integration](../software-integration.md#harness-应用) (Chinese).

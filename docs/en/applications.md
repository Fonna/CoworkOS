# Applications

English | [中文](../applications.md)

Applications offers four built-in workbenches: text, PPT, CAD and Blender. Edit directly in CoworkOS. Existing external application sessions still open from their original conversation or the Applications file list.

Click an application name in the sidebar to expand or collapse its existing instances; use the adjacent “+” to create an independent instance. “Use in conversation” returns to a conversation already linked to that instance. On first use it creates a new conversation (a temporary conversation when there is no project), without automatically linking to another selected or recent conversation. To load an instance into an existing conversation, select it from that conversation’s composer.

Application headers provide direct “Use in conversation” and “Task panel” icon buttons. The conversation action is hidden when a conversation is already visible. When an application and its linked conversation appear together, the task panel replaces global navigation on the left and can be toggled independently. Collapsing or closing the application view restores the previous navigation and task panel state.

## Built-in applications

### Text editor

Edit plain text and Markdown manually, or select a passage for CoworkOS to revise.

- Open, edit and download TXT and Markdown files.
- Apply changes to a selection or a specified range while preserving the rest.
- Save automatically, compare changes, review history and resolve concurrent edits.

[Text editor reference](text-editor.md)

### PPT

Create and revise presentations on the slide canvas, or ask CoworkOS to read and edit specific slides.

- Import PPTX and JSON/PPTIST decks; edit text, images, shapes, charts and tables.
- Adjust slide order, themes and layouts, and retain speaker notes.
- Export PPTX and keep JSON/PPTIST source files for further editing.

[Presentation editing reference](presentation-workflow.md)

### CAD workbench

Create or open CAD projects and edit and inspect models in CoworkOS. Exact calculation in CadQuery projects requires the CAD component.

- Modify CadQuery/Python or JSCAD source and existing parameters.
- Inspect parts, dimensions and calculation results using sections, wireframes and exploded views.
- Export project JSON, source, STL and PNG; CadQuery projects also support STEP.

[CAD workbench reference](cad-workflow.md)

### Blender workbench

Create or open Blender projects and edit and inspect scenes in CoworkOS. Modeling execution, native import and rendering require the Blender component.

- Adjust object position, rotation, scale and basic materials.
- Edit Python/bpy source and parameters, then execute them to update the scene.
- Import or export .blend projects, and export GLB, rendered PNG and Python source.

[Blender workbench reference](blender-workflow.md)

## External application compatibility

The integrations below retain support for existing sessions and resources and no longer appear as default creation options.

### Blender Harness

Operate scenes, materials and lighting in external Blender. Requires a separate Blender installation, an enabled Blender MCP addon and a working MCP server environment.

- Continue editing with CoworkOS in the real Blender window.
- Save .blend projects and export GLB or other model files.

[Blender Harness integration reference](external-applications.md#blender-harness)

### FreeCAD Harness

Create and modify documents in external FreeCAD. Requires a separate FreeCAD installation, a loaded freecad-mcp addon and its runtime.

- Create, modify and query objects; read properties and verify dimensions.
- Continue manual editing in FreeCAD, save native projects and export models.

[FreeCAD Harness integration reference](external-applications.md#freecad-harness)

### CAD Harness

Build parametric models with build123d and view the 3D result beside the conversation. Requires a separately installed and registered CAD Harness, a build123d/Python environment and CAD Viewer.

- Generate models from dimensions and geometry requirements, retaining .step.py parametric source.
- Inspect dimensions and geometry, render the model and open the 3D viewer.
- Export STEP, STL, GLB and 3MF.

[CAD Harness integration reference](external-applications.md#cad-harness)

### OfficeHarness

Edit PPTX in an external Impress workspace, with you and CoworkOS working on the same deck. Requires a separately installed and registered OfficeHarness plugin and its runtime.

- Read and modify slides, objects and text, then continue manual editing in the workspace.
- Open and save local PPTX files in explicitly mounted directories.

[OfficeHarness integration reference](external-applications.md#officeharness)

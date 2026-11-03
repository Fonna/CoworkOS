# CAD workbench (compatibility)

English | [中文](../cad-workflow.md)

This workbench retains editing support for existing CAD documents. Use [CAD Harness](external-applications.md#cad-harness) for new 3D modeling tasks. Exact calculation in existing CadQuery projects still requires the [CAD component](optional-components.md).

## Open an existing design

Open an existing CAD document from its original conversation or the Applications file list. The workbench retains CAD JSON projects and imported Python and JSCAD designs. Python uses CadQuery; JavaScript/JSCAD uses JSCAD.

To have CoworkOS modify an existing design, load the document into a conversation, then describe the dimensions, units, and constraints.

## Adjust and inspect

Open Code to edit the modeling source, then Update model to calculate a preview. If the model declares adjustable parameters, change them in Properties. Select a part to inspect its properties, or use Parts to find it and toggle visibility.

Use viewing directions, fit, transparency/wireframe, sections, and exploded views to inspect geometry. Checks brings together model checks, calculation errors, and logs. Display changes do not alter the design source. Projects with motion tracks can play them; this does not validate dynamics or collisions.

Existing basic-shape documents still let you add boxes, cylinders, and spheres, adjust dimensions and transforms, and combine or cut shapes. This mode exports JSON and STL and can be upgraded to a JSCAD source project.

## Save and export

Click Save or press ⌘/Ctrl+S to save the design. Undo reverses the last save. Updating the model previews it; the design still needs saving. See [files and applications](../task-workspace-layout.md#产出物与草稿) for shared file behavior.

Choose a format under File → Export:

| Format            | Purpose and scope                                                    |
| ----------------- | -------------------------------------------------------------------- |
| Full project JSON | Keep source, parameters, and project information for further editing |
| Python / JSCAD    | Download source for the current engine                               |
| STEP              | Exact solids and assemblies from CadQuery                            |
| STL               | Static triangle mesh                                                 |
| PNG               | Four views or the current view                                       |

If calculation fails, inspect the reason and fix the source or parameters before retrying. Complex models can use a longer generation limit in the code panel. If the component is missing or disabled, open its settings from the editor.

For the external build123d workflow, see [CAD Harness](external-applications.md#cad-harness). Engine details, parameter protocols, and development information are in the [CAD technical reference](../cad-integration.md) (Chinese).

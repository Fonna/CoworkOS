# Component management

[中文](../optional-components.md) | English

The Mac App includes the PPT editor and automatically prepares CadQuery/Python and Blender runtimes for CAD/Blender resources and import tools after first launch. You do not need to install Python or provide a GitHub account. Ordinary conversations remain available during downloads; wait for a component to be ready before using its native features.

Applications offers two editors, text and PPT, plus four Harness entries. Existing CAD/Blender resources can still be opened and edited.

See [applications](applications.md) for editors and external application entries. This page covers components managed by CoworkOS. Harness software and plugins need separate setup; see [external applications](external-applications.md).

## Package scope

| Component | Setup                                    | Guide                                     |
| --------- | ---------------------------------------- | ----------------------------------------- |
| PPT       | Included with the App; no extra download | [Presentations](presentation-workflow.md) |
| CAD       | Automatically downloads CadQuery/Python  | [CAD modeling](cad-workflow.md)           |
| Blender   | Automatically downloads Blender          | [Blender scenes](blender-workflow.md)     |

Native components currently target Apple Silicon macOS. Check the release notes for the supported scope.

## Selection and recovery

Open Settings → Applications and components to check status and download progress, retry a failed download, or enable and disable components. Disabled components stay disabled. Compatible installed components remain available after App updates.

Initial setup needs network access and enough disk space. For offline use, finish installation while online, or choose a full offline archive if the release notes provide one. Ordinary conversations still work while components are unavailable.

Uninstalling removes only components managed by CoworkOS; it preserves documents, tasks, and other system installations. If the PPT editor is missing, follow the prompt to reinstall CoworkOS. For custom runtime problems, see [component paths and CLI commands](components-reference.md).

## CLI and source development

CLI users can install components manually. See the [component reference](components-reference.md) for installation, controls, and path settings.

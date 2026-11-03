# Component paths and CLI commands

English | [中文](../components-reference.md)

For App controls, see [component management](optional-components.md).

```sh
coworkos components list
coworkos components list --refresh
coworkos components install cadquery
coworkos components install blender
coworkos components install pptist
coworkos components upgrade cadquery
coworkos components cancel cadquery
coworkos components disable cadquery
coworkos components enable cadquery
coworkos components uninstall cadquery
```

Installation reports progress and waits for completion; press Ctrl-C to cancel. Retry after a failure. An existing working version is preserved. Enable disabled components manually. Uninstalling removes only managed components, retaining system installations and user files.

## Custom runtimes

Set `COWORK_CADQUERY_PYTHON` or `COWORK_BLENDER_EXECUTABLE` to use an external runtime ahead of CoworkOS's managed version. Settings shows the actual version. Repair or clear an invalid override first.

## Storage

Components live under `~/.atria/components/` by default. `ATRIA_HOME` changes the entire data root; `ATRIA_COMPONENTS_HOME` changes only the component directory. App updates reuse compatible components. See [workspace persistence](../task-workspace-layout.md) (Chinese) for the layout.

See [Mac release](mac-release.md#public-component-releases) for component builds and distribution.

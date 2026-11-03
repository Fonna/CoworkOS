import { pptistEditorAdapter } from "./adapters/pptist-editor.js";
import { cadEditorAdapter } from "./adapters/cad-editor.js";
import { textEditorAdapter } from "./adapters/text-editor.js";
import { blenderEditorAdapter } from "./adapters/blender-editor.js";
import {
  createHarnessEditorAdapter,
  cadHarnessEditorAdapter,
  officeHarnessEditorAdapter
} from "./adapters/harness-editor.js";

const blenderHarnessEditorAdapter = createHarnessEditorAdapter("blender-harness", {
  appName: "Blender Harness",
  appIcon: "i-blender"
});
const freecadHarnessEditorAdapter = createHarnessEditorAdapter("freecad-harness", {
  appName: "FreeCAD Harness",
  appIcon: "i-cube"
});

/** UI adapters are assembled here; the main page only hosts them. */
export function createWorkbenchRegistry(
  adapters = [
    textEditorAdapter,
    cadEditorAdapter,
    blenderEditorAdapter,
    pptistEditorAdapter,
    blenderHarnessEditorAdapter,
    freecadHarnessEditorAdapter,
    cadHarnessEditorAdapter,
    officeHarnessEditorAdapter
  ]
) {
  const registry = Object.create(null);
  for (const adapter of adapters) {
    const appType = adapter.definition?.appType;
    if (!appType) throw new Error("UI adapter definition requires appType");
    if (registry[appType]) throw new Error(`UI adapter already registered: ${appType}`);
    registry[appType] = adapter;
  }
  return Object.freeze(registry);
}

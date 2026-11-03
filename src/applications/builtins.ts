import { pptistRuntimeAdapter } from "./adapters/pptist-runtime-adapter.js";
import { ApplicationRegistry } from "./registry.js";
import { cadRuntimeAdapter } from "./adapters/cad-runtime-adapter.js";
import { textRuntimeAdapter } from "./adapters/text-runtime-adapter.js";
import { dummyCounterAdapter } from "./adapters/dummy-counter-adapter.js";
import { createBlenderRuntimeAdapter } from "./adapters/blender-runtime-adapter.js";
import { registerHarnessPlugins } from "./plugins/index.js";

/** Trusted runtime adapters are assembled here, independently of business services. */
export function defaultRegistry(workspaceRoot = process.cwd()): ApplicationRegistry {
  const registry = new ApplicationRegistry()
    .register(textRuntimeAdapter)
    .register(pptistRuntimeAdapter)
    .register(cadRuntimeAdapter)
    .register(createBlenderRuntimeAdapter(workspaceRoot));
  registerHarnessPlugins(registry);
  // A different data model exercises the contract without shipping a demo app by default.
  if (process.env.COWORK_APPLICATION_DUMMY === "1") registry.register(dummyCounterAdapter);
  return registry;
}

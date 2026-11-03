import { createBlenderHarnessAdapter } from "./blender-harness/adapter.js";
import { createCadHarnessAdapter } from "./cad-harness/adapter.js";
import { createFreecadHarnessAdapter } from "./freecad-harness/adapter.js";
import { createOfficeHarnessAdapter } from "./office-harness/adapter.js";
import type { ApplicationRegistry } from "../registry.js";

/**
 * Harness plugins — lightweight applications that own no modeling engine and
 * instead surface the tools of an external stdio MCP server, so the agent can
 * drive a *running* external GUI application (Blender) or render STEP-first
 * parametric CAD in the embedded cad-viewer.
 *
 * Each plugin is three files under its own directory, mirroring the coderix
 * harness pattern adapted to CoworkOS's application contract:
 *
 * - `paths.ts`   env-overridable path/host/port resolvers
 * - `mcp.ts`     the `McpServerSpec` for the external MCP server
 * - `adapter.ts` a `WorkbenchRuntimeAdapter` over a minimal session descriptor
 *
 * The workflow prompt lives in `.pi/skills/<name>/SKILL.md`, referenced through
 * the adapter's `skillRoots`.
 */
export function registerHarnessPlugins(registry: ApplicationRegistry): ApplicationRegistry {
  return registry
    .register(createBlenderHarnessAdapter())
    .register(createCadHarnessAdapter())
    .register(createFreecadHarnessAdapter())
    .register(createOfficeHarnessAdapter());
}

import type { McpServerSpec } from "../../types.js";
import {
  resolveCadHarnessRoot,
  resolveCadPython,
  resolveCadServerPath,
  resolveCadSkillDir
} from "./paths.js";

/**
 * The external cad_harness `cad-control` stdio MCP server (a Python FastMCP
 * server, launched with the CAD interpreter that has build123d/cadgen). The
 * agent controls the CAD component through it: render/export/inspect/snapshot/
 * artifact_build/list_artifacts/focus + execute_cad_code.
 *
 * The launch shape mirrors the plugin's `plugin.json` `mcp.cad-control` block,
 * but is built from resolvers so the `CAD_PYTHON` / `CAD_HARNESS_PATH` env
 * overrides keep working: the actual server entry point, skills and interpreter
 * all resolve against the external plugin directory (see `paths.ts`), so this
 * file only declares how to start it.
 *
 * Declared, not registered: the platform's {@link McpSupervisor} starts it when
 * a bound window needs tools. The resolved values are written into the spec's
 * env because the MCP SDK's stdio subprocess only inherits a whitelist of env
 * vars, so ambient values would not survive the launch.
 */
export function buildCadControlMcpServerSpec(): McpServerSpec {
  const python = resolveCadPython();
  return {
    command: python || "python3",
    args: [resolveCadServerPath()],
    env: {
      CAD_PYTHON: python,
      CAD_HARNESS_PATH: resolveCadHarnessRoot(),
      CAD_SKILL_DIR: resolveCadSkillDir()
    }
  };
}

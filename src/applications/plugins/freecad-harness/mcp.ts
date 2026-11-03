import { resolveFreecadHost, resolveFreecadMcpDir, resolveFreecadUv } from "./paths.js";
import type { McpServerSpec } from "../../types.js";

/**
 * The external freecad-mcp stdio server (upstream freecad-mcp, launched with
 * `uv` against the freecad-mcp checkout). The agent drives a running FreeCAD
 * through it; the addon listens on the XML-RPC port (default 9875).
 *
 * Declared, not registered: the platform's {@link McpSupervisor} starts it when
 * a bound window needs tools and stops it when the last window closes. The
 * `uv` path and `--host` are resolved to absolute values because the MCP SDK's
 * stdio subprocess only inherits a whitelist of env vars, so a bare `uv` or an
 * ambient host would not survive the launch. `--only-text-feedback` keeps every
 * tool result text-only (no ImageContent), which pure-text models need.
 */
export function buildFreecadMcpServerSpec(): McpServerSpec {
  return {
    command: resolveFreecadUv(),
    args: [
      "--directory",
      resolveFreecadMcpDir(),
      "run",
      "freecad-mcp",
      "--only-text-feedback",
      "--host",
      resolveFreecadHost()
    ]
  };
}

import { resolveBlenderHost, resolveBlenderMcpDir, resolveBlenderPort, resolveBlenderUv } from "./paths.js";
import type { McpServerSpec } from "../../types.js";

/**
 * The official Blender MCP stdio server, launched with `uv` against the
 * blender_plugins checkout (`<root>/mcp/blender`, resolved via the plugin
 * registry in `paths.ts`). The agent drives a running Blender through it; the
 * addon listens on the TCP port (default 9876).
 *
 * Declared, not registered: the platform's {@link McpSupervisor} starts it when
 * a bound window needs tools and stops it when the last window closes. The
 * addon endpoint (`BLENDER_MCP_HOST`/`BLENDER_MCP_PORT`) and the absolute `uv`
 * path are written into the spec because the MCP SDK's stdio subprocess only
 * inherits a whitelist of env vars, so neither an ambient `uv` nor an ambient
 * endpoint would survive the launch.
 */
export function buildBlenderMcpServerSpec(): McpServerSpec {
  return {
    command: resolveBlenderUv(),
    args: ["--directory", resolveBlenderMcpDir(), "run", "blender-mcp"],
    env: {
      BLENDER_MCP_HOST: resolveBlenderHost(),
      BLENDER_MCP_PORT: String(resolveBlenderPort())
    }
  };
}

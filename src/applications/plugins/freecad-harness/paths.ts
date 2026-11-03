import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * FreeCAD harness paths — resolve the freecad-mcp source locations the
 * "freecad-harness" application drives. The plugin only registers freecad-mcp
 * as an external stdio server; it never owns the modeling workflow itself.
 *
 * Everything defaults to known checkouts, overridable via env
 * (`FREECAD_MCP_DIR` / `FREECAD_UV` / `FREECAD_RPC_HOST` / `FREECAD_RPC_PORT`)
 * so the integration isn't pinned to one machine.
 */

/**
 * The freecad-mcp server dir (containing `pyproject.toml` with the
 * `freecad-mcp` entry point). Prefers an explicit `FREECAD_MCP_DIR`, then the
 * sibling `freecad-mcp` checkout under `~/Documents/apps/cad_project/`.
 */
export function resolveFreecadMcpDir(): string {
  const override = process.env.FREECAD_MCP_DIR?.trim();
  if (override) return override;
  return join(homedir(), "Documents", "apps", "cad_project", "freecad-mcp");
}

/**
 * `uv` interpreter used to launch the MCP server. Must be an absolute path: the
 * MCP SDK's stdio subprocess only inherits a whitelist of env vars (PATH may be
 * absent), so a bare `uv` would not resolve.
 */
export function resolveFreecadUv(): string {
  const override = process.env.FREECAD_UV?.trim();
  if (override) return override;
  const local = join(homedir(), ".local", "bin", "uv");
  if (existsSync(local)) return local;
  return "uv";
}

/** The FreeCAD addon's XML-RPC host (the addon listens on it inside FreeCAD). */
export function resolveFreecadHost(): string {
  return (process.env.FREECAD_RPC_HOST || "127.0.0.1").trim();
}

/** The FreeCAD addon's XML-RPC port (freecad-mcp hardcodes 9875). */
export function resolveFreecadPort(): number {
  return Number(process.env.FREECAD_RPC_PORT || 9875);
}

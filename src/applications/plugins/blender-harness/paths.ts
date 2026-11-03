import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, readPluginManifest, resolveRegisteredPluginDir } from "../plugin-registry.js";

/**
 * Blender harness paths — resolve the official Blender MCP server source
 * locations the "blender-harness" application drives. This is a *separate*
 * integration from the native `blender` application (`src/software/blender/`):
 * the harness only registers the upstream Blender MCP as an external stdio
 * server, which drives a running Blender over TCP.
 *
 * The plugin's real content lives in an *external* self-contained directory
 * (registered in `~/.atria/plugin-registry.json` as `blender-harness`, i.e.
 * `~/Documents/apps/blender_plugins`). This file only resolves that directory;
 * the `plugin.json` manifest inside it names the workflow prompt (see
 * `readBlenderWorkflowPrompt`).
 *
 * Values are overridable via env (`BLENDER_MCP_DIR` / `BLENDER_UV` /
 * `BLENDER_MCP_HOST` / `BLENDER_MCP_PORT`) so the integration isn't pinned to
 * one machine.
 */

/** The registered blender_plugins root (registry → default checkout). */
export function resolveBlenderPluginRoot(): string {
  const registered = resolveRegisteredPluginDir("blender-harness");
  if (registered) return registered;
  return join(homedir(), "Documents", "apps", "blender_plugins");
}

/**
 * The official Blender MCP server dir (`<root>/mcp/blender`, containing
 * `pyproject.toml` with the `blender-mcp` entry point). Prefers an explicit
 * `BLENDER_MCP_DIR` env var, then the self-contained checkout under the plugin
 * root.
 */
export function resolveBlenderMcpDir(): string {
  const override = process.env.BLENDER_MCP_DIR?.trim();
  if (override) return override;
  return join(resolveBlenderPluginRoot(), "mcp", "blender");
}

/**
 * `uv` interpreter used to launch the MCP server. Must be an absolute path: the
 * MCP SDK's stdio subprocess only inherits a whitelist of env vars (PATH may be
 * absent), so a bare `uv` would not resolve. Prefers `BLENDER_UV` env, then the
 * plugin's `.env`, then the known local checkout.
 */
export function resolveBlenderUv(): string {
  const override = process.env.BLENDER_UV?.trim();
  if (override) return override;
  const fromEnvFile = loadDotEnv(resolveBlenderPluginRoot())["BLENDER_UV"];
  if (fromEnvFile) return fromEnvFile;
  const local = join(homedir(), ".local", "bin", "uv");
  if (existsSync(local)) return local;
  return "uv";
}

/** The Blender MCP addon's TCP host (the addon listens on it inside Blender). */
export function resolveBlenderHost(): string {
  return (process.env.BLENDER_MCP_HOST || "127.0.0.1").trim();
}

/** The Blender MCP addon's TCP port (default 9876). */
export function resolveBlenderPort(): number {
  return Number(process.env.BLENDER_MCP_PORT || 9876);
}

/** The plugin's vendored skills root (`blender`, `blender-viewer`). */
export function resolveBlenderSkillsRoot(): string {
  return join(resolveBlenderPluginRoot(), "skills");
}

/**
 * Read the workflow prompt: the file named by the plugin's `plugin.json`
 * `agent.systemPromptFile` (`prompt.md`). Empty string when the plugin is
 * partial — callers fall back to the local `blender-harness` skill.
 */
export function readBlenderWorkflowPrompt(): string {
  const root = resolveBlenderPluginRoot();
  const candidates = [readPluginManifest(root)?.systemPromptFile, "prompt.md"].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    try {
      return readFileSync(join(root, candidate), "utf-8").trim();
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

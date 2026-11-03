import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Plugin registry + manifest — CoworkOS's own "registration" surface for the
 * harness plugins.
 *
 * A harness plugin (cad-harness / blender-harness / office-harness) ships its
 * real content — the MCP server, its skills, its workflow prompt and its
 * machine-local `.env` — in an *external* self-contained directory. This project
 * only keeps a thin adapter that resolves that directory (from the registry
 * below) and maps its `plugin.json` manifest onto CoworkOS's application contract.
 *
 * Registry file: `<ATRIA_HOME | ~/.atria>/plugin-registry.json`
 *
 *   { "plugins": [ { "name": "cad-harness", "path": "/abs/path/to/cad-harness" } ] }
 */

export const PLUGIN_REGISTRY_PATH = join(
  process.env.ATRIA_HOME || join(homedir(), ".atria"),
  "plugin-registry.json"
);

export interface RegisteredPlugin {
  /** Explicit name from the registry entry, or "" when it must be derived. */
  name: string;
  /** Absolute path to the plugin directory. */
  path: string;
}

/**
 * Read the plugin registry. Returns `[]` when the file is absent or malformed —
 * the caller then falls back to its env override / legacy default.
 */
export function readPluginRegistry(): RegisteredPlugin[] {
  if (!existsSync(PLUGIN_REGISTRY_PATH)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PLUGIN_REGISTRY_PATH, "utf-8")) as unknown;
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];

  const list = (raw as Record<string, unknown>).plugins;
  if (!Array.isArray(list)) return [];

  const out: RegisteredPlugin[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      if (entry.trim()) out.push({ name: "", path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path.trim() : "";
      if (!path) continue;
      out.push({ name: typeof record.name === "string" ? record.name : "", path });
    }
  }
  return out;
}

/** Resolve a registered plugin's directory by name (matches `name` or basename). */
export function resolveRegisteredPluginDir(name: string): string | undefined {
  for (const entry of readPluginRegistry()) {
    if (entry.name === name || basename(entry.path) === name) return entry.path;
  }
  return undefined;
}

/** Parse a minimal `KEY=VALUE` env file (comments and blank lines skipped). */
export function loadDotEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  const file = join(dir, ".env");
  if (!existsSync(file)) return env;
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) env[match[1]] = match[2];
    }
  } catch {
    /* unreadable .env — ignore */
  }
  return env;
}

/** The subset of `plugin.json` the harness adapters consume. */
export interface PluginManifest {
  name: string;
  /** Path (relative to the plugin dir) to the workflow prompt, e.g. `prompt.md`. */
  systemPromptFile?: string;
}

/** Read + parse a `plugin.json` manifest. Returns null when absent or invalid. */
export function readPluginManifest(pluginPath: string): PluginManifest | null {
  const manifestPath = join(pluginPath, "plugin.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (!name) return null;

  const agent =
    record.agent && typeof record.agent === "object" ? (record.agent as Record<string, unknown>) : {};
  return {
    name,
    ...(typeof agent.systemPromptFile === "string" ? { systemPromptFile: agent.systemPromptFile } : {})
  };
}

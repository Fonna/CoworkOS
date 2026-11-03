import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, readPluginManifest, resolveRegisteredPluginDir } from "../plugin-registry.js";

/**
 * OfficeHarness paths — resolve the office-harness plugin source locations the
 * "office-harness" application drives: the `officeharness` MCP server (a Node
 * stdio server launched with the plugin's bundled runtime), the browser-hosted
 * Impress WASM editor, and the shared profile where `connection.json`, mounts
 * and source archives live.
 *
 * The plugin's real content lives in an *external* self-contained directory
 * (registered in `~/.atria/plugin-registry.json` as `office-harness`, i.e.
 * `~/Documents/apps/OfficeHarness/officeharness_plugins/office-harness`). This
 * file only resolves that directory and its layout; the `plugin.json` manifest
 * inside it names the workflow prompt, and the skills tree is loaded from
 * `<root>/skills`.
 *
 * Resolution order: `OFFICEHARNESS_PLUGIN_ROOT` env → registered plugin dir → the
 * legacy `officeharness-v3` checkout, so the integration isn't pinned to one
 * machine (and a dev checkout can override the registered copy, matching the
 * coderix preview manager). The profile (`OFFICEHARNESS_PROFILE_DIR` → the
 * plugin's `.env` → the machine default) must match what the desktop preview
 * manager uses, so the MCP server and the embedded editor attach to the same
 * host.
 */

export function resolveOfficeHarnessRoot(): string {
  const override = process.env.OFFICEHARNESS_PLUGIN_ROOT?.trim();
  if (override) return override;
  const registered = resolveRegisteredPluginDir("office-harness");
  if (registered) return registered;
  return join(homedir(), "Documents", "apps", "OfficeHarness", "officeharness-v3");
}

/** The shared profile dir (`connection.json`, mounts, exports). */
export function resolveOfficeHarnessProfile(): string {
  const override = process.env.OFFICEHARNESS_PROFILE_DIR?.trim();
  if (override) return override;
  const fromEnvFile = loadDotEnv(resolveOfficeHarnessRoot())["OFFICEHARNESS_PROFILE_DIR"];
  if (fromEnvFile) return fromEnvFile;
  return join(homedir(), ".coderix", "officeharness", "embedded");
}

/** The plugin's bundled Node runtime (used to launch the MCP server). */
export function resolveOfficeHarnessNode(): string {
  return join(resolveOfficeHarnessRoot(), "runtime", "bin", "node");
}

/** The officeharness MCP server entry point (`plugin.json` `mcp.officeharness.args`). */
export function resolveOfficeHarnessMcpPath(): string {
  return join(resolveOfficeHarnessRoot(), "host", "mcp.cjs");
}

/** The plugin's vendored skills root (`ppt`). */
export function resolveOfficeHarnessSkillsRoot(): string {
  return join(resolveOfficeHarnessRoot(), "skills");
}

/**
 * Read the orchestration workflow prompt: the file named by the plugin's
 * `plugin.json` `agent.systemPromptFile` (`prompt.md`). Empty string when the
 * plugin is partial — callers fall back to the local `office-harness` skill.
 */
export function readOfficeWorkflowPrompt(): string {
  const root = resolveOfficeHarnessRoot();
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

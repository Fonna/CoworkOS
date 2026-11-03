import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, readPluginManifest, resolveRegisteredPluginDir } from "../plugin-registry.js";

/**
 * CAD harness paths — resolve the cad_harness source locations the
 * "cad-harness" application drives: the `cad-control` MCP server, the CAD
 * interpreter (`CAD_PYTHON` with build123d/cadgen), and the cad-viewer runtime.
 *
 * The plugin's real content lives in an *external* self-contained directory
 * (registered in `~/.atria/plugin-registry.json` as `cad-harness`, i.e.
 * `~/Documents/apps/cad_project/cad_plugins/cad-harness`). This file only
 * resolves that directory and its layout; the `plugin.json` manifest inside it
 * names the workflow prompt, and the skills tree is loaded from `<root>/skills`.
 *
 * Resolution order: registered plugin dir → `CAD_HARNESS_PATH` env → the legacy
 * `cad_harness` checkout, so the integration isn't pinned to one machine. The
 * two layouts differ (plugin: `<root>/skills`; legacy: `<root>/claude_dir/skills`),
 * detected the same way coderix_main does.
 */

export function resolveCadHarnessRoot(): string {
  const registered = resolveRegisteredPluginDir("cad-harness");
  if (registered) return registered;
  const override = process.env.CAD_HARNESS_PATH?.trim();
  if (override) return override;
  return join(homedir(), "Documents", "apps", "cad_project", "cad_harness");
}

/** True when the root uses the plugin layout (`skills/`) vs legacy (`claude_dir/skills/`). */
function isPluginLayout(root: string): boolean {
  return existsSync(join(root, "skills")) && !existsSync(join(root, "claude_dir"));
}

function skillsRoot(root: string): string {
  return isPluginLayout(root) ? join(root, "skills") : join(root, "claude_dir", "skills");
}

/**
 * Python interpreter with build123d/OCP/cadgen installed. Prefers an explicit
 * `CAD_PYTHON`, then the value recorded in the harness `.env`. Empty string
 * means "not configured" — callers fall back to the system `python3`.
 */
export function resolveCadPython(): string {
  const fromEnv = process.env.CAD_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  return loadDotEnv(resolveCadHarnessRoot())["CAD_PYTHON"] ?? "";
}

/** The vendored `cad` skill dir (the cad-control server shells out to it). */
export function resolveCadSkillDir(): string {
  return join(skillsRoot(resolveCadHarnessRoot()), "cad");
}

/**
 * The vendored skills root — every skill is a subdir with a SKILL.md. Pointing
 * `skillRoots` here enumerates the whole set (cad, cad-viewer, cad-plan,
 * cad-component-generation, step-parts, urdf, …) exactly as the plugin's
 * `plugin.json` advertises, so a cad-harness conversation can invoke any of them.
 */
export function resolveCadSkillsRoot(): string {
  return skillsRoot(resolveCadHarnessRoot());
}

/**
 * Read the orchestration workflow prompt: the file named by the plugin's
 * `plugin.json` `agent.systemPromptFile` (`prompt.md`), falling back to the
 * legacy `claude_dir/CLAUDE_cad.md`. Empty string when the checkout is partial —
 * callers fall back to the local `cad-harness` skill, which stays available.
 */
export function readCadWorkflowPrompt(): string {
  const root = resolveCadHarnessRoot();
  const candidates = [
    readPluginManifest(root)?.systemPromptFile,
    "prompt.md",
    join("claude_dir", "CLAUDE_cad.md")
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      return readFileSync(join(root, candidate), "utf-8").trim();
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

/** The cad-control MCP server entry point (`plugin.json` `mcp.cad-control.args`). */
export function resolveCadServerPath(): string {
  return join(resolveCadHarnessRoot(), "mcp", "cad-control", "server.py");
}

/** The scripts/viewer dir the cad-viewer is launched from. */
export function resolveCadViewerScriptDir(): string {
  return join(skillsRoot(resolveCadHarnessRoot()), "cad-viewer", "scripts", "viewer");
}

"use strict";

/**
 * OfficeHarness runtime — the electron-free half of the office-harness
 * integration.
 *
 * Lives in a module that does not import `electron` so the risky pieces (resolving
 * the plugin root/profile, probing the managed host's `connection.json`, loading
 * the plugin's `managed-host.cjs`) can be exercised headlessly and unit tested.
 * The electron half (WebContentsView + IPC) lives in `office-harness.cjs`.
 *
 * Unlike cad-viewer (which spawns `npm --prefix … run start`), OfficeHarness ships
 * a `managed-host.cjs` that owns the detached local HTTP service, the persistent
 * origin, the profile lock and client leases. We call it through `require` (the
 * plugin is CJS) so the desktop does not duplicate any lifecycle logic: the MCP
 * server (see `src/applications/plugins/office-harness/mcp.ts`) and this preview
 * manager attach to the exact same host and profile.
 */

const { readFileSync, existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atriaHome } = require("../scripts/data-home.cjs");

/**
 * CoworkOS's own plugin registry (`<atriaHome>/plugin-registry.json`), separate from
 * coderix_main's. The preview resolves the office-harness plugin dir the same way
 * the application adapter does. Returns [] when absent/malformed.
 */
function readPluginRegistry() {
  const file = path.join(process.env.COWORK_DESKTOP_DATA || atriaHome(), "plugin-registry.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return [];
  }
}

function resolveRegisteredPluginDir(name) {
  for (const entry of readPluginRegistry()) {
    const entryPath = typeof entry === "string" ? entry : entry.path;
    const entryName = typeof entry === "string" ? "" : entry.name;
    if ((entryName && entryName === name) || path.basename(entryPath) === name) return entryPath;
  }
  return undefined;
}

/** The bundled OfficeHarness plugin root: env → registry → dev checkout. */
function resolveOfficeHarnessRoot() {
  const override = process.env.OFFICEHARNESS_PLUGIN_ROOT?.trim();
  if (override) return override;
  const registered = resolveRegisteredPluginDir("office-harness");
  if (registered) return registered;
  return path.join(os.homedir(), "Documents", "apps", "OfficeHarness", "officeharness-v3");
}

/** Profile shared with the plugin's MCP server (see the plugin's `.env`). */
function resolveOfficeHarnessProfile() {
  const override = process.env.OFFICEHARNESS_PROFILE_DIR?.trim();
  if (override) return override;
  try {
    const content = readFileSync(path.join(resolveOfficeHarnessRoot(), ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*OFFICEHARNESS_PROFILE_DIR\s*=\s*(.+?)\s*$/);
      if (match) return match[1].trim();
    }
  } catch {
    /* no .env — fall back to the default */
  }
  return path.join(os.homedir(), ".coderix", "officeharness", "embedded");
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Read `connection.json` and verify the live host. Returns null when the file is
 * absent, the process is dead, or the origin/protocol does not match.
 */
async function probeHost(profile) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path.join(profile, "connection.json"), "utf-8"));
  } catch {
    return null;
  }
  if (typeof metadata.url !== "string" || typeof metadata.tokenFile !== "string") return null;
  const pid = metadata.pid;
  if (typeof pid !== "number" || !isAlive(pid)) return null;

  let url;
  try {
    url = new URL(metadata.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }

  try {
    const token = readFileSync(metadata.tokenFile, "utf-8").trim();
    // `/status` is authenticated and tiny; `/capabilities` carries the full tool
    // catalog, so it is reserved for the actual attach handshake.
    const response = await fetch(new URL("/status", url), {
      headers: { "X-OfficeHarness-Token": token },
      redirect: "error",
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || typeof payload !== "object") return null;
    return {
      url: url.origin,
      port: Number(url.port),
      pid,
      instance_id: metadata.instance_id ?? ""
    };
  } catch {
    return null;
  }
}

/**
 * Load the plugin's managed-host module (`<root>/host/managed-host.cjs`) so the
 * desktop reuses its `ensureHost` / `attachClient` lifecycle instead of
 * duplicating it. Returns null when the plugin is absent.
 */
function loadManagedHost(root) {
  const entry = path.join(root, "host", "managed-host.cjs");
  if (!existsSync(entry)) return null;
  return require(entry);
}

/**
 * Load the plugin's `containEditor` adapter (`<root>/host/contain-editor.cjs`).
 * It denies user navigation and new windows on a harness-owned WebContents while
 * leaving resource/worker requests alone, so the embedded editor cannot navigate
 * away from its host origin (which would force a reload and a second editor
 * registration). Returns null when the plugin is absent.
 */
function loadContainEditor(root) {
  const entry = path.join(root, "host", "contain-editor.cjs");
  if (!existsSync(entry)) return null;
  const mod = require(entry);
  return typeof mod.containEditor === "function" ? mod.containEditor : null;
}

module.exports = {
  resolveOfficeHarnessRoot,
  resolveOfficeHarnessProfile,
  isAlive,
  probeHost,
  loadManagedHost,
  loadContainEditor
};

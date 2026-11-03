"use strict";

/**
 * CAD viewer runtime — the electron-free half of the cad-viewer integration.
 *
 * Lives in a module that does not import `electron` so the risky pieces (spawning
 * the self-contained cad-viewer on port 3245, scanning a workspace for the latest
 * CAD artifact, building its viewer URL) can be exercised headlessly and unit
 * tested. The electron half (WebContentsView + IPC) lives in `cad-viewer.cjs`.
 *
 * The cad-viewer is a standalone SPA + stdlib-Python backend that renders a
 * `.step.py`/`.step`/`.glb` file at `http://127.0.0.1:3245/<abs-dir>?file=<rel>`.
 * We launch it exactly as cad_harness does (`npm --prefix <viewer>/scripts/viewer
 * run start -- ...`) and parse its `{"url":...}` launcher line to know when it is
 * actually up, instead of polling the port blind.
 */

const { spawn } = require("node:child_process");
const { existsSync, readFileSync, readdirSync, statSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { atriaHome } = require("../scripts/data-home.cjs");
const { desktopBackendEnvironment } = require("./backend-environment.cjs");

const CAD_VIEWER_HOST = "127.0.0.1";
const CAD_VIEWER_PORT = 3245;

/**
 * CoworkOS's own plugin registry (`<atriaHome>/plugin-registry.json`), separate from
 * coderix_main's. The viewer resolves the cad-harness plugin dir the same way the
 * application adapter does. Returns [] when absent/malformed.
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

function resolveCadHarnessRoot() {
  const registered = resolveRegisteredPluginDir("cad-harness");
  if (registered) return registered;
  const override = process.env.CAD_HARNESS_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), "Documents", "apps", "cad_project", "cad_harness");
}

/** True when the root uses the plugin layout (`skills/`) vs legacy (`claude_dir/skills/`). */
function isPluginLayout(root) {
  return existsSync(path.join(root, "skills")) && !existsSync(path.join(root, "claude_dir"));
}

function skillsRoot(root) {
  return isPluginLayout(root) ? path.join(root, "skills") : path.join(root, "claude_dir", "skills");
}

/**
 * Python interpreter with build123d/OCP/cadgen installed. Prefers an explicit
 * `CAD_PYTHON`, then the value recorded in cad_harness's `.env`. Empty string
 * means "let the viewer auto-discover" (the shim does venv + system discovery).
 */
function resolveCadPython() {
  const fromEnv = process.env.CAD_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  try {
    const content = readFileSync(path.join(resolveCadHarnessRoot(), ".env"), "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^\s*CAD_PYTHON\s*=\s*(.+?)\s*$/);
      if (match) return match[1].trim();
    }
  } catch {
    /* no .env */
  }
  return "";
}

/** The scripts/viewer package dir the viewer is launched from. */
function resolveCadViewerScriptDir() {
  return path.join(skillsRoot(resolveCadHarnessRoot()), "cad-viewer", "scripts", "viewer");
}

/**
 * The self-contained step-selector widget (装配体/零件/版本 dropdown strip) shipped
 * inside the cad-harness plugin. Loaded as a separate WebContentsView under the
 * viewer; it is a plain HTML file with no backend.
 */
function resolveCadStepSelectorHtml() {
  return path.join(resolveCadHarnessRoot(), "web", "step-selector", "index.html");
}

// ---------------------------------------------------------------------------
// CAD artifact scanning
// ---------------------------------------------------------------------------

const CAD_EXTS = [".step.py", ".step", ".stp", ".glb"];
const CAD_SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".cadgen",
  "__cadgen__",
  ".cache",
  "cache",
  ".runtime",
  // `agents` is deliberately NOT skipped: the cad-control MCP writes its
  // artifacts into the owning agent's work dir (`agents/main/work/cad/…`),
  // so skipping it would hide every rendered model.
  "runs",
  "sessions",
  "watch",
  "experiments",
  "virtual-agents",
  "applications",
  "history",
  "frames",
  ".claude",
  ".coderix"
]);

/**
 * Recursively find the most recently modified CAD artifact in `dir`, returning
 * its workspace-relative path, mtime (ms) and size (bytes). Null when none.
 */
function scanLatestCadFile(dir) {
  let best = null;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!CAD_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(abs);
      } else if (entry.isFile() && CAD_EXTS.some((ext) => entry.name.endsWith(ext))) {
        try {
          const stat = statSync(abs);
          if (!best || stat.mtimeMs > best.mtimeMs) {
            best = {
              rel: path.relative(dir, abs).split(path.sep).join("/"),
              abs,
              mtimeMs: stat.mtimeMs,
              size: stat.size
            };
          }
        } catch {
          /* unreadable — skip */
        }
      }
    }
  }
  return best;
}

/**
 * The viewer URL for a CAD artifact. The viewer's own scanner skips directories
 * named `artifacts/` (it treats them as generated output), so it must be pointed
 * at the artifact's *own* directory rather than the task workspace root: the URL
 * PATH is the artifact's directory and `file` is its basename. `render` is a
 * cache-busting param (ignored by the viewer) that changes when the artifact is
 * rewritten, so navigating to a new URL re-renders.
 */
function buildViewerUrl(fileAbs, render) {
  const abs = String(fileAbs || "").replace(/\\/g, "/");
  if (!abs) return viewerBaseUrl();
  const slash = abs.lastIndexOf("/");
  const dir = slash >= 0 ? abs.slice(0, slash) : "";
  const file = slash >= 0 ? abs.slice(slash + 1) : abs;
  const pathPart = dir.startsWith("/") ? dir : `/${dir}`;
  const base = `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}${pathPart}`;
  const query = [];
  if (file) query.push(`file=${encodeURIComponent(file)}`);
  if (render) query.push(`render=${encodeURIComponent(String(render))}`);
  return query.length ? `${base}?${query.join("&")}` : base;
}

const viewerBaseUrl = () => `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}/`;

// ---------------------------------------------------------------------------
// Port probing + launcher-line parsing
// ---------------------------------------------------------------------------

function isPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Poll until the port accepts a connection (or `timeoutMs` elapses). */
function waitForPort(host, port, timeoutMs, signal) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      if (signal?.aborted) return resolve(false);
      if (await isPortOpen(host, port, 400)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(check, 200);
    };
    void check();
  });
}

/** The last JSON object line in the launcher stdout (`{"url":...,"port":...}`). */
function parseJsonLine(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      try {
        return JSON.parse(line);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawning the viewer
// ---------------------------------------------------------------------------

/**
 * Spawn the self-contained cad-viewer runtime and resolve once its launcher line
 * reports a URL (or reject on a spawn error, early exit, or timeout). The child
 * keeps running after resolve; the caller owns killing it via the returned child.
 */
function startCadViewer({ timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cad-viewer 启动已取消"));
      return;
    }
    const viewerScriptDir = resolveCadViewerScriptDir();
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const args = [
      "--prefix",
      viewerScriptDir,
      "run",
      "start",
      "--",
      "--host",
      CAD_VIEWER_HOST,
      "--port",
      String(CAD_VIEWER_PORT),
      "--json"
    ];
    const python = resolveCadPython();

    let child;
    try {
      child = spawn(npmCmd, args, {
        cwd: viewerScriptDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...desktopBackendEnvironment(),
          ...(python ? { CAD_PYTHON: python, VIEWER_CAD_PYTHON: python } : {})
        }
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let launcherSeen = false;
    const readinessAbort = new AbortController();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      readinessAbort.abort();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill("SIGTERM");
      } catch {
        /* already exited */
      }
      reject(error);
    };
    const onAbort = () => fail(new Error("cad-viewer 启动已取消"));

    const timer = setTimeout(
      () => fail(new Error(`cad-viewer 启动超时\n${stderrBuf.slice(-2000)}`)),
      timeoutMs
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // Resolve once the launcher line is seen AND the backend is actually serving:
    // the launcher prints its JSON line just before it spawns the real backend,
    // so "JSON seen" alone is still a beat away from "port open".
    const finish = async (url) => {
      const open = await waitForPort(CAD_VIEWER_HOST, CAD_VIEWER_PORT, 20_000, readinessAbort.signal);
      if (settled) return;
      if (!open) {
        fail(new Error(`cad-viewer 端口未就绪\n${stderrBuf.slice(-2000)}`));
        return;
      }
      settled = true;
      cleanup();
      resolve({ child, url });
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
      const match = parseJsonLine(stdoutBuf);
      if (match && !settled && !launcherSeen) {
        launcherSeen = true;
        void finish(typeof match.url === "string" ? match.url : undefined);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf-8");
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code) => fail(new Error(`cad-viewer 退出，code ${code}\n${stderrBuf.slice(-2000)}`)));
  });
}

module.exports = {
  CAD_VIEWER_HOST,
  CAD_VIEWER_PORT,
  resolveCadHarnessRoot,
  resolveCadPython,
  resolveCadViewerScriptDir,
  resolveCadStepSelectorHtml,
  scanLatestCadFile,
  buildViewerUrl,
  viewerBaseUrl,
  isPortOpen,
  parseJsonLine,
  startCadViewer
};

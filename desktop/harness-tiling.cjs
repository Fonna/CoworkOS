"use strict";

/**
 * Harness tiling — the coderix-style "open" behavior for the harness plugins:
 * launch the external FreeCAD/Blender GUI and pin its window flush to the RIGHT
 * of the CoworkOS window, resizing CoworkOS to leave room and following it as the user
 * moves/resizes CoworkOS.
 *
 * Lives in the Electron main process because it needs `screen` and the
 * `BrowserWindow` (the dashboard backend cannot see or resize the window). This
 * mirrors coderix's `freecad-preview.ts` / `blender-preview.ts`, minus their
 * screenshot-to-renderer preview (CoworkOS shows no in-app preview — the user looks
 * at the real external window instead).
 *
 * Repositioning is done from *inside* the external app so no Accessibility
 * permission is needed: FreeCAD via its addon's `execute_code` (Qt
 * `Gui.getMainWindow().setGeometry`), Blender via `ctypes`/ObjC on its own
 * `NSWindow`.
 */

const { screen } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Path / endpoint resolution (env overridable)
// ---------------------------------------------------------------------------

function resolveFreecadBin() {
  const override = process.env.FREECAD_BIN?.trim();
  if (override) return override;
  const candidates = [
    path.join(os.homedir(), "Downloads", "FreeCAD", "build", "debug", "bin", "FreeCAD"),
    "/Applications/FreeCAD.app/Contents/MacOS/FreeCAD"
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "FreeCAD";
}

function resolveFreecadRoot() {
  return path.resolve(path.dirname(resolveFreecadBin()), "..", "..", "..");
}

function resolveFreecadRpcUrl() {
  const host = (process.env.FREECAD_RPC_HOST || "127.0.0.1").trim();
  const port = Number(process.env.FREECAD_RPC_PORT || 9875);
  return `http://${host}:${port}/RPC2`;
}

function resolveBlenderBin() {
  const override = process.env.BLENDER_BIN?.trim();
  if (override) return override;
  const candidates = [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/opt/homebrew/bin/blender",
    "/usr/local/bin/blender"
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "blender";
}

function blenderHost() {
  return (process.env.BLENDER_MCP_HOST || "127.0.0.1").trim();
}

function blenderPort() {
  return Number(process.env.BLENDER_MCP_PORT || 9876);
}

// ---------------------------------------------------------------------------
// Minimal XML-RPC codec (FreeCAD addon; ported from freecad-harness)
// ---------------------------------------------------------------------------

const XML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

function escapeXml(value) {
  return String(value).replace(/[&<>]/g, (c) => XML_ESCAPE[c] ?? c);
}

function decodeEntities(value) {
  return String(value).replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => XML_ENTITIES[`&${e};`] ?? m);
}

function paramValue(value) {
  if (value === undefined || value === null) return "<value><nil/></value>";
  if (typeof value === "number") return `<value><int>${value}</int></value>`;
  if (typeof value === "boolean") return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
  return `<value><string>${escapeXml(value)}</string></value>`;
}

function buildMethodCall(methodName, params = []) {
  return (
    '<?xml version="1.0"?>\n' +
    "<methodCall>\n" +
    `<methodName>${escapeXml(methodName)}</methodName>\n` +
    `<params>${params.map(paramValue).join("")}</params>\n` +
    "</methodCall>"
  );
}

/**
 * Run a snippet of Python inside FreeCAD on its GUI thread (the addon's
 * `execute_code` RPC). Only rejects when the addon is unreachable or the call
 * faults; the snippet itself is assumed to swallow its own errors.
 */
async function executeCode(url, code, timeoutMs = 5000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: buildMethodCall("execute_code", [code]),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`XML-RPC HTTP ${res.status}`);
  const text = await res.text();

  const fault = text.match(/<fault>[\s\S]*?<value>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (fault) throw new Error(`XML-RPC fault: ${decodeEntities(fault[1])}`);

  const success = text.match(/<name>success<\/name>[\s\S]*?<value><boolean>([01])<\/boolean>/);
  if (success && success[1] === "0") {
    const msg = text.match(/<name>message<\/name>[\s\S]*?<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? decodeEntities(msg[1]) : "execute_code failed");
  }
}

// ---------------------------------------------------------------------------
// Blender MCP addon TCP codec (null-byte-delimited JSON)
// ---------------------------------------------------------------------------

function sendCode(host, port, code, strictJson = true, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const request = `${JSON.stringify({ type: "execute", code, strict_json: strictJson })}\0`;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => socket.write(request));

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(0)) !== -1) {
        const raw = buffer.subarray(0, index).toString("utf-8");
        buffer = buffer.subarray(index + 1);
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          fail(new Error(`Blender returned non-JSON data: ${raw.slice(0, 200)}`));
          return;
        }
        if (settled) continue;
        settled = true;
        socket.destroy();
        resolve(parsed);
      }
    });

    socket.on("error", fail);
    socket.on("timeout", () => fail(new Error(`Blender socket timed out (${timeoutMs}ms)`)));
  });
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const APPS = {
  "freecad-harness": { app: "freecad", display: "FreeCAD" },
  "blender-harness": { app: "blender", display: "Blender" }
};

function isRunning(app) {
  const names = app === "blender" ? ["Blender", "blender"] : ["FreeCAD", "freecad"];
  for (const name of names) {
    try {
      execFileSync("pgrep", ["-x", name], { stdio: "ignore" });
      return true;
    } catch {
      /* not running under this name */
    }
  }
  return false;
}

function activate(name) {
  execFile("osascript", ["-e", `tell application "${name}" to activate`], () => {
    /* best-effort */
  });
}

function createHarnessTiling({ getMainWindow }) {
  const freecadRpcUrl = resolveFreecadRpcUrl();
  const host = blenderHost();
  const port = blenderPort();

  let boundWindow = null;
  let destroyed = false;
  const syncTimers = { freecad: null, blender: null };
  const lastLaunchAttempt = { freecad: 0, blender: 0 };
  const followTimers = [];

  /**
   * Resize CoworkOS to the left portion of the usable area (reserving at least 1/3
   * of the width for the external app on the right) and return the external
   * app's target geometry. `(x, y)` is the TOP-LEFT corner for FreeCAD (Qt) and
   * the BOTTOM-LEFT corner for Blender (AppKit). Null when the window is gone.
   */
  function tileFor(app) {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const display = screen.getDisplayMatching(win.getBounds());
    const wa = display.workArea;

    const side = Math.max(Math.floor(wa.width / 3), 480);
    const atriaWidth = Math.max(wa.width - side, 640);
    try {
      win.setBounds({ x: wa.x, y: wa.y, width: atriaWidth, height: wa.height });
    } catch {
      /* best-effort — still tile the external app on the right */
    }

    const left = wa.x + atriaWidth;
    const top = wa.y;
    const height = wa.height;
    if (app === "blender") {
      const bottom = Math.round(display.bounds.y + display.bounds.height - (top + height));
      return { x: left, y: bottom, w: side, h: height };
    }
    return { x: left, y: top, w: side, h: height };
  }

  /** Reposition FreeCAD's own window via Qt (top-left origin). */
  function repositionFreecad(g) {
    const code = [
      "import FreeCADGui",
      "mw = FreeCADGui.getMainWindow()",
      "if mw:",
      `    mw.setGeometry(${g.x}, ${g.y}, ${g.w}, ${g.h})`
    ].join("\n");
    void executeCode(freecadRpcUrl, code, 5000).catch(() => {
      /* addon unreachable — window simply stays put */
    });
  }

  /** Reposition Blender's own window via ctypes/ObjC (bottom-left origin). arm64-only. */
  function repositionBlender(g) {
    const code = [
      "import ctypes, ctypes.util",
      "try:",
      '    objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))',
      "    objc.objc_getClass.restype = ctypes.c_void_p",
      "    objc.objc_getClass.argtypes = [ctypes.c_char_p]",
      "    objc.sel_registerName.restype = ctypes.c_void_p",
      "    objc.sel_registerName.argtypes = [ctypes.c_char_p]",
      "    class NSRect(ctypes.Structure):",
      '        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double), ("w", ctypes.c_double), ("h", ctypes.c_double)]',
      '    NSApp = objc.objc_getClass(b"NSApplication")',
      "    objc.objc_msgSend.restype = ctypes.c_void_p",
      "    objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]",
      '    app = objc.objc_msgSend(NSApp, objc.sel_registerName(b"sharedApplication"))',
      '    win = objc.objc_msgSend(app, objc.sel_registerName(b"mainWindow"))',
      "    if not win:",
      '        wins = objc.objc_msgSend(app, objc.sel_registerName(b"windows"))',
      "        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint64]",
      '        win = objc.objc_msgSend(wins, objc.sel_registerName(b"objectAtIndex:"), 0)',
      "    if win:",
      `        rect = NSRect(${g.x}, ${g.y}, ${g.w}, ${g.h})`,
      "        objc.objc_msgSend.restype = None",
      "        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]",
      '        objc.objc_msgSend(app, objc.sel_registerName(b"activateIgnoringOtherApps:"), 1)',
      "        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]",
      '        objc.objc_msgSend(win, objc.sel_registerName(b"deminiaturize:"), 0)',
      "        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, NSRect, ctypes.c_int]",
      '        objc.objc_msgSend(win, objc.sel_registerName(b"setFrame:display:"), rect, 1)',
      '        result = {"status": "ok"}',
      "    else:",
      '        result = {"status": "error", "message": "no window"}',
      "except Exception as e:",
      '    result = {"status": "error", "message": str(e)}'
    ].join("\n");
    void sendCode(host, port, code, true, 5000).catch(() => {
      /* addon unreachable — window simply stays put */
    });
  }

  function reposition(app, g) {
    if (app === "blender") repositionBlender(g);
    else repositionFreecad(g);
  }

  function spawnDetached(binary, args, options, name) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { ...options, detached: true, stdio: "ignore" });
      // ENOENT/EACCES arrive asynchronously; a surrounding try/catch cannot
      // handle them. Keep the listener after spawn so no child error is uncaught.
      child.once("error", (error) => {
        reject(new Error(`无法启动 ${name}（${binary}）：${error.message}`));
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }

  async function spawnBlender() {
    const g = tileFor("blender");
    const args = [
      ...(g ? ["--window-geometry", String(g.x), String(g.y), String(g.w), String(g.h)] : []),
      "--online-mode"
    ];
    await spawnDetached(resolveBlenderBin(), args, {}, "Blender");
  }

  async function spawnFreecad() {
    const cwd = resolveFreecadRoot();
    await spawnDetached(resolveFreecadBin(), [], { cwd: existsSync(cwd) ? cwd : undefined }, "FreeCAD");
  }

  /** Reposition the running external app flush to CoworkOS's right edge. */
  function syncTiling(app) {
    if (!isRunning(app)) return;
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const left = Math.round(bounds.x + bounds.width);
    const top = Math.round(bounds.y);
    const width = Math.round(Math.max(wa.x + wa.width - left, 640));
    const height = Math.round(Math.max(bounds.height, 480));
    if (app === "blender") {
      const bottom = Math.round(display.bounds.y + display.bounds.height - (top + height));
      repositionBlender({ x: left, y: bottom, w: width, h: height });
    } else {
      repositionFreecad({ x: left, y: top, w: width, h: height });
    }
  }

  function scheduleSync(app) {
    if (destroyed) return;
    if (syncTimers[app]) clearTimeout(syncTimers[app]);
    syncTimers[app] = setTimeout(() => {
      syncTimers[app] = null;
      syncTiling(app);
    }, 200);
  }

  function followWindow() {
    scheduleSync("freecad");
    scheduleSync("blender");
  }

  function ensureWindowBinding() {
    if (destroyed) return;
    const win = getMainWindow();
    if (win === boundWindow) return;
    boundWindow?.removeListener("move", followWindow);
    boundWindow?.removeListener("resize", followWindow);
    boundWindow = win && !win.isDestroyed() ? win : null;
    boundWindow?.on("move", followWindow);
    boundWindow?.on("resize", followWindow);
  }

  async function launch(appType, workspaceDir) {
    if (destroyed) throw new Error("应用正在关闭或重启，请稍后重试");
    const entry = APPS[appType];
    if (!entry) throw new Error(`不支持的 harness 应用：${appType}`);
    const app = entry.app;

    // Bind the window-follow listeners first so every app stays flush to CoworkOS's
    // right as it moves/resizes.
    ensureWindowBinding();

    if (isRunning(app)) {
      activate(entry.display);
      const g = tileFor(app);
      if (g) reposition(app, g);
      return { connected: true, launched: false };
    }

    const now = Date.now();
    if (now - lastLaunchAttempt[app] < 10_000) return { connected: false };
    lastLaunchAttempt[app] = now;

    try {
      if (app === "blender") await spawnBlender();
      else {
        tileFor("freecad");
        await spawnFreecad();
      }
    } catch (error) {
      lastLaunchAttempt[app] = 0;
      throw error;
    }
    if (destroyed) return { connected: false, launched: true };
    if (app === "freecad") {
      // FreeCAD has no --window-geometry flag, so retry the flush-right
      // reposition while it starts (the RPC comes up after the GUI loads).
      for (const ms of [3000, 6000, 10000]) {
        const timer = setTimeout(() => syncTiling("freecad"), ms);
        followTimers.push(timer);
      }
    }
    const timer = setTimeout(() => activate(entry.display), 1500);
    followTimers.push(timer);
    return { connected: false, launched: true };
  }

  function destroy() {
    destroyed = true;
    boundWindow?.removeListener("move", followWindow);
    boundWindow?.removeListener("resize", followWindow);
    boundWindow = null;
    for (const key of Object.keys(syncTimers)) {
      if (syncTimers[key]) clearTimeout(syncTimers[key]);
      syncTimers[key] = null;
    }
    for (const timer of followTimers) clearTimeout(timer);
    followTimers.length = 0;
  }

  ensureWindowBinding();
  return { launch, destroy, bindWindow: ensureWindowBinding };
}

module.exports = { createHarnessTiling };

"use strict";

/**
 * OfficeHarness — the electron half of the office-harness integration.
 *
 * Owns the lifecycle of the OfficeHarness managed host (a browser-hosted
 * LibreOffice/Impress WASM editor) and embeds it as a native `WebContentsView`
 * layered over the renderer's measured app container, mirroring the cad-viewer
 * integration. The host is a *detached* process owned by the plugin's
 * `managed-host.cjs`; we start or reuse it, attach a `preview` client lease, and
 * navigate the native view to the host's workspace URL.
 *
 * The renderer only reports where to place the view (`attach`/`detach`) and
 * reflects the pushed status for its spinner/error overlay. The host enforces
 * COOP/COEP cross-origin isolation, so the WASM editor is loaded in a top-level
 * WebContentsView (never an iframe).
 */

const { existsSync } = require("node:fs");
const path = require("node:path");
const { ipcMain, WebContentsView } = require("electron");
const runtime = require("./office-harness-runtime.cjs");

const CHANNELS = {
  START: "bookman:office-harness:start",
  STATUS: "bookman:office-harness:status",
  ATTACH: "bookman:office-harness:attach",
  DETACH: "bookman:office-harness:detach",
  STATUS_CHANGED: "bookman:office-harness:status-changed"
};

// CoworkOS's workbench surface (--codex-bg in web/assets/starfield.css), so the
// embedded editor reads as one surface with the rest of the workbench.
const THEME_BG = "#070708";
const THEME_CSS = `html, body { background: ${THEME_BG} !important; color-scheme: dark; }`;

function createOfficeHarness({ getMainWindow, trust }) {
  let status = "stopped"; // stopped | starting | running | error
  let lastError = "";
  let view = null;
  let viewWindow = null;
  let detachContain = null;
  let viewUrl = ""; // the URL the view is pointed at (or currently loading)
  let attached = false;
  let bounds = null;
  let starting = null;
  let lease = null;
  let hostPid = 0;
  let currentUrl = "";
  let owner = null;
  let requestGeneration = 0;
  let lifecycleGeneration = 0;
  let destroyed = false;

  function owns(requestOwner) {
    return !destroyed && (requestOwner ?? null) === owner;
  }

  function validateOwner(value) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256))
      throw new Error("无效的视图所有者");
  }

  function terminateHost(pid) {
    if (!pid) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }

  function mainWindow() {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function safeSend(channel, value) {
    const win = mainWindow();
    if (win && !destroyed) win.webContents.send(channel, value);
  }

  function setStatus(next, error = "") {
    status = next;
    lastError = error;
    safeSend(CHANNELS.STATUS_CHANGED, { status: next, error });
  }

  function currentStatus() {
    return { status, url: currentUrl, error: lastError || undefined };
  }

  // -------------------------------------------------------------------------
  // Native view (WebContentsView)
  // -------------------------------------------------------------------------

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    viewWindow = null;
    viewUrl = "";
    detachContain?.();
    detachContain = null;
    const v = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    v.setBackgroundColor(THEME_BG);
    // Contain the editor: deny user navigation and new windows (the plugin's
    // `contain-editor.cjs`) so a stray navigate/redirect cannot leave the host
    // origin and force a reload into a second editor registration.
    const contain = runtime.loadContainEditor(runtime.resolveOfficeHarnessRoot());
    if (contain) detachContain = contain(v.webContents);
    // The host serves the editor over HTTP; keep the surface dark while loading.
    v.webContents.on("did-finish-load", () => {
      if (v.webContents.isDestroyed()) return;
      v.webContents.insertCSS(THEME_CSS).catch(() => {});
    });
    view = v;
    return v;
  }

  function showView(nextBounds) {
    const win = mainWindow();
    if (!win || !nextBounds || nextBounds.width <= 0 || nextBounds.height <= 0) return;
    const v = ensureView();
    try {
      if (viewWindow !== win) {
        hideView();
        win.contentView.addChildView(v);
        viewWindow = win;
      }
      v.setBounds({ x: nextBounds.x, y: nextBounds.y, width: nextBounds.width, height: nextBounds.height });
      const url = currentUrl;
      // Guard on our own tracker, not `getURL()`: it stays "" while the first
      // load is in flight, so a rapid second `attach`/resize would otherwise
      // re-trigger `loadURL` mid-load and register a second editor.
      if (url && url !== viewUrl) {
        viewUrl = url;
        v.webContents.loadURL(url).catch(() => {
          if (view === v && viewUrl === url) viewUrl = "";
        });
      }
    } catch (error) {
      console.warn("[OfficeHarness] view show failed:", error instanceof Error ? error.message : error);
    }
  }

  function hideView() {
    const win = viewWindow;
    viewWindow = null;
    if (view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        /* already detached */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Host lifecycle (mirrors coderix_main's officeharness-preview.ts)
  // -------------------------------------------------------------------------

  async function attachLease(root, profile, assets, service) {
    try {
      const managed = runtime.loadManagedHost(root);
      if (!managed) return null;
      return await managed.attachClient({ profile, root: assets, service, kind: "preview" });
    } catch (error) {
      // The editor page also holds ownership once it registers; a failed lease
      // must not turn a working host into a panel error. It only means the host
      // may idle-close after the panel stops heartbeating.
      console.warn("[OfficeHarness] preview lease failed:", String(error));
      return null;
    }
  }

  async function releaseLease() {
    if (!lease) return;
    const held = lease;
    lease = null;
    try {
      await held.release();
    } catch {
      /* The host may already be closing — the lease is advisory. */
    }
  }

  async function start(requestOwner) {
    validateOwner(requestOwner);
    if (destroyed) return currentStatus();
    if ((requestOwner ?? null) !== owner) {
      attached = false;
      bounds = null;
      hideView();
    }
    owner = requestOwner ?? null;
    const request = ++requestGeneration;
    const generation = lifecycleGeneration;
    const root = runtime.resolveOfficeHarnessRoot();
    const profile = runtime.resolveOfficeHarnessProfile();
    if (!starting) {
      if (status !== "running") setStatus("starting");
      const attempt = (async () => {
        const assets = path.join(root, "host", "assets");
        const serviceFile = path.join(root, "host", "managed-service.cjs");
        const node = path.join(root, "runtime", "bin", "node");
        if (!existsSync(serviceFile) || !existsSync(node)) {
          throw new Error(
            `OfficeHarness 插件未在 ${root} 找到。请把 office-harness 注册到 ~/.atria/plugin-registry.json 或设置 OFFICEHARNESS_PLUGIN_ROOT。`
          );
        }
        let service = await runtime.probeHost(profile);
        if (destroyed || generation !== lifecycleGeneration) return null;
        if (!service) {
          const managed = runtime.loadManagedHost(root);
          if (!managed)
            throw new Error(
              `OfficeHarness 插件缺少 managed-host：${path.join(root, "host", "managed-host.cjs")}`
            );
          service = await managed.ensureHost({
            profile,
            root: assets,
            packageRoot: root,
            port: 0,
            idleGraceMs: 120_000
          });
        }
        if (destroyed || generation !== lifecycleGeneration) {
          if (destroyed) terminateHost(service.pid);
          return null;
        }
        if (lease && (hostPid !== service.pid || currentUrl !== service.url)) await releaseLease();
        const acquired = lease || (await attachLease(root, profile, assets, service));
        if (destroyed || generation !== lifecycleGeneration) {
          try {
            await acquired?.release();
          } catch {
            /* host may already be closing */
          }
          if (destroyed) terminateHost(service.pid);
          return null;
        }
        lease = acquired;
        hostPid = service.pid;
        currentUrl = service.url;
        return service;
      })();
      starting = attempt;
      // Register cleanup after assignment, including immediate validation failures,
      // so installing a missing plugin permits a subsequent start to retry.
      void attempt
        .finally(() => {
          if (starting === attempt) starting = null;
        })
        .catch(() => {});
    }
    try {
      const service = await starting;
      if (
        !service ||
        generation !== lifecycleGeneration ||
        request !== requestGeneration ||
        !owns(requestOwner)
      )
        return currentStatus();
      setStatus("running");
      if (attached && bounds) showView(bounds);
    } catch (error) {
      if (generation !== lifecycleGeneration || request !== requestGeneration || !owns(requestOwner))
        return currentStatus();
      const message = error instanceof Error ? error.message : String(error);
      const friendly = /JSON|Unexpected token|Expected property|Unexpected end/i.test(message)
        ? `OfficeHarness 连接元数据无法读取（${path.join(profile, "connection.json")}）。删除该文件后重试。`
        : message;
      setStatus("error", friendly);
    }
    return currentStatus();
  }

  async function stop() {
    lifecycleGeneration++;
    requestGeneration++;
    starting = null;
    attached = false;
    bounds = null;
    hideView();
    setStatus("stopped");
    await releaseLease();
    return currentStatus();
  }

  // -------------------------------------------------------------------------
  // View bounds (driven by the renderer's measured container)
  // -------------------------------------------------------------------------

  function attach(input) {
    if (!owns(input?.owner)) return currentStatus();
    const width = Math.round(Number(input?.width) || 0);
    const height = Math.round(Number(input?.height) || 0);
    attached = true;
    bounds = {
      x: Math.round(Number(input?.x) || 0),
      y: Math.round(Number(input?.y) || 0),
      width,
      height
    };
    if (width <= 0 || height <= 0) {
      hideView();
      return currentStatus();
    }
    if (status === "running") showView(bounds);
    return currentStatus();
  }

  function detach(requestOwner) {
    if (!owns(requestOwner)) return currentStatus();
    attached = false;
    bounds = null;
    hideView();
    return currentStatus();
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  ipcMain.handle(CHANNELS.START, (event, requestOwner) => {
    trust(event);
    return start(requestOwner);
  });
  ipcMain.handle(CHANNELS.STATUS, (event) => {
    trust(event);
    return currentStatus();
  });
  ipcMain.handle(CHANNELS.ATTACH, (event, input) => {
    trust(event);
    return attach(input);
  });
  ipcMain.handle(CHANNELS.DETACH, (event, requestOwner) => {
    trust(event);
    return detach(requestOwner);
  });

  return {
    start,
    stop,
    status: currentStatus,
    attach,
    detach,
    destroy() {
      destroyed = true;
      void stop();
      // The host is detached and its editor registration only clears on an
      // explicit native close receipt. The WebContentsView dies with the app,
      // so leaving the host behind would leak a process with a stale editor.
      if (hostPid) {
        terminateHost(hostPid);
        hostPid = 0;
      }
      ipcMain.removeHandler(CHANNELS.START);
      ipcMain.removeHandler(CHANNELS.STATUS);
      ipcMain.removeHandler(CHANNELS.ATTACH);
      ipcMain.removeHandler(CHANNELS.DETACH);
      if (detachContain) {
        try {
          detachContain();
        } catch {
          /* already detached */
        }
        detachContain = null;
      }
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
      view = null;
      viewUrl = "";
    }
  };
}

module.exports = { createOfficeHarness };

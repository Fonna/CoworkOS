"use strict";

/**
 * CAD viewer — the electron half of the cad-viewer integration.
 *
 * Owns the lifecycle of the self-contained cad-viewer runtime (port 3245) and
 * embeds it as a native `WebContentsView` layered over the renderer's measured
 * app container. This mirrors coderix's cad-viewer + browser-view managers: a
 * `WebContentsView` is a separate top-level web contents, so it loads the viewer
 * with no CSP `frame-src` / `X-Frame-Options` / `frame-ancestors` interference —
 * which is exactly why the old `<iframe>` approach could never reliably show it.
 *
 * Below the viewer, a second `WebContentsView` hosts the cad-harness plugin's
 * self-contained step-selector widget (装配体 / 零件 rows, each a name `<select>` +
 * a 版本 `<select>`). The main process polls the conversation workspace with
 * `scanSteps` (structured, versioned), pushes the steps into that widget, and
 * navigates the viewer to the currently selected step. The renderer only reports
 * where to put the whole area (`attach`/`detach`) and reflects the pushed status
 * for its spinner/error overlay.
 */

const path = require("node:path");
const { ipcMain, WebContentsView } = require("electron");
const runtime = require("./cad-viewer-runtime.cjs");
const { scanSteps, pickDefaultStep } = require("./cad-step-scanner.cjs");

const CHANNELS = {
  START: "bookman:cad-viewer:start",
  STATUS: "bookman:cad-viewer:status",
  ATTACH: "bookman:cad-viewer:attach",
  DETACH: "bookman:cad-viewer:detach",
  SELECT_STEP: "bookman:cad-viewer:select-step",
  STATUS_CHANGED: "bookman:cad-viewer:status-changed"
};

const POLL_MS = 3000;

// Height of the step-selector strip reserved below the viewer (px).
const SELECTOR_HEIGHT = 64;

// CoworkOS's workbench surface (--codex-bg in web/assets/starfield.css). The
// cad-viewer SPA ships its own light/dark theme, so force its body to this so
// the embedded view reads as one surface with the rest of the workbench.
const THEME_BG = "#070708";
const THEME_CSS = `html, body { background: ${THEME_BG} !important; color-scheme: dark; }`;

function createCadViewer({ getMainWindow, trust }) {
  let child = null;
  let status = "stopped"; // stopped | starting | running | error
  let lastError = "";
  let view = null;
  let viewWindow = null;
  let selectorView = null;
  let selectorWindow = null;
  let selectorLoaded = false;
  let attached = false;
  let bounds = null;
  let workspaceDir = null;
  let pollTimer = null;
  let currentUrl = ""; // "" = landing page
  let lastKey = null;
  let steps = [];
  let selectedId = "";
  let owner = null;
  let requestGeneration = 0;
  let lifecycleGeneration = 0;
  let starting = null;
  let startAbort = null;
  let destroyed = false;

  function owns(requestOwner) {
    return !destroyed && (requestOwner ?? null) === owner;
  }

  function validateOwner(value) {
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 256))
      throw new Error("无效的视图所有者");
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
    return { status, error: lastError || undefined, baseUrl: runtime.viewerBaseUrl() };
  }

  // -------------------------------------------------------------------------
  // Native views (WebContentsView): viewer (top) + step selector (bottom)
  // -------------------------------------------------------------------------

  function ensureView() {
    if (view && !view.webContents.isDestroyed()) return view;
    viewWindow = null;
    const v = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    // Opaque theme background so the view never flashes transparent while loading.
    v.setBackgroundColor(THEME_BG);
    // insertCSS targets the current page; re-apply after each navigation so the
    // viewer's own light/dark theme never shows through on artifact changes.
    v.webContents.on("did-finish-load", () => {
      if (v.webContents.isDestroyed()) return;
      v.webContents.insertCSS(THEME_CSS).catch(() => {});
    });
    view = v;
    return v;
  }

  function ensureSelectorView() {
    if (selectorView && !selectorView.webContents.isDestroyed()) return selectorView;
    selectorWindow = null;
    selectorLoaded = false;
    const v = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "cad-selector-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    v.setBackgroundColor(THEME_BG);
    v.webContents.on("did-finish-load", () => {
      if (v.webContents.isDestroyed()) return;
      selectorLoaded = true;
      pushSteps();
    });
    selectorView = v;
    v.webContents.loadFile(runtime.resolveCadStepSelectorHtml()).catch((error) => {
      console.warn("[CadViewer] selector load failed:", error instanceof Error ? error.message : error);
    });
    return v;
  }

  function showViews(nextBounds) {
    const win = mainWindow();
    if (!win || !nextBounds || nextBounds.width <= 0 || nextBounds.height <= 0) return;
    const selectorH = Math.min(SELECTOR_HEIGHT, nextBounds.height);
    const viewerH = Math.max(0, nextBounds.height - selectorH);

    if (viewerH > 0) {
      const v = ensureView();
      try {
        if (viewWindow !== win) {
          hideView();
          win.contentView.addChildView(v);
          viewWindow = win;
        }
        v.setBounds({ x: nextBounds.x, y: nextBounds.y, width: nextBounds.width, height: viewerH });
        const url = currentUrl || runtime.viewerBaseUrl();
        if (v.webContents.getURL() !== url) v.webContents.loadURL(url).catch(() => {});
      } catch (error) {
        console.warn("[CadViewer] viewer show failed:", error instanceof Error ? error.message : error);
      }
    } else {
      hideView();
    }

    if (selectorH > 0) {
      const s = ensureSelectorView();
      try {
        if (selectorWindow !== win) {
          hideSelectorView();
          win.contentView.addChildView(s);
          selectorWindow = win;
        }
        s.setBounds({
          x: nextBounds.x,
          y: nextBounds.y + viewerH,
          width: nextBounds.width,
          height: selectorH
        });
      } catch (error) {
        console.warn("[CadViewer] selector show failed:", error instanceof Error ? error.message : error);
      }
    } else {
      hideSelectorView();
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

  function hideSelectorView() {
    const win = selectorWindow;
    selectorWindow = null;
    if (selectorView && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(selectorView);
      } catch {
        /* already detached */
      }
    }
  }

  function hideViews() {
    hideView();
    hideSelectorView();
  }

  function navigateView(url) {
    if (!attached || !view) return;
    try {
      if (view.webContents.getURL() !== url) view.webContents.loadURL(url).catch(() => {});
    } catch {
      /* view gone */
    }
  }

  // Push the latest scanned steps + selection into the selector widget.
  function pushSteps() {
    const v = selectorView;
    if (!v || v.webContents.isDestroyed() || !selectorLoaded) return;
    const payload = JSON.stringify(steps);
    const sel = JSON.stringify(selectedId);
    v.webContents
      .executeJavaScript(
        `window.CadStepSelector && window.CadStepSelector.setSteps(${payload}, ${sel}); true`
      )
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function start(workspace, requestOwner) {
    validateOwner(requestOwner);
    if (destroyed) return currentStatus();
    if (workspace !== undefined && (typeof workspace !== "string" || !path.isAbsolute(workspace)))
      throw new Error("无效的工作区路径");
    if ((requestOwner ?? null) !== owner) {
      attached = false;
      bounds = null;
      hideViews();
    }
    owner = requestOwner ?? null;
    const request = ++requestGeneration;
    const generation = lifecycleGeneration;
    const changed = typeof workspace === "string" && workspace !== workspaceDir;
    if (changed) {
      workspaceDir = workspace;
      lastKey = null;
      currentUrl = "";
      steps = [];
      selectedId = "";
    }
    if (!starting) {
      if (status !== "running") setStatus("starting");
      const abort = new AbortController();
      startAbort = abort;
      const attempt = (async () => {
        if (await runtime.isPortOpen(runtime.CAD_VIEWER_HOST, runtime.CAD_VIEWER_PORT)) return null;
        if (abort.signal.aborted) return null;
        return runtime.startCadViewer({ signal: abort.signal });
      })();
      starting = attempt;
      void attempt
        .finally(() => {
          if (starting === attempt) {
            starting = null;
            startAbort = null;
          }
        })
        .catch(() => {});
    }
    try {
      const started = await starting;
      if (destroyed || generation !== lifecycleGeneration) {
        if (started?.child) {
          try {
            started.child.kill("SIGTERM");
          } catch {
            /* already exited */
          }
        }
        return currentStatus();
      }
      if (started?.child && child !== started.child) {
        child = started.child;
        child.once("exit", () => {
          if (child !== started.child) return;
          child = null;
          setStatus("stopped");
        });
      }
      if (request !== requestGeneration || !owns(requestOwner)) return currentStatus();
      setStatus("running");
      ensurePolling();
      // Every activation retargets before displaying, including a reused timer.
      if (changed) poll();
      if (attached && bounds) showViews(bounds);
    } catch (error) {
      if (generation === lifecycleGeneration && request === requestGeneration && owns(requestOwner))
        setStatus("error", error instanceof Error ? error.message : String(error));
    }
    return currentStatus();
  }

  function stop() {
    lifecycleGeneration++;
    requestGeneration++;
    startAbort?.abort();
    starting = null;
    startAbort = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (child) {
      const held = child;
      child = null;
      try {
        held.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    attached = false;
    bounds = null;
    hideViews();
    setStatus("stopped");
  }

  // -------------------------------------------------------------------------
  // Poll the workspace for structured CAD steps, then navigate the viewer to
  // the selected step and refresh the selector widget.
  // -------------------------------------------------------------------------

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, POLL_MS);
    void poll();
  }

  function poll() {
    if (!workspaceDir) return;
    steps = scanSteps(workspaceDir);

    // Default selection on first scan: latest assembly, else first part.
    if (!selectedId) {
      const target = pickDefaultStep(steps);
      if (target) selectedId = target.id;
    }

    const step = steps.find((s) => s.id === selectedId) || null;
    const url =
      step && step.viewerFile
        ? runtime.buildViewerUrl(path.join(workspaceDir, step.viewerFile), step.renderHash)
        : "";
    const key = step ? `${step.viewerFile}:${step.renderHash || ""}` : "";
    if (key !== lastKey || url !== currentUrl) {
      lastKey = key;
      currentUrl = url;
      navigateView(url);
    }
    pushSteps();
  }

  function selectStep(id) {
    if (typeof id !== "string" || !id || !workspaceDir) return;
    if (id === selectedId) return;
    const step = steps.find((s) => s.id === id);
    if (!step) return;
    selectedId = id;
    const url = step.viewerFile
      ? runtime.buildViewerUrl(path.join(workspaceDir, step.viewerFile), step.renderHash)
      : "";
    lastKey = `${step.viewerFile}:${step.renderHash || ""}`;
    currentUrl = url;
    navigateView(url);
    pushSteps();
  }

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
      hideViews();
      return currentStatus();
    }
    if (status === "running") showViews(bounds);
    return currentStatus();
  }

  function detach(requestOwner) {
    if (!owns(requestOwner)) return currentStatus();
    attached = false;
    bounds = null;
    hideViews();
    return currentStatus();
  }

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------

  const selectStepHandler = (event, payload) => {
    if (!selectorView || event.sender !== selectorView.webContents) return;
    const id = payload && typeof payload === "object" ? payload.id : undefined;
    if (typeof id === "string") selectStep(id);
  };

  ipcMain.handle(CHANNELS.START, (event, workspace, requestOwner) => {
    trust(event);
    return start(workspace, requestOwner);
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
  ipcMain.on(CHANNELS.SELECT_STEP, selectStepHandler);

  return {
    start,
    stop,
    status: currentStatus,
    attach,
    detach,
    destroy() {
      destroyed = true;
      stop();
      ipcMain.removeHandler(CHANNELS.START);
      ipcMain.removeHandler(CHANNELS.STATUS);
      ipcMain.removeHandler(CHANNELS.ATTACH);
      ipcMain.removeHandler(CHANNELS.DETACH);
      ipcMain.removeListener(CHANNELS.SELECT_STEP, selectStepHandler);
      if (selectorView && !selectorView.webContents.isDestroyed()) selectorView.webContents.close();
      selectorView = null;
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
      view = null;
    }
  };
}

module.exports = { createCadViewer };

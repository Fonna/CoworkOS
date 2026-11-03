"use strict";

// Native-view lifecycle fixture: real Electron windows and WebContentsViews,
// with local pages replacing the independently distributed CAD/Office engines.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const root = process.env.ATRIA_TEST_HARNESS_FIXTURE;
if (!root || !path.isAbsolute(root)) throw new Error("An isolated fixture directory is required");
app.setPath("userData", path.join(root, "profile"));
app.disableHardwareAcceleration();

const pageUrl = (label) => `data:text/html;charset=utf-8,${encodeURIComponent(`<body>${label}</body>`)}`;
const cadRuntime = require("../../desktop/cad-viewer-runtime.cjs");
cadRuntime.isPortOpen = async () => true;
cadRuntime.viewerBaseUrl = () => pageUrl("CAD viewer fixture");
cadRuntime.resolveCadStepSelectorHtml = () => path.join(root, "selector.html");
const officeRuntime = require("../../desktop/office-harness-runtime.cjs");
officeRuntime.resolveOfficeHarnessRoot = () => root;
officeRuntime.resolveOfficeHarnessProfile = () => path.join(root, "office-profile");
officeRuntime.probeHost = async () => ({ url: pageUrl("Office editor fixture"), pid: 0 });
officeRuntime.loadManagedHost = () => ({ attachClient: async () => ({ release: async () => {} }) });
officeRuntime.loadContainEditor = () => null;
const { createCadViewer } = require("../../desktop/cad-viewer.cjs");
const { createOfficeHarness } = require("../../desktop/office-harness.cjs");

let window;
let cad;
let office;
const views = () =>
  window.contentView.children.filter((view) => view.webContents && view.webContents !== window.webContents);
const bounds = { x: 20, y: 20, width: 600, height: 400 };

async function openWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window = win;
  win.on("closed", () => {
    if (window === win) window = undefined;
  });
  await win.loadURL(pageUrl("Harness lifecycle fixture"));
}

app.on("window-all-closed", () => {});
app.on("will-quit", () => {
  cad?.destroy();
  office?.destroy();
});
app.whenReady().then(async () => {
  const options = { getMainWindow: () => window, trust: () => {} };
  cad = createCadViewer(options);
  office = createOfficeHarness(options);
  globalThis.harnessFixture = {
    async show(kind, owner) {
      if (kind === "cad") await cad.start(path.join(root, "task"), owner);
      else await office.start(owner);
      return (kind === "cad" ? cad : office).attach({ ...bounds, owner });
    },
    detach(kind, owner) {
      return (kind === "cad" ? cad : office).detach(owner);
    },
    snapshot() {
      return views().map((view) => ({
        id: view.webContents.id,
        url: view.webContents.getURL(),
        bounds: view.getBounds()
      }));
    },
    async contents() {
      return Promise.all(
        views().map((view) => view.webContents.executeJavaScript("document.body.innerText"))
      );
    },
    reopen: openWindow
  };
  await openWindow();
});

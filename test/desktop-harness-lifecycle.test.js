import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../desktop/", import.meta.url));

async function loadHost(file, overrides = {}, processValue = process) {
  const filename = path.join(desktop, file);
  const source = await readFile(filename, "utf8");
  const mod = { exports: {} };
  const localRequire = createRequire(filename);
  const load = (name) => (Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name));
  new Function("require", "module", "exports", "__dirname", "process", source)(
    load,
    mod,
    mod.exports,
    desktop,
    processValue
  );
  return mod.exports;
}

function nativeFixture() {
  const handlers = new Map();
  const views = [];
  class WebContentsView {
    constructor() {
      views.push(this);
      const wc = (this.webContents = new EventEmitter());
      wc.url = "";
      wc.closed = false;
      wc.loads = [];
      wc.isDestroyed = () => wc.closed;
      wc.getURL = () => wc.url;
      wc.loadURL = async (url) => {
        wc.url = url;
        wc.loads.push(url);
      };
      wc.loadFile = async () => {};
      wc.insertCSS = async () => {};
      wc.executeJavaScript = async () => {};
      wc.close = () => {
        wc.closed = true;
      };
    }
    setBackgroundColor() {}
    setBounds(bounds) {
      this.bounds = bounds;
    }
  }
  function makeWindow() {
    const win = new EventEmitter();
    win.destroyed = false;
    win.isDestroyed = () => win.destroyed;
    win.children = new Set();
    win.webContents = { send() {} };
    win.getBounds = () => ({ x: 0, y: 0, width: 960, height: 800 });
    win.setBounds = () => {};
    win.contentView = {
      addChildView(v) {
        win.children.add(v);
      },
      removeChildView(v) {
        win.children.delete(v);
      }
    };
    win.close = () => {
      win.destroyed = true;
      win.children.clear();
      win.emit("closed");
    };
    return win;
  }
  const electron = {
    WebContentsView,
    ipcMain: {
      handle: (name, fn) => handlers.set(name, fn),
      on() {},
      removeHandler: (name) => handlers.delete(name),
      removeListener() {}
    },
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        bounds: { x: 0, y: 0, width: 1440, height: 900 }
      })
    }
  };
  return { electron, views, makeWindow, handlers };
}

const bounds = { x: 0, y: 0, width: 800, height: 600 };
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function cadRuntime(overrides = {}) {
  return {
    CAD_VIEWER_HOST: "127.0.0.1",
    CAD_VIEWER_PORT: 3245,
    viewerBaseUrl: () => "http://127.0.0.1:3245/",
    isPortOpen: async () => true,
    resolveCadStepSelectorHtml: () => "/tmp/atria-fixture-selector.html",
    buildViewerUrl: (file) => `http://127.0.0.1:3245${file}`,
    ...overrides
  };
}

for (const kind of ["cad", "office"]) {
  test(`${kind} native views reattach to a replacement main window and reject stale owners`, async () => {
    const fixture = nativeFixture();
    let win = fixture.makeWindow();
    const root = await mkdtemp(path.join(tmpdir(), "atria-harness-window-"));
    let host;
    try {
      let module;
      if (kind === "cad") {
        module = await loadHost("cad-viewer.cjs", {
          electron: fixture.electron,
          "./cad-viewer-runtime.cjs": cadRuntime(),
          "./cad-step-scanner.cjs": { scanSteps: () => [], pickDefaultStep: () => null }
        });
        host = module.createCadViewer({ getMainWindow: () => win, trust() {} });
      } else {
        await mkdir(path.join(root, "host"), { recursive: true });
        await mkdir(path.join(root, "runtime", "bin"), { recursive: true });
        await writeFile(path.join(root, "host", "managed-service.cjs"), "fixture");
        await writeFile(path.join(root, "runtime", "bin", "node"), "fixture");
        module = await loadHost("office-harness.cjs", {
          electron: fixture.electron,
          "./office-harness-runtime.cjs": {
            resolveOfficeHarnessRoot: () => root,
            resolveOfficeHarnessProfile: () => root,
            probeHost: async () => ({ pid: 0, url: "http://127.0.0.1:43210" }),
            loadManagedHost: () => ({ attachClient: async () => ({ release: async () => {} }) }),
            loadContainEditor: () => null
          }
        });
        host = module.createOfficeHarness({ getMainWindow: () => win, trust() {} });
      }
      const start = (owner) => (kind === "cad" ? host.start(root, owner) : host.start(owner));
      await start("first");
      host.attach({ ...bounds, owner: "first" });
      assert.equal(win.children.size, kind === "cad" ? 2 : 1);
      win.close();
      win = fixture.makeWindow();
      await start("second");
      host.attach({ ...bounds, owner: "second" });
      assert.equal(win.children.size, kind === "cad" ? 2 : 1);
      const retained = [...win.children];
      host.detach("first");
      host.attach({ ...bounds, owner: "first", width: 0 });
      assert.deepEqual([...win.children], retained);
      host.detach("second");
      assert.equal(win.children.size, 0);
    } finally {
      host?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("missing Blender executable rejects the launch without an uncaught child error", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function(id, parent, main) {
      if (id === "electron") return { screen: { getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1440, height: 900 }, bounds: { y: 0, height: 900 }
      }) } };
      if (id === "node:child_process") return { ...load.call(this, id, parent, main), execFileSync() { throw new Error("not running"); } };
      return load.call(this, id, parent, main);
    };
    const host = require(${JSON.stringify(path.join(desktop, "harness-tiling.cjs"))}).createHarnessTiling({
      getMainWindow: () => ({ isDestroyed: () => false, getBounds: () => ({}), setBounds() {}, on() {}, removeListener() {} })
    });
    host.launch("blender-harness").then(() => { process.exitCode = 2; }, (error) => {
      if (!/Blender/.test(error.message) || !/ENOENT/.test(error.message)) process.exitCode = 3;
      console.log("launch rejected", error.message);
    }).finally(() => host.destroy());
  `
    ],
    {
      env: { ...process.env, BLENDER_BIN: path.join(tmpdir(), "atria-nonexistent-blender-executable") },
      encoding: "utf8",
      timeout: 10000
    }
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /launch rejected/);
});

test("CAD launcher uses the same Finder PATH expansion as the desktop backend", async () => {
  const fixturePath = "/atria-test/local-bin:/usr/bin:/bin";
  let launchEnv;
  const runtime = await loadHost("cad-viewer-runtime.cjs", {
    "./backend-environment.cjs": { desktopBackendEnvironment: () => ({ PATH: fixturePath }) },
    "node:child_process": {
      spawn(_command, _args, options) {
        launchEnv = options.env;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit("error", new Error("fixture stops after environment capture")));
        return child;
      }
    }
  });
  await assert.rejects(runtime.startCadViewer(), /fixture stops/);
  assert.equal(launchEnv.PATH, fixturePath);
});

test("CAD startup cannot create a view or retain a child after destroy", async () => {
  const fixture = nativeFixture();
  const ready = deferred();
  const child = new EventEmitter();
  let killed = 0;
  child.kill = () => {
    killed++;
  };
  const { createCadViewer } = await loadHost("cad-viewer.cjs", {
    electron: fixture.electron,
    "./cad-viewer-runtime.cjs": cadRuntime({
      isPortOpen: async () => false,
      startCadViewer: () => ready.promise
    }),
    "./cad-step-scanner.cjs": { scanSteps: () => [], pickDefaultStep: () => null }
  });
  const host = createCadViewer({ getMainWindow: () => fixture.makeWindow(), trust() {} });
  const starting = host.start("/tmp/fixture", "old");
  host.attach({ ...bounds, owner: "old" });
  await new Promise((resolve) => setImmediate(resolve));
  host.destroy();
  ready.resolve({ child });
  await starting;
  assert.equal(host.status().status, "stopped");
  assert.equal(fixture.views.length, 0);
  assert.equal(killed, 1);
});

test("CAD concurrent activations share startup and scan only the newest workspace", async () => {
  const fixture = nativeFixture();
  const port = deferred();
  let probes = 0;
  const scanned = [];
  const win = fixture.makeWindow();
  const { createCadViewer } = await loadHost("cad-viewer.cjs", {
    electron: fixture.electron,
    "./cad-viewer-runtime.cjs": cadRuntime({
      isPortOpen: () => {
        probes++;
        return port.promise;
      }
    }),
    "./cad-step-scanner.cjs": {
      scanSteps: (workspace) => {
        scanned.push(workspace);
        return [];
      },
      pickDefaultStep: () => null
    }
  });
  const host = createCadViewer({ getMainWindow: () => win, trust() {} });
  try {
    const first = host.start("/tmp/atria-first", "first");
    const second = host.start("/tmp/atria-second", "second");
    host.attach({ ...bounds, owner: "second" });
    port.resolve(true);
    await Promise.all([first, second]);
    assert.equal(probes, 1);
    assert.ok(scanned.length > 0);
    assert.deepEqual([...new Set(scanned)], ["/tmp/atria-second"]);
    assert.equal(host.status().status, "running");
    assert.equal(win.children.size, 2);
    host.detach("first");
    assert.equal(win.children.size, 2);
  } finally {
    host.destroy();
  }
});

test("Office retries after a missing plugin is installed and cleans up a host ready after destroy", async () => {
  const fixture = nativeFixture();
  const root = await mkdtemp(path.join(tmpdir(), "atria-office-retry-"));
  const ready = deferred();
  const killed = [];
  let ensureCalls = 0;
  let leaseCalls = 0;
  const { createOfficeHarness } = await loadHost(
    "office-harness.cjs",
    {
      electron: fixture.electron,
      "./office-harness-runtime.cjs": {
        resolveOfficeHarnessRoot: () => root,
        resolveOfficeHarnessProfile: () => root,
        probeHost: async () => null,
        loadManagedHost: () => ({
          ensureHost: () => {
            ensureCalls++;
            return ready.promise;
          },
          attachClient: async () => {
            leaseCalls++;
            return { release: async () => {} };
          }
        }),
        loadContainEditor: () => null
      }
    },
    { kill: (pid, signal) => killed.push({ pid, signal }) }
  );
  const win = fixture.makeWindow();
  const host = createOfficeHarness({ getMainWindow: () => win, trust() {} });
  try {
    assert.equal((await host.start("first")).status, "error");
    await mkdir(path.join(root, "host"), { recursive: true });
    await mkdir(path.join(root, "runtime", "bin"), { recursive: true });
    await writeFile(path.join(root, "host", "managed-service.cjs"), "fixture");
    await writeFile(path.join(root, "runtime", "bin", "node"), "fixture");
    const second = host.start("second");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ensureCalls, 1);
    host.attach({ ...bounds, owner: "second" });
    host.destroy();
    ready.resolve({ pid: 12345678, url: "http://127.0.0.1:43210" });
    await second;
    assert.equal(host.status().status, "stopped");
    assert.equal(fixture.views.length, 0);
    assert.equal(leaseCalls, 0);
    assert.deepEqual(killed, [{ pid: 12345678, signal: "SIGTERM" }]);
  } finally {
    host.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("Office releases a preview lease that arrives after destroy", async () => {
  const fixture = nativeFixture();
  const root = await mkdtemp(path.join(tmpdir(), "atria-office-lease-"));
  const ready = deferred();
  let released = 0;
  const { createOfficeHarness } = await loadHost("office-harness.cjs", {
    electron: fixture.electron,
    "./office-harness-runtime.cjs": {
      resolveOfficeHarnessRoot: () => root,
      resolveOfficeHarnessProfile: () => root,
      probeHost: async () => ({ pid: 0, url: "http://127.0.0.1:43210" }),
      loadManagedHost: () => ({ attachClient: () => ready.promise }),
      loadContainEditor: () => null
    }
  });
  const win = fixture.makeWindow();
  const host = createOfficeHarness({ getMainWindow: () => win, trust() {} });
  try {
    await mkdir(path.join(root, "host"), { recursive: true });
    await mkdir(path.join(root, "runtime", "bin"), { recursive: true });
    await writeFile(path.join(root, "host", "managed-service.cjs"), "fixture");
    await writeFile(path.join(root, "runtime", "bin", "node"), "fixture");
    const starting = host.start("first");
    await new Promise((resolve) => setImmediate(resolve));
    host.destroy();
    ready.resolve({
      release: async () => {
        released++;
      }
    });
    await starting;
    assert.equal(released, 1);
    assert.equal(host.status().status, "stopped");
    assert.equal(fixture.views.length, 0);
  } finally {
    host.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("tiling follows the replacement main window and releases old listeners", async () => {
  const fixture = nativeFixture();
  let win = fixture.makeWindow();
  const { createHarnessTiling } = await loadHost("harness-tiling.cjs", { electron: fixture.electron });
  const host = createHarnessTiling({ getMainWindow: () => win });
  const old = win;
  assert.equal(old.listenerCount("move"), 1);
  win = fixture.makeWindow();
  host.bindWindow();
  assert.equal(old.listenerCount("move"), 0);
  assert.equal(old.listenerCount("resize"), 0);
  assert.equal(win.listenerCount("move"), 1);
  assert.equal(win.listenerCount("resize"), 1);
  host.bindWindow();
  assert.equal(win.listenerCount("move"), 1);
  host.destroy();
  assert.equal(win.listenerCount("move"), 0);
  assert.equal(win.listenerCount("resize"), 0);
});

test(
  "Finder-launched CAD resolves npm from the user's local bin without shell initialization",
  {
    skip: process.platform !== "darwin" ? "Finder PATH behavior requires macOS" : false
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atria-cad-finder-"));
    try {
      const bin = path.join(root, ".local", "bin");
      const plugin = path.join(root, "cad-plugin");
      const recordedPath = path.join(root, "child-path");
      await mkdir(bin, { recursive: true });
      await mkdir(path.join(plugin, "skills", "cad-viewer", "scripts", "viewer"), { recursive: true });
      await writeFile(
        path.join(bin, "npm"),
        '#!/bin/sh\nprintf "%s" "$PATH" > "$ATRIA_FIXTURE_PATH_FILE"\nexit 0\n',
        { mode: 0o755 }
      );
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=commonjs",
          "-e",
          `
      require(${JSON.stringify(path.join(desktop, "cad-viewer-runtime.cjs"))}).startCadViewer({ timeoutMs: 5000 }).then(
        () => { process.exitCode = 2; },
        (error) => { if (!/cad-viewer 退出/.test(error.message)) { console.error(error.message); process.exitCode = 3; } }
      );
    `
        ],
        {
          env: {
            HOME: root,
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            COWORK_DESKTOP_DATA: root,
            CAD_HARNESS_PATH: plugin,
            ATRIA_FIXTURE_PATH_FILE: recordedPath
          },
          encoding: "utf8",
          timeout: 10000
        }
      );
      assert.equal(child.status, 0, child.stderr || child.stdout);
      assert.equal((await readFile(recordedPath, "utf8")).split(path.delimiter)[0], bin);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

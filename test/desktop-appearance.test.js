import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
const { createAppearanceHost } = createRequire(import.meta.url)("../desktop/appearance.cjs");

function nativeAppearance(systemDark = false) {
  let source = "system";
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: systemDark });
  const calls = [];
  const update = () => {
    nativeTheme.shouldUseDarkColors = source === "dark" || (source === "system" && systemDark);
    nativeTheme.emit("updated");
  };
  Object.defineProperty(nativeTheme, "themeSource", {
    get: () => source,
    set(value) {
      source = value;
      calls.push(value);
      update();
    }
  });
  return {
    nativeTheme,
    calls,
    setSystemDark(value) {
      systemDark = value;
      update();
    }
  };
}

test("appearance persists independently of dashboard origin, validates IPC and applies before window creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atria-appearance-"));
  try {
    function fixture(port, systemDark = false) {
      const events = new Map();
      const { nativeTheme, calls } = nativeAppearance(systemDark);
      const webContents = { mainFrame: { url: `http://localhost:${port}/` }, send() {} };
      const window = { webContents, isDestroyed: () => false };
      const host = createAppearanceHost({
        userData: root,
        nativeTheme,
        ipcMain: { on: (name, fn) => events.set(name, fn), handle: (name, fn) => events.set(name, fn) },
        getWindow: () => window,
        getDashboardUrl: () => `http://localhost:${port}`
      });
      return { host, events, calls, event: { sender: webContents, senderFrame: webContents.mainFrame } };
    }
    const first = fixture(1234);
    await first.host.load();
    first.host.register();
    assert.deepEqual(first.calls, ["system"]);
    first.events.get("bookman:appearance")(first.event);
    assert.deepEqual(first.event.returnValue, { preference: "system", effective: "light" });
    const save = first.events.get("bookman:set-appearance");
    for (const value of [null, {}, "auto", "DARK", 1])
      assert.throws(() => save(first.event, value), /Invalid appearance/);
    assert.throws(() => save({ ...first.event, senderFrame: {} }, "dark"), /Untrusted/);
    assert.throws(() => save({ ...first.event, sender: {} }, "dark"), /Untrusted/);
    await save(first.event, "dark");
    assert.equal(JSON.parse(await readFile(path.join(root, "appearance.json"), "utf8")).preference, "dark");
    const next = fixture(5678);
    await next.host.load();
    next.host.register();
    assert.deepEqual(next.calls, ["dark"]);
    next.events.get("bookman:appearance")(next.event);
    assert.deepEqual(next.event.returnValue, { preference: "dark", effective: "dark" });
    const untrusted = { ...next.event, senderFrame: {} };
    next.events.get("bookman:appearance")(untrusted);
    assert.equal(untrusted.returnValue, null);
    await next.events.get("bookman:set-appearance")(next.event, "light");
    assert.equal(next.calls.at(-1), "light");
    await next.events.get("bookman:set-appearance")(next.event, "system");
    assert.equal(JSON.parse(await readFile(path.join(root, "appearance.json"), "utf8")).preference, "system");
    const restarted = fixture(6789, true);
    await restarted.host.load();
    restarted.host.register();
    assert.deepEqual(restarted.calls, ["system"]);
    restarted.events.get("bookman:appearance")(restarted.event);
    assert.deepEqual(restarted.event.returnValue, { preference: "system", effective: "dark" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native system changes publish effective appearance and manual choices stay pinned", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atria-appearance-native-"));
  try {
    const events = new Map(),
      changes = [];
    const { nativeTheme, setSystemDark } = nativeAppearance();
    const webContents = {
      mainFrame: { url: "http://localhost:2222/" },
      send: (channel, value) => changes.push({ channel, value })
    };
    let destroyed = false;
    const host = createAppearanceHost({
      userData: root,
      nativeTheme,
      ipcMain: { on: (name, fn) => events.set(name, fn), handle: (name, fn) => events.set(name, fn) },
      getWindow: () => ({ webContents, isDestroyed: () => destroyed }),
      getDashboardUrl: () => "http://localhost:2222"
    });
    await host.load();
    host.register();
    setSystemDark(true);
    assert.deepEqual(changes.at(-1), {
      channel: "bookman:appearance-changed",
      value: { preference: "system", effective: "dark" }
    });
    setSystemDark(false);
    assert.equal(changes.at(-1).value.effective, "light");
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    const save = events.get("bookman:set-appearance");
    await save(event, "dark");
    setSystemDark(true);
    setSystemDark(false);
    assert.deepEqual(changes.at(-1).value, { preference: "dark", effective: "dark" });
    await save(event, "light");
    setSystemDark(true);
    assert.deepEqual(changes.at(-1).value, { preference: "light", effective: "light" });
    assert.deepEqual(await save(event, "system"), { preference: "system", effective: "dark" });
    destroyed = true;
    const before = changes.length;
    setSystemDark(false);
    assert.equal(changes.length, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid or unreadable appearance preferences follow system without blocking startup", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "atria-appearance-invalid-"));
  try {
    for (const content of ["null", "[]", "42", '"dark"', "{", '{"preference":"invalid"}']) {
      await writeFile(path.join(root, "appearance.json"), content);
      const events = new Map();
      const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
      const webContents = { mainFrame: { url: "http://localhost:3333/" }, send() {} };
      const host = createAppearanceHost({
        userData: root,
        nativeTheme,
        ipcMain: { on: (key, fn) => events.set(key, fn), handle() {} },
        getWindow: () => ({ webContents }),
        getDashboardUrl: () => "http://localhost:3333"
      });
      await host.load();
      host.register();
      assert.equal(nativeTheme.themeSource, "system");
      const event = { sender: webContents, senderFrame: webContents.mainFrame };
      events.get("bookman:appearance")(event);
      assert.equal(event.returnValue.preference, "system");
      assert.equal(event.returnValue.effective, "light");
      assert.match(event.returnValue.warning, /跟随系统/);
      assert.equal(await readFile(path.join(root, "appearance.json"), "utf8"), content);
    }
    await rm(path.join(root, "appearance.json"));
    await mkdir(path.join(root, "appearance.json"));
    const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
    await createAppearanceHost({ userData: root, nativeTheme }).load();
    assert.equal(nativeTheme.themeSource, "system");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed saves keep the previous file and native preference, and later saves recover", async () => {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "atria-appearance-failure-"));
  try {
    await writeFile(path.join(root, "appearance.json"), '{"preference":"dark"}');
    const handlers = new Map();
    const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true });
    const webContents = { mainFrame: { url: "http://localhost:4444/" }, send() {} };
    const host = createAppearanceHost({
      userData: root,
      nativeTheme,
      ipcMain: { on() {}, handle: (key, fn) => handlers.set(key, fn) },
      getWindow: () => ({ webContents, isDestroyed: () => false }),
      getDashboardUrl: () => "http://localhost:4444"
    });
    await host.load();
    host.register();
    await mkdir(path.join(root, "appearance.json.tmp"));
    const event = { sender: webContents, senderFrame: webContents.mainFrame };
    await assert.rejects(handlers.get("bookman:set-appearance")(event, "light"));
    assert.equal(nativeTheme.themeSource, "dark");
    assert.equal(JSON.parse(await readFile(path.join(root, "appearance.json"), "utf8")).preference, "dark");
    await rm(path.join(root, "appearance.json.tmp"), { recursive: true });
    await Promise.all([
      handlers.get("bookman:set-appearance")(event, "light"),
      handlers.get("bookman:set-appearance")(event, "dark")
    ]);
    assert.equal(nativeTheme.themeSource, "dark");
    assert.equal(JSON.parse(await readFile(path.join(root, "appearance.json"), "utf8")).preference, "dark");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

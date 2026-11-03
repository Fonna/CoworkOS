import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
const draftKey = "atria.composer.v1:new";
const draft = (text) => JSON.stringify({ text, attachments: [] });

function nativeDraftBridge({ save, prepareClose = async () => true, pathForFile = () => "" } = {}) {
  const entries = new Map([[draftKey, draft("已保存草稿")]]);
  const windowEvents = new Map();
  const nativeEvents = new Map();
  const documentEvents = new Map();
  const writes = [];
  const acknowledgements = [];
  const exposed = {};
  const localStorage = {
    get length() {
      return entries.size;
    },
    key: (index) => [...entries.keys()][index],
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key)
  };
  const electron = {
    webUtils: { getPathForFile: pathForFile },
    contextBridge: {
      exposeInMainWorld: (name, value) => {
        exposed[name] = value;
      }
    },
    ipcRenderer: {
      sendSync: () => ({ entries: {}, persisted: false }),
      on: (name, handler) => nativeEvents.set(name, handler),
      async invoke(name, ...args) {
        if (name === "bookman:save-composer-drafts") {
          writes.push(JSON.parse(JSON.stringify(args[0])));
          await save?.(args[0]);
        }
        if (name === "bookman:documents-ready") acknowledgements.push(args[1]);
      }
    }
  };
  runInNewContext(preload, {
    require: () => electron,
    process: { platform: "darwin", env: {} },
    location: { protocol: "http:", origin: "http://127.0.0.1:43123" },
    localStorage,
    document: { addEventListener: (name, handler) => documentEvents.set(name, handler) },
    window: { addEventListener: (name, handler) => windowEvents.set(name, handler) },
    setTimeout,
    clearTimeout,
    queueMicrotask
  });
  exposed.bookmanDesktop.onPrepareClose(prepareClose);
  return {
    localStorage,
    writes,
    acknowledgements,
    pathForFile: exposed.bookmanDesktop.pathForFile,
    input: () => documentEvents.get("input")(),
    saveProgrammatic: () => exposed.bookmanDesktop.saveComposerDrafts(),
    unload: () => windowEvents.get("beforeunload")(),
    close: () => nativeEvents.get("bookman:prepare-close")({}, "fixture-close")
  };
}

const drainWrites = () => new Promise((resolve) => setImmediate(resolve));

test("desktop file paths come from Electron's explicitly selected File", () => {
  const file = { name: "original.pptx" };
  const bridge = nativeDraftBridge({
    pathForFile: (value) => {
      assert.equal(value, file);
      return "/Documents/original.pptx";
    }
  });
  assert.equal(bridge.pathForFile(file), "/Documents/original.pptx");
});

test("unloading an acknowledged snapshot skips duplicate IPC while closing still forces persistence", async () => {
  const bridge = nativeDraftBridge();
  await bridge.close();
  assert.equal(bridge.writes.length, 1);
  assert.deepEqual(bridge.acknowledgements, [true]);
  bridge.unload();
  await drainWrites();
  assert.equal(bridge.writes.length, 1);
  await bridge.close();
  assert.equal(bridge.writes.length, 2);
  assert.deepEqual(bridge.acknowledgements, [true, true]);
});

test("close waits for edits typed while the first native draft write is pending", async () => {
  let release;
  let saving = 0;
  const bridge = nativeDraftBridge({
    save: () =>
      ++saving === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined
  });
  const closing = bridge.close();
  await drainWrites();
  assert.equal(bridge.writes.length, 1);
  const humanKey = "atria.human.v1:task-id:request-id";
  bridge.localStorage.setItem(humanKey, JSON.stringify({ text: "落盘期间的新回复" }));
  bridge.input();
  release();
  await closing;
  assert.deepEqual(bridge.acknowledgements, [true]);
  assert.equal(bridge.writes.length, 2);
  assert.equal(JSON.parse(bridge.writes[1][humanKey]).text, "落盘期间的新回复");
});

test("programmatic changes during a native write are flushed even without an input event", async () => {
  let release;
  let saving = 0;
  const bridge = nativeDraftBridge({
    save: () =>
      ++saving === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined
  });
  const closing = bridge.close();
  await drainWrites();
  bridge.localStorage.setItem(draftKey, draft("异步读取完成的最新草稿"));
  bridge.saveProgrammatic();
  release();
  await closing;
  assert.deepEqual(bridge.acknowledgements, [true]);
  assert.equal(bridge.writes.length, 2);
  assert.equal(JSON.parse(bridge.writes[1][draftKey]).text, "异步读取完成的最新草稿");
});

test("a new memory-only edit during close rechecks the renderer and refuses exit", async () => {
  let release;
  let checks = 0;
  const bridge = nativeDraftBridge({
    prepareClose: async () => ++checks === 1,
    save: () =>
      new Promise((resolve) => {
        release = resolve;
      })
  });
  const closing = bridge.close();
  await drainWrites();
  bridge.input();
  release();
  await closing;
  assert.deepEqual(bridge.acknowledgements, [false]);
  assert.equal(checks, 2);
  assert.equal(bridge.writes.length, 1);
});

test("unloading changed drafts persists their newest snapshot once", async () => {
  const bridge = nativeDraftBridge();
  await bridge.close();
  bridge.localStorage.setItem(draftKey, draft("卸载前新修改"));
  bridge.unload();
  await drainWrites();
  assert.equal(bridge.writes.length, 2);
  assert.equal(JSON.parse(bridge.writes[1][draftKey]).text, "卸载前新修改");
  bridge.unload();
  await drainWrites();
  assert.equal(bridge.writes.length, 2);
});

test("native draft mirror includes human replies and excludes unrelated local storage", async () => {
  const bridge = nativeDraftBridge();
  const key = "atria.human.v1:task-id:request-id";
  bridge.localStorage.setItem(key, JSON.stringify({ text: "明天继续", choice: 0 }));
  bridge.localStorage.setItem("apiKey", "unrelated-secret");
  await bridge.close();
  assert.equal(JSON.parse(bridge.writes[0][key]).text, "明天继续");
  assert.equal(bridge.writes[0].apiKey, undefined);
  bridge.localStorage.removeItem(key);
  await bridge.close();
  assert.equal(bridge.writes[1][key], undefined);
});

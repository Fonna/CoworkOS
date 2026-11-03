import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
const { createLanguageHost } = createRequire(import.meta.url)("../desktop/language.cjs");

function fixture(userData, port) {
  const handlers = new Map();
  const webContents = { mainFrame: { url: `http://localhost:${port}/` } };
  const window = { webContents, isDestroyed: () => false };
  const host = createLanguageHost({
    userData,
    ipcMain: { on: (name, fn) => handlers.set(name, fn), handle: (name, fn) => handlers.set(name, fn) },
    getWindow: () => window,
    getDashboardUrl: () => `http://localhost:${port}`
  });
  return { host, handlers, event: { sender: webContents, senderFrame: webContents.mainFrame } };
}

test("desktop language survives new backend origins and rejects invalid or untrusted IPC", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-language-"));
  try {
    const first = fixture(root, 1234);
    await first.host.load();
    first.host.register();
    const read = first.handlers.get("bookman:language");
    read(first.event);
    assert.equal(first.event.returnValue, "zh-CN");
    const save = first.handlers.get("bookman:set-language");
    for (const value of [null, {}, "fr", "EN", "../en", 1])
      assert.throws(() => save(first.event, value), /Invalid language/);
    for (const event of [
      { ...first.event, sender: {} },
      { ...first.event, senderFrame: {} }
    ]) {
      assert.throws(() => save(event, "en"), /Untrusted/);
      read(event);
      assert.equal(event.returnValue, null);
    }
    await save(first.event, "en");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "language.json"), "utf8")), {
      language: "en"
    });
    const next = fixture(root, 5678);
    await next.host.load();
    next.host.register();
    next.handlers.get("bookman:language")(next.event);
    assert.equal(next.event.returnValue, "en");
    await next.handlers.get("bookman:set-language")(next.event, "zh-CN");
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "language.json"), "utf8")), {
      language: "zh-CN"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid preference falls back safely and failed saves can be retried", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cowork-language-failure-"));
  try {
    await writeFile(path.join(root, "language.json"), "invalid");
    const entry = fixture(root, 1234);
    await entry.host.load();
    entry.host.register();
    entry.handlers.get("bookman:language")(entry.event);
    assert.equal(entry.event.returnValue, "zh-CN");
    await writeFile(path.join(root, "language.json.tmp"), "locked");
    const { mkdir } = await import("node:fs/promises");
    await rm(path.join(root, "language.json.tmp"));
    await mkdir(path.join(root, "language.json.tmp"));
    await assert.rejects(
      entry.handlers.get("bookman:set-language")(entry.event, "en"),
      /Could not save language/
    );
    entry.handlers.get("bookman:language")(entry.event);
    assert.equal(entry.event.returnValue, "zh-CN");
    await rm(path.join(root, "language.json.tmp"), { recursive: true });
    await entry.handlers.get("bookman:set-language")(entry.event, "en");
    entry.handlers.get("bookman:language")(entry.event);
    assert.equal(entry.event.returnValue, "en");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

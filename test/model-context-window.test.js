import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCoworkConfig } from "../dist/src/runtime/config.js";
import { modelConnections, saveConnection } from "../dist/src/runtime/model-connections.js";
import { configuredContextWindow, runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";

test("context capacity resolves config and environment independently of output limits", (t) => {
  const previous = process.env.COWORK_CONTEXT_WINDOW;
  t.after(() => {
    if (previous === undefined) delete process.env.COWORK_CONTEXT_WINDOW;
    else process.env.COWORK_CONTEXT_WINDOW = previous;
  });
  delete process.env.COWORK_CONTEXT_WINDOW;
  assert.equal(configuredContextWindow({}), 256000);
  assert.equal(
    configuredContextWindow(runtimeSettingsEnv({ contextWindow: 128000, mainMaxTokens: 8192 })),
    128000
  );
  process.env.COWORK_CONTEXT_WINDOW = "32000";
  assert.equal(configuredContextWindow(runtimeSettingsEnv({ contextWindow: 128000 })), 32000);
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "", "invalid"])
    assert.throws(() => configuredContextWindow({ COWORK_CONTEXT_WINDOW: value }), /上下文窗口/);
});

test("legacy profile lists get the previous capacity without rewriting files; invalid files are rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-context-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = saveConnection(
    {},
    {
      baseUrl: "https://example.com/v1",
      model: "fixture",
      apiKey: "local-fixture"
    }
  );
  delete config.contextWindow;
  delete config.modelConnections.profiles[0].contextWindow;
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify(config));
  const loaded = readCoworkConfig(root, { COWORK_CONFIG: path });
  assert.equal(modelConnections(loaded).profiles[0].contextWindow, 256000);
  assert.equal(loaded.modelConnections.profiles[0].contextWindow, undefined);
  for (const contextWindow of [0, -1, 1.5, "64000", null, 2 ** 53]) {
    await writeFile(path, JSON.stringify({ ...config, contextWindow }));
    assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /上下文窗口/);
    const invalid = structuredClone(config);
    invalid.modelConnections.profiles[0].contextWindow = contextWindow;
    await writeFile(path, JSON.stringify(invalid));
    assert.throws(() => readCoworkConfig(root, { COWORK_CONFIG: path }), /上下文窗口/);
  }
});

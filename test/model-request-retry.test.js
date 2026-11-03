import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readModelRequestRetry } from "../dist/src/runtime/model-request-retry.js";
import { MainRequestStore, mainRequestPath } from "../dist/src/storage/main-request-store.js";

const snapshot = (requestId) => ({
  version: 1,
  taskId: "task",
  runId: "run",
  requestId,
  state: "failed",
  model: {
    id: "fixture",
    provider: "cowork-glm",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 64
  },
  endpoint: "http://127.0.0.1:1/v1/chat/completions",
  body: '{"model":"fixture","messages":[]}',
  context: { messages: [] },
  systemPrompt: "fixture",
  tools: []
});

async function storage(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-request-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private.json");
  return { root, path };
}

test("legacy recovery remains readable while a cleared user turn cannot revive it", async (t) => {
  const f = await storage(t);
  const store = new MainRequestStore(mainRequestPath(f.root, "task"), "task");
  const legacyPath = join(f.root, "task", "sessions", "main", "retry-request.json");
  await mkdir(join(legacyPath, ".."), { recursive: true });
  const original = JSON.stringify(snapshot("legacy-request"));
  await writeFile(legacyPath, original);
  assert.equal((await store.legacyPending()).requestId, "legacy-request");
  assert.equal((await readModelRequestRetry(legacyPath)).executionScope, undefined);
  await store.clear();
  const restored = new MainRequestStore(store.filePath, "task");
  assert.equal(await restored.pending(), undefined);
  assert.equal(await restored.legacyPending(), undefined);
  assert.equal(await readFile(legacyPath, "utf8"), original);
});

test("damaged or incompatible recovery records reject replay and preserve source bytes", async (t) => {
  const f = await storage(t);
  for (const raw of [
    "partial JSON",
    JSON.stringify({ version: 2 }),
    JSON.stringify({ ...snapshot("fixture"), body: "not JSON" }),
    JSON.stringify({ ...snapshot("fixture"), endpoint: "https://different.example/v1" })
  ]) {
    await writeFile(f.path, raw);
    await assert.rejects(readModelRequestRetry(f.path), /归档/);
    assert.equal(await readFile(f.path, "utf8"), raw);
  }
});

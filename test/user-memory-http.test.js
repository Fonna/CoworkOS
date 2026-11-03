import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import { createDashboardHandler } from "../dist/src/dashboard/routes.js";

test("memory HTTP management uses local auth and revision checks; disabled memory can be deleted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldToken = process.env.COWORK_API_TOKEN;
  process.env.COWORK_API_TOKEN = "fixture-token";
  t.after(() => {
    if (oldToken === undefined) delete process.env.COWORK_API_TOKEN;
    else process.env.COWORK_API_TOKEN = oldToken;
  });
  const store = new UserMemoryStore(join(root, "user-memory.json"));
  await store.setEnabled(true);
  const entry = await store.remember({
    content: "brief",
    category: "preference",
    scope: "user",
    source: { taskId: "a", runId: "r", quote: "remember brief" }
  });
  let handler;
  const server = createServer((request, response) => handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ userMemory: store, dashboardUrl: base });
  const request = (body) =>
    fetch(`${base}/api/user-memory`, {
      headers: { "x-atria-token": "fixture-token", "content-type": "application/json" },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {})
    });
  assert.equal((await fetch(`${base}/api/user-memory`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/user-memory`, {
        headers: { origin: "https://example.org", "x-atria-token": "fixture-token" }
      })
    ).status,
    403
  );
  const listed = await request();
  assert.equal(listed.headers.get("cache-control"), "no-store");
  assert.equal((await listed.json()).entries.length, 1);
  assert.equal((await store.read()).learningEnabled, false, "enabling use alone never starts learning");
  assert.equal((await request({ action: "set_learning", enabled: true })).status, 200);
  assert.equal((await store.read()).learningEnabled, true);
  await store.enqueueLearning({ taskId: "pending", runId: "r", text: "我平时比较喜欢简洁的回答" });
  const publicState = await (await request()).json();
  assert.equal("pending" in publicState, false);
  assert.equal("processed" in publicState, false);
  assert.equal("learningRequests" in publicState, false);
  assert.deepEqual(publicState.learningOptions, { maxTokens: 2048, maxRequestsPerHour: 6 });
  const options = { model: "background-small", maxTokens: 1024, maxRequestsPerHour: 2 };
  const savedOptions = await request({ action: "set_learning_options", options });
  assert.equal(savedOptions.status, 200);
  assert.deepEqual((await savedOptions.json()).learningOptions, options);
  assert.deepEqual((await new UserMemoryStore(store.path).read()).learningOptions, options);
  assert.equal(
    (await request({ action: "set_learning_options", options: { maxTokens: 65536 } })).status,
    400
  );
  assert.equal(
    (await request({ action: "set_learning_options", options: { maxRequestsPerHour: 1 } })).status,
    400
  );
  assert.equal(
    (await request({ action: "set_learning_options", options: { model: "bad model" } })).status,
    400
  );
  assert.equal(
    (await request({ action: "update", id: entry.id, revision: 1, content: "detailed" })).status,
    200
  );
  assert.equal(
    (await request({ action: "update", id: entry.id, revision: 1, content: "stale" })).status,
    409
  );
  assert.equal((await request({ action: "set_enabled", enabled: "false" })).status, 400);
  assert.equal((await request({ action: "set_enabled", enabled: false })).status, 200);
  assert.equal((await store.read()).learningEnabled, true);
  assert.equal((await store.read()).pending.length, 1);
  assert.equal((await request({ action: "forget", id: entry.id, revision: 2 })).status, 200);
  assert.deepEqual((await (await request()).json()).entries, []);
});

test("settings can prefill and edit memory while disabled without enabling learning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-prefill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "user-memory.json"));
  // Exercise the real route, including validation and settings provenance.
  const { handleUserMemoryRequest } = await import("../dist/src/dashboard/user-memory-routes.js");
  const server = createServer((request, response) => {
    handleUserMemoryRequest(request, response, new URL(request.url, "http://127.0.0.1"), store).catch(
      (error) => {
        response.writeHead(error.status ?? 400);
        response.end();
      }
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      })
  );
  const post = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/api/user-memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  assert.equal((await post({ action: "remember", content: "   " })).status, 400);
  assert.equal((await post({ action: "remember", content: "x".repeat(2001) })).status, 400);
  const result = await (await post({ action: "remember", content: "我从事 Agent 研究" })).json();
  assert.equal(result.enabled, false);
  assert.equal(result.learningEnabled, false);
  const entry = result.entries[0];
  assert.equal(entry.category, "preference");
  assert.equal(entry.scope, "user");
  assert.equal(entry.source.origin, "settings");
  assert.equal((await post({ action: "remember", content: entry.content })).status, 200);
  assert.equal((await store.read()).entries.length, 1);
  assert.equal(
    (await post({ action: "update", id: entry.id, revision: 1, content: "偏好先看示例" })).status,
    200
  );
  assert.equal((await store.read()).entries[0].revision, 2);
  assert.equal((await store.read()).enabled, false);
  const current = await (await post({ action: "set_enabled", enabled: false })).json();
  assert.equal(current.content, "偏好先看示例");
  const saved = await post({ action: "save_text", revision: current.revision, content: "字".repeat(2000) });
  assert.equal(saved.status, 200);
  const document = await saved.json();
  assert.equal(document.content.length, 2000);
  assert.equal(document.entries.length, 1);
  assert.equal(
    (await post({ action: "save_text", revision: current.revision, content: "stale" })).status,
    409
  );
  assert.equal(
    (await post({ action: "save_text", revision: document.revision, content: "x".repeat(2001) })).status,
    400
  );
  assert.equal((await post({ action: "save_text", revision: document.revision, content: "" })).status, 200);
  assert.equal((await store.read()).entries.length, 0);
});

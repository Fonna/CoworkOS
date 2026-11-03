import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import { createUserMemoryTool } from "../dist/src/runtime/user-memory-tools.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-tool-privacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "home", "memory", "user-memory.json"));
  await store.setEnabled(true);
  const source = { taskId: "prior", runId: "prior-run", quote: "明确保存", origin: "explicit" };
  const user = await store.remember({
    content: "USER_PRIVATE_FACT",
    category: "preference",
    scope: "user",
    source
  });
  await store.remember({
    content: "THIS_PROJECT_FACT",
    category: "constraint",
    scope: "project",
    projectDirectory: join(root, "project"),
    source
  });
  await store.remember({
    content: "OTHER_PROJECT_PRIVATE_FACT",
    category: "constraint",
    scope: "project",
    projectDirectory: join(root, "other"),
    source
  });
  const tool = createUserMemoryTool({
    store,
    taskId: "current",
    runId: "current-run",
    projectDirectory: join(root, "project"),
    userText: () => "查看记忆并删除用户偏好"
  });
  return { root, store, tool, user };
}

test("disabled memory tools expose settings but no stored facts and still allow explicit deletion", async (t) => {
  const { store, tool, user } = await fixture(t);
  await store.setLearningEnabled(true);
  await store.setEnabled(false);
  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.enabled, false);
  assert.equal(listed.learningEnabled, true);
  assert.deepEqual(listed.entries, []);
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_FACT|PROJECT_FACT|明确保存/);
  assert.equal((await store.read()).entries.length, 3, "disabling use preserves editable data");
  await tool.execute({ action: "forget", id: user.id, revision: user.revision, quote: "删除用户偏好" });
  assert.equal((await store.read()).entries.length, 2);
});

test("enabled memory tools list only user and current-project entries", async (t) => {
  const { root, store, tool } = await fixture(t);
  assert.deepEqual(
    (await tool.execute({ action: "list" })).entries.map((entry) => entry.content),
    ["USER_PRIVATE_FACT", "THIS_PROJECT_FACT"]
  );
  const unscoped = createUserMemoryTool({
    store,
    taskId: "unscoped",
    runId: "run",
    userText: () => "查看记忆"
  });
  assert.deepEqual(
    (await unscoped.execute({ action: "list" })).entries.map((entry) => entry.content),
    ["USER_PRIVATE_FACT"]
  );
  const relativeTool = createUserMemoryTool({
    store,
    taskId: "relative",
    runId: "run",
    projectDirectory: relative(process.cwd(), join(root, "project")),
    userText: () => "查看记忆"
  });
  assert.equal((await relativeTool.execute({ action: "list" })).entries.length, 2);
});

test("real Pi cannot recover disabled facts through the memory list tool", { timeout: 15000 }, async (t) => {
  const { root, store } = await fixture(t);
  const previous = process.env.ATRIA_HOME;
  process.env.ATRIA_HOME = join(root, "home");
  t.after(() => {
    if (previous === undefined) delete process.env.ATRIA_HOME;
    else process.env.ATRIA_HOME = previous;
  });
  await store.setEnabled(false);
  const requests = [];
  const provider = await modelProtocolFixture("openai-completions", (body) => {
    requests.push(body);
    return requests.length === 1
      ? { name: "manage_user_memory", arguments: { action: "list" } }
      : { text: "完成" };
  });
  t.after(() => provider.close());
  await new RunService(join(root, "workspace")).runPi({
    taskId: "current",
    runId: "current-run",
    projectDirectory: join(root, "project"),
    prompt: "查看记忆",
    baseUrl: provider.baseUrl,
    apiKey: "fixture",
    model: "protocol-fixture",
    api: "openai-completions",
    thinkingLevel: "off",
    supportsReasoningEffort: false,
    tools: () => new Map(),
    timeoutMs: 10000
  });
  assert.equal(requests.length, 2, "the real Pi tool loop completed");
  assert.doesNotMatch(
    JSON.stringify(requests),
    /USER_PRIVATE_FACT|THIS_PROJECT_FACT|OTHER_PROJECT_PRIVATE_FACT/
  );
  assert.match(JSON.stringify(requests[1]), /learningEnabled/);
});

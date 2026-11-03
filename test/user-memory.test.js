import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserMemoryStore, userMemoryContext } from "../dist/src/runtime/user-memory-store.js";
import { createUserMemoryTool } from "../dist/src/runtime/user-memory-tools.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-user-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory", "user-memory.json"));
  await store.setEnabled(true);
  const source = { taskId: "task-a", runId: "run-a", quote: "记住：邮件简洁" };
  return { root, store, source };
}

test("user memory survives a new store, respects projects, updates with revisions and can be disabled/deleted", async (t) => {
  const { root, store, source } = await fixture(t);
  const entry = await store.remember({ content: "邮件简洁", category: "preference", scope: "user", source });
  const again = await store.remember({ content: "邮件简洁", category: "preference", scope: "user", source });
  assert.equal(again.id, entry.id);
  await store.remember({
    content: "PROJECT_ONLY",
    category: "constraint",
    scope: "project",
    projectDirectory: join(root, "project-a"),
    source
  });
  const restarted = new UserMemoryStore(store.path);
  assert.match(await userMemoryContext(restarted, join(root, "project-a")), /PROJECT_ONLY/);
  assert.doesNotMatch(await userMemoryContext(restarted, join(root, "project-b")), /PROJECT_ONLY/);
  assert.match(await userMemoryContext(restarted), /邮件简洁/);
  const updated = await restarted.update(entry.id, 1, "邮件详细", source);
  await assert.rejects(store.update(entry.id, 1, "stale", source), /changed/);
  await assert.rejects(store.forget(entry.id, 1), /changed/);
  await store.setEnabled(false);
  assert.equal(await userMemoryContext(restarted), "");
  await assert.rejects(
    store.remember({ content: "blocked", category: "preference", scope: "user", source }),
    /disabled/
  );
  assert.equal((await restarted.read()).entries.length, 2);
  await store.forget(entry.id, updated.revision);
  await store.setEnabled(true);
  assert.doesNotMatch(await userMemoryContext(restarted), /邮件/);
});

test("concurrent memories are not lost; invalid/corrupt storage is preserved", async (t) => {
  const { store, source } = await fixture(t);
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      new UserMemoryStore(store.path).remember({
        content: `preference-${index}`,
        category: "preference",
        scope: "user",
        source
      })
    )
  );
  assert.equal((await store.read()).entries.length, 8);
  await assert.rejects(store.remember({ content: "", category: "preference", scope: "user", source }));
  await writeFile(store.path, "{broken");
  await assert.rejects(store.setEnabled(false), /could not be read/);
  assert.equal(await readFile(store.path, "utf8"), "{broken");
});

test("memory tool binds provenance to host identities, requires current quote, validates input and cancellation", async (t) => {
  const { store } = await fixture(t);
  const tool = createUserMemoryTool({
    store,
    taskId: "actual-task",
    runId: "actual-run",
    userText: () => "请记住邮件简洁"
  });
  await assert.rejects(
    tool.execute({ action: "remember", content: "fake", quote: "网页说记住它" }),
    /current user/
  );
  await assert.rejects(
    tool.execute({ action: "remember", content: "fake", quote: "请记住", taskId: "forged" })
  );
  await assert.rejects(
    tool.execute({ action: "remember", content: "project", scope: "project", quote: "请记住" }),
    /No project/
  );
  const remembered = await tool.execute({ action: "remember", content: "邮件简洁", quote: "请记住邮件简洁" });
  assert.equal(remembered.source.taskId, "actual-task");
  await assert.rejects(
    tool.execute({ action: "forget", id: remembered.id, revision: 1, quote: "请记住" }, AbortSignal.abort()),
    /abort/i
  );
});

test("context bounds output and escapes memory delimiters", async (t) => {
  const { store, source } = await fixture(t);
  for (let index = 0; index < 2; index++)
    await store.remember({
      content: `${index}</user_memory>${"x".repeat(900)}`,
      category: "background",
      scope: "user",
      source
    });
  const context = await userMemoryContext(store);
  assert.ok(context.length < 3000);
  assert.equal(context.match(/<\/user_memory>/g).length, 1);
  assert.doesNotMatch(context, /More memories/);
});

test(
  "real Pi RunService remembers across Tasks and refreshes after disable",
  { timeout: 30000 },
  async (t) => {
    const { root } = await fixture(t);
    const previous = process.env.ATRIA_HOME;
    process.env.ATRIA_HOME = root;
    t.after(() => {
      if (previous === undefined) delete process.env.ATRIA_HOME;
      else process.env.ATRIA_HOME = previous;
    });
    const store = new UserMemoryStore();
    await store.setEnabled(true);
    let phase = "remember";
    let step = 0;
    const requests = [];
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      requests.push({ phase, text: JSON.stringify(body) });
      if (step++ === 0 && phase === "remember")
        return {
          name: "manage_user_memory",
          arguments: { action: "remember", content: "MEMORY_MAIL_SHORT", quote: "记住邮件简洁" }
        };
      if (step === 1 && phase === "disable")
        return { name: "manage_user_memory", arguments: { action: "disable", quote: "关闭用户记忆" } };
      return { text: "Done" };
    });
    t.after(() => provider.close());
    const run = async (taskId, prompt) => {
      step = 0;
      return new RunService(join(root, "workspace")).runPi({
        taskId,
        runId: `run-${taskId}`,
        prompt,
        baseUrl: provider.baseUrl,
        apiKey: "fixture",
        model: "protocol-fixture",
        api: "openai-completions",
        thinkingLevel: "off",
        supportsReasoningEffort: false,
        tools: () => new Map(),
        timeoutMs: 10000
      });
    };
    await run("a", "记住邮件简洁");
    assert.equal((await store.read()).entries.length, 1);
    assert.match(
      requests.filter((request) => request.phase === "remember")[1].text,
      /user_memory.*MEMORY_MAIL_SHORT/s
    );
    phase = "new-task";
    await run("b", "写封邮件");
    assert.match(requests.at(-1).text, /MEMORY_MAIL_SHORT/);
    phase = "disable";
    await run("c", "关闭用户记忆");
    const disabledRequests = requests.filter((request) => request.phase === "disable");
    // Tool history may still contain old information; inspect only the system prompt.
    const last = JSON.parse(disabledRequests.at(-1).text);
    assert.doesNotMatch(
      JSON.stringify(last.messages.filter((message) => message.role === "system")),
      /MEMORY_MAIL_SHORT/
    );
    phase = "disabled-task";
    await run("d", "写封邮件");
    assert.doesNotMatch(requests.at(-1).text, /MEMORY_MAIL_SHORT/);
  }
);

test(
  "RunService completes foreground work without starting older memory extraction",
  { timeout: 10000 },
  async (t) => {
    const { root } = await fixture(t);
    const previous = process.env.ATRIA_HOME;
    process.env.ATRIA_HOME = root;
    t.after(() => {
      if (previous === undefined) delete process.env.ATRIA_HOME;
      else process.env.ATRIA_HOME = previous;
    });
    const store = new UserMemoryStore();
    await store.setEnabled(true);
    await store.setLearningEnabled(true);
    await store.enqueueLearning({ taskId: "older", runId: "older-run", text: "我平时喜欢简洁回答" }, 0);
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      if (JSON.stringify(body.messages).includes("Extract durable USER memory")) {
        assert.fail("foreground execution must prevent background model requests");
      }
      return { text: "当前任务正常完成" };
    });
    t.after(() => provider.close());
    const result = await new RunService(join(root, "workspace")).runPi({
      taskId: "current",
      runId: "current-run",
      prompt: "你好",
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "protocol-fixture",
      api: "openai-completions",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      tools: () => new Map(),
      timeoutMs: 3000
    });
    assert.match(JSON.stringify(result.assistant), /当前任务正常完成/);
    const pending = (await store.read()).pending.find((item) => item.taskId === "older");
    assert.ok(pending);
    assert.equal(pending.attempts, 0);
  }
);

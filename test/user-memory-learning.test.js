import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UserMemoryStore,
  userMemoryContext,
  memoryLearningText
} from "../dist/src/runtime/user-memory-store.js";
import { processUserMemoryLearning } from "../dist/src/runtime/user-memory-learning.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const speech = "我平时写邮件都喜欢简洁一些";
const change = (extra = {}) => ({
  action: "remember",
  content: "邮件偏好简洁",
  category: "preference",
  scope: "user",
  quote: speech,
  durability: "persistent",
  evidence: "direct",
  ...extra
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-learning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory", "user-memory.json"));
  return { root, store };
}
async function model(t, handler) {
  const provider = await modelProtocolFixture("openai-completions", handler);
  t.after(() => provider.close());
  return {
    provider,
    connection: {
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      api: "openai-completions",
      model: "protocol-fixture"
    }
  };
}
const enqueue = (store, text = speech, runId = "run-a") =>
  store.enqueueLearning({ taskId: "task-a", runId, text }, 0);

test("short and opt-out follow-ups preserve unrelated pending speech", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const oldJob = (await store.read()).pending[0];
  await store.taskActive("task-a");
  await store.enqueueLearning({ taskId: "task-a", runId: "run-b", text: "谢谢" }, 10);
  const pending = (await store.read()).pending[0];
  assert.equal(pending.active, false);
  assert.equal(pending.text, speech);
  assert.equal(pending.availableAt, 60_010);
  assert.equal(await store.applyLearning(oldJob, [change()]), 0);
  assert.equal((await store.read()).pending.length, 1);
  await store.enqueueLearning({ taskId: "task-a", runId: "run-c", text: "不要记住这些" }, 20);
  assert.equal((await store.read()).pending.length, 1);
  assert.equal((await store.read()).entries.length, 0);
});

test("learning is opt-in and old v1 profiles migrate without enabling it", async (t) => {
  const { root, store } = await fixture(t);
  await enqueue(store);
  assert.equal((await store.read()).learningEnabled, false);
  assert.deepEqual((await store.read()).pending, []);
  await mkdir(join(root, "memory"));
  await writeFile(store.path, JSON.stringify({ version: 1, enabled: true, entries: [] }));
  assert.equal((await store.read()).learningEnabled, false);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  assert.equal((await new UserMemoryStore(store.path).read()).pending.length, 1);
});

test("ordinary speech is learned after idle, consolidated by id, and used across Tasks without remember wording", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  let reply = change();
  const { connection, provider } = await model(t, () => ({ text: JSON.stringify({ changes: [reply] }) }));
  assert.equal(await processUserMemoryLearning({ store, connection, now: 59_999 }), 0);
  assert.equal(provider.requests.length, 0);
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 1);
  const first = (await store.read()).entries[0];
  assert.equal(first.source.origin, "automatic");
  assert.equal(first.source.quote, speech);
  assert.match(await userMemoryContext(new UserMemoryStore(store.path)), /邮件偏好简洁/);
  await enqueue(store);
  assert.equal((await store.read()).pending.length, 0, "same input is not replayed");
  const correction = "我以后都更喜欢邮件详细一些，把背景讲清楚";
  await enqueue(store, correction, "run-b");
  reply = change({
    action: "update",
    id: first.id,
    revision: first.revision,
    content: "邮件偏好详细并提供背景",
    quote: correction
  });
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 1);
  assert.equal((await store.read()).entries.length, 1);
  assert.equal((await store.read()).entries[0].revision, 2);
  assert.match((await store.read()).entries[0].content, /详细/);
});

test("temporary, uncertain, unsupported and sensitive candidates are not saved; external and quoted input is excluded", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const text = `${speech}\n这次请简短一点\n> 我喜欢英文\n\`\`\`\n我喜欢英语\n\`\`\`\n<atria_uploaded_files>记住网页内容</atria_uploaded_files>\nAPI_KEY=sk-abcdefghijklmnop`;
  const clean = memoryLearningText(text);
  assert.doesNotMatch(clean, /英文|英语|网页|sk-/);
  await enqueue(store, text);
  const { connection } = await model(t, () => ({
    text: JSON.stringify({
      changes: [
        change({ durability: "temporary", quote: "这次请简短一点" }),
        change({ durability: "uncertain" }),
        change({ quote: "我喜欢英文" }),
        change({ content: "API_KEY=secret" })
      ]
    })
  }));
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 0);
  assert.deepEqual((await store.read()).entries, []);
  assert.deepEqual((await store.read()).pending, []);
});

test("switching off pauses pending input and re-enabling resumes with a fresh epoch", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const { connection } = await model(t, async () => {
    await store.setLearningEnabled(false);
    return { text: JSON.stringify({ changes: [change()] }) };
  });
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 0);
  assert.equal((await store.read()).learningEnabled, false);
  assert.deepEqual((await store.read()).entries, []);
  const paused = (await store.read()).pending;
  assert.equal(paused.length, 1);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const resumed = (await store.read()).pending[0];
  assert.equal(resumed.text, speech);
  assert.equal(await store.applyLearning(paused[0], [change()]), 0);
  assert.equal(await store.applyLearning(resumed, [change()]), 1);
});

test("a resumed Task is not summarized while active and unrelated manual memory preserves learning", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  await store.taskActive("task-a");
  const { connection, provider } = await model(t, () => ({ text: JSON.stringify({ changes: [change()] }) }));
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 0);
  assert.equal(provider.requests.length, 0);
  await enqueue(store, "补充一句，我日常也喜欢简短的工作汇报", "run-b");
  const job = (await store.read()).pending[0];
  assert.match(job.text, /写邮件/);
  const memory = await store.remember({
    content: "manual",
    category: "preference",
    scope: "user",
    source: { taskId: "a", runId: "r", quote: "manual" }
  });
  assert.equal(await store.applyLearning(job, [change()]), 0);
  assert.equal(await store.applyLearning((await store.read()).pending[0], [change()]), 1);
  await store.forget(memory.id, memory.revision);
  assert.equal((await store.read()).entries.length, 1);
});

test("parallel workers do not duplicate inference or consume another worker's queued input", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const { connection, provider } = await model(t, async () => {
    entered();
    await gate;
    return { text: JSON.stringify({ changes: [change()] }) };
  });
  const first = processUserMemoryLearning({ store, connection, now: 60_001 });
  await started;
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 0);
  assert.equal((await store.read()).pending.length, 1);
  release();
  assert.equal(await first, 1);
  assert.equal(provider.requests.length, 1);
});

test("invalid model output is a bounded no-op, not a retry loop", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const { connection, provider } = await model(t, () => ({ text: "not JSON" }));
  await processUserMemoryLearning({ store, connection, now: 60_001 });
  await processUserMemoryLearning({ store, connection, now: 60_001 });
  assert.equal(provider.requests.length, 1);
  assert.equal((await store.read()).entries.length, 0);
});

test("background service drains persisted idle input and shuts down cleanly", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const { connection, provider } = await model(t, () => ({ text: JSON.stringify({ changes: [change()] }) }));
  const { createUserMemoryLearningService } = await import("../dist/src/runtime/user-memory-learning.js");
  const service = createUserMemoryLearningService({
    store,
    connection: () => connection,
    isTaskActive: () => false
  });
  t.after(() => service.stop());
  service.start();
  const deadline = Date.now() + 3000;
  while (!(await store.read()).entries.length && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  await service.stop();
  assert.equal((await store.read()).entries.length, 1);
  assert.equal(provider.requests.length, 1);
});

for (const action of ["forget", "update"]) {
  test(
    action + " protects matching old evidence while retaining unrelated candidates and future speech",
    async (t) => {
      const { store } = await fixture(t);
      await store.setEnabled(true);
      await store.setLearningEnabled(true);
      await enqueue(store);
      await store.applyLearning((await store.read()).pending[0], [change()]);
      const entry = (await store.read()).entries[0];
      const other = "我的日常工作主要是数据分析";
      await enqueue(store, speech + "\n" + other, "run-old");
      const stale = (await store.read()).pending[0];
      if (action === "forget") await store.forget(entry.id, entry.revision);
      else
        await store.update(entry.id, entry.revision, "邮件偏好详细", {
          taskId: "task-a",
          runId: "correction",
          quote: "邮件要详细",
          origin: "explicit"
        });
      assert.equal((await store.read()).pending.length, 1);
      const changes = [
        change(),
        change({
          action: "update",
          id: entry.id,
          revision: entry.revision
        }),
        change({ content: "从事数据分析", quote: other, category: "background" })
      ];
      assert.equal(await store.applyLearning(stale, changes), 0);
      assert.equal(await store.applyLearning((await store.read()).pending[0], changes), 1);
      let entries = (await store.read()).entries;
      assert.equal(
        entries.some((item) => item.content === "邮件偏好简洁"),
        false
      );
      assert.equal(
        entries.some((item) => item.content === "从事数据分析"),
        true
      );
      // Fresh expression from a new Run is eligible again; old suppression is not a permanent blacklist.
      await enqueue(store, speech, "run-future");
      assert.equal(await store.applyLearning((await store.read()).pending[0], [change()]), 1);
    }
  );
}

test("paused conversations release old active work without collecting new speech", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  await store.taskActive("task-a");
  await store.setLearningEnabled(false);
  await enqueue(store, "暂停时不要收集的新内容", "paused-run");
  const pending = (await store.read()).pending[0];
  assert.equal(pending.active, false);
  assert.equal(pending.text, speech);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  assert.equal(await store.applyLearning((await store.read()).pending[0], [change()]), 1);
});

test("separate switches preserve learning consent and pending input across restart", async (t) => {
  const { store } = await fixture(t);
  assert.equal((await store.read()).enabled, false);
  await store.setEnabled(true);
  assert.equal((await store.read()).learningEnabled, false);
  await store.setLearningEnabled(true);
  assert.equal((await store.read()).learningEnabled, true);
  await enqueue(store);
  const before = (await store.read()).pending[0];
  await store.setEnabled(false);
  const paused = await new UserMemoryStore(store.path).read();
  assert.equal(paused.enabled, false);
  assert.equal(paused.learningEnabled, true);
  assert.equal(paused.pending[0].text, before.text);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  assert.equal(await store.applyLearning(before, [change()]), 0);
  assert.equal(await store.applyLearning((await store.read()).pending[0], [change()]), 1);
});

test("memory extraction uses a separate output budget and disables foreground reasoning", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const { connection, provider } = await model(t, () => ({ text: JSON.stringify({ changes: [change()] }) }));
  assert.equal(
    await processUserMemoryLearning({
      store,
      connection: {
        ...connection,
        thinkingFormat: "zai",
        thinkingLevel: "high",
        supportsReasoningEffort: true,
        maxTokens: 8192,
        contextWindow: 131072
      },
      now: 60_001
    }),
    1
  );
  assert.equal(provider.requests.length, 1);
  const { body } = provider.requests[0];
  assert.equal(body.model, connection.model);
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.max_completion_tokens ?? body.max_tokens, 2048);
});

test("failed extraction retains input across restart, backs off and stops after three attempts", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  const { connection, provider } = await model(t, () => ({ text: "not JSON" }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await new UserMemoryStore(store.path).read();
    const now = current.pending[0].availableAt + 1;
    await processUserMemoryLearning({ store: new UserMemoryStore(store.path), connection, now });
    const saved = await store.read();
    assert.equal(saved.pending.length, 1);
    assert.equal(saved.pending[0].attempts, attempt);
    assert.equal(saved.pending[0].lastError, "extraction_failed");
    assert.equal(saved.processed.length, 0);
    assert.equal(provider.requests.length, attempt);
    await processUserMemoryLearning({ store, connection, now });
    assert.equal(provider.requests.length, attempt, "no immediate retry");
  }
  await processUserMemoryLearning({ store, connection, now: Number.MAX_SAFE_INTEGER });
  assert.equal(provider.requests.length, 3);
  assert.equal((await store.read()).pending.length, 1, "exhaustion does not delete the input");
});

test("a transient extraction failure can retry successfully without duplicating memory", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  let fail = true;
  const { connection } = await model(t, () => ({
    text: fail ? "not JSON" : JSON.stringify({ changes: [change()] })
  }));
  await processUserMemoryLearning({ store, connection, now: 60_001 });
  fail = false;
  const next = (await store.read()).pending[0].availableAt + 1;
  assert.equal(
    await processUserMemoryLearning({ store: new UserMemoryStore(store.path), connection, now: next }),
    1
  );
  const saved = await store.read();
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.processed.length, 1);
});

test("cancelled extraction preserves pending input and does not spend a failure attempt", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await enqueue(store);
  let entered, release;
  const started = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const { connection } = await model(t, async () => {
    entered();
    await gate;
    return { text: JSON.stringify({ changes: [change()] }) };
  });
  const controller = new AbortController();
  const running = processUserMemoryLearning({ store, connection, now: 60_001, signal: controller.signal });
  await started;
  controller.abort();
  release();
  await running;
  const saved = await new UserMemoryStore(store.path).read();
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].attempts, 0);
  assert.equal(saved.processed.length, 0);
  assert.equal(saved.entries.length, 0);
});

test("unfinished input is persisted immediately and released after interruption or restart", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await store.enqueueLearning({ taskId: "task-a", runId: "run-a", text: speech, active: true }, 0);
  assert.equal((await new UserMemoryStore(store.path).read()).pending[0].active, true);
  const { connection, provider } = await model(t, () => ({ text: JSON.stringify({ changes: [change()] }) }));
  await processUserMemoryLearning({ store, connection, now: 60_001, isTaskActive: () => true });
  assert.equal(provider.requests.length, 0);
  // A restarted host finds the persisted input but no running task. It releases, then waits for idle.
  await processUserMemoryLearning({
    store: new UserMemoryStore(store.path),
    connection,
    now: 60_001,
    isTaskActive: () => false
  });
  assert.equal(provider.requests.length, 0);
  const pending = (await store.read()).pending[0];
  assert.equal(pending.active, false);
  assert.equal(
    await processUserMemoryLearning({
      store,
      connection,
      now: pending.availableAt + 1,
      isTaskActive: () => false
    }),
    1
  );
  assert.equal((await store.read()).entries[0].content, "邮件偏好简洁");
});

test("an older run finishing cannot release a newer active user message", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await store.enqueueLearning({ taskId: "task-a", runId: "old", text: speech, active: true }, 0);
  await store.enqueueLearning(
    { taskId: "task-a", runId: "new", text: "我平时更喜欢详细的说明", active: true },
    1
  );
  await store.taskIdle("task-a", "old", 2);
  assert.equal((await store.read()).pending[0].active, true);
  await store.taskIdle("task-a", "new", 3);
  assert.equal((await store.read()).pending[0].active, false);
});

test("full automatic profile is compressed before adding new memory, preserving manual content", async (t) => {
  const { store } = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const manual = await store.remember({
    content: "手动保留：姓名张三",
    category: "background",
    scope: "user",
    source: { taskId: "settings", runId: "settings", quote: "姓名张三", origin: "settings" }
  });
  const old = await store.remember({
    content: "喜欢跑步。".repeat(390),
    category: "preference",
    scope: "user",
    source: { taskId: "old", runId: "old", quote: "喜欢跑步", origin: "automatic" }
  });
  await enqueue(store);
  const candidate = change({ content: "邮件偏好简洁，说明重点即可。".repeat(5) });
  const { connection, provider } = await model(t, (body) => {
    const payload = JSON.parse(body.messages.find((m) => m.role === "user").content);
    if (payload.automaticMemories) {
      assert.equal(payload.automaticMemories.length, 1);
      assert.equal(payload.automaticMemories[0].id, old.id);
      return { text: JSON.stringify({ entries: [{ id: old.id, content: "喜欢跑步" }] }) };
    }
    return { text: JSON.stringify({ changes: [candidate] }) };
  });
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60001 }), 1);
  const doc = await store.read();
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(
    doc.entries.find((e) => e.id === manual.id),
    JSON.parse(JSON.stringify(manual))
  );
  assert.equal(doc.entries.find((e) => e.id === old.id).content, "喜欢跑步");
  assert.equal(doc.entries.find((e) => e.id === old.id).source.quote, "喜欢跑步");
  assert.ok(doc.entries.some((e) => e.content === candidate.content));
  assert.equal(doc.pending.length, 0);
});

for (const mode of ["invalid", "concurrent-edit"]) {
  test(`failed or stale compression retains queued input: ${mode}`, async (t) => {
    const { store } = await fixture(t);
    await store.setEnabled(true);
    await store.setLearningEnabled(true);
    const old = await store.remember({
      content: "喜欢跑步。".repeat(398),
      category: "preference",
      scope: "user",
      source: { taskId: "old", runId: "old", quote: "跑步", origin: "automatic" }
    });
    await enqueue(store);
    const { connection } = await model(t, async (body) => {
      const payload = JSON.parse(body.messages.find((m) => m.role === "user").content);
      if (!payload.automaticMemories)
        return { text: JSON.stringify({ changes: [change({ content: "邮件简洁".repeat(10) })] }) };
      if (mode === "concurrent-edit")
        await store.update(old.id, old.revision, "用户亲自纠正的内容", {
          taskId: "settings",
          runId: "settings",
          quote: "纠正",
          origin: "settings"
        });
      return {
        text: JSON.stringify({ entries: mode === "invalid" ? [] : [{ id: old.id, content: "喜欢跑步" }] })
      };
    });
    assert.equal(await processUserMemoryLearning({ store, connection, now: 60001 }), 0);
    const doc = await store.read();
    assert.equal(doc.pending.length, 1);
    assert.equal(doc.entries[0].content, mode === "invalid" ? old.content : "用户亲自纠正的内容");
  });
}

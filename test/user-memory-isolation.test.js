import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { UserMemoryStore, userMemoryContext } from "../dist/src/runtime/user-memory-store.js";
import {
  createUserMemoryLearningService,
  processUserMemoryLearning
} from "../dist/src/runtime/user-memory-learning.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

const speech = "我平时写工作邮件更喜欢简洁一些";
const changes = [
  {
    action: "remember",
    content: "工作邮件偏好简洁",
    category: "preference",
    scope: "user",
    quote: speech,
    durability: "persistent",
    evidence: "direct"
  }
];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Expected isolation state was not reached");
}
async function fixture(t, handler = () => ({ text: JSON.stringify({ changes }) })) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-isolation-"));
  const store = new UserMemoryStore(join(root, "home", "memory", "user-memory.json"));
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const provider = await modelProtocolFixture("openai-completions", handler);
  t.after(async () => {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    provider,
    connection: {
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "fixture-model",
      api: "openai-completions"
    }
  };
}
async function foregroundMain(t, f, prompt) {
  const moduleUrl = new URL("../dist/src/runtime/run-service.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { RunService } from ${JSON.stringify(moduleUrl)};
    await new RunService(process.argv[1]).runPi({ taskId: "other-task", runId: "other-run", prompt: process.argv[2],
      baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", tools: () => new Map(),
      prepare: async () => { process.send("active"); setInterval(() => {}, 1000); await new Promise(() => {}); } });`,
      join(f.root, "workspace"),
      prompt
    ],
    { env: { ...process.env, ATRIA_HOME: join(f.root, "home") }, stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  await Promise.race([
    once(child, "message"),
    exited.then(() => assert.fail(stderr || "foreground host exited before becoming active"))
  ]);
  return { child, exited };
}

for (const [label, prompt] of [
  ["short speech", "好"],
  ["filtered speech", "```text\nquoted external text\n```"]
]) {
  test(
    `a real foreground Main on another process blocks learning with ${label} and recovers after death`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      await f.store.enqueueLearning({ taskId: "idle-task", runId: "idle-run", text: speech }, 0);
      const { child, exited } = await foregroundMain(t, f, prompt);
      assert.equal(
        (await f.store.read()).pending.length,
        1,
        "the busy Task contributes no eligible learning record"
      );
      assert.equal(
        await processUserMemoryLearning({ store: f.store, connection: f.connection, now: 60_001 }),
        0
      );
      assert.equal(f.provider.requests.length, 0);
      assert.equal((await f.store.read()).learningRequests.length, 0);
      child.kill("SIGKILL");
      await exited;
      assert.equal(
        await processUserMemoryLearning({ store: f.store, connection: f.connection, now: 60_001 }),
        1
      );
      assert.equal(f.provider.requests.length, 1);
    }
  );
}

test(
  "another Main with no learnable speech interrupts an already sent extraction",
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture(t, async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes }) };
    });
    t.after(() => release.resolve());
    await f.store.enqueueLearning({ taskId: "idle-task", runId: "idle-run", text: speech }, 0);
    const running = processUserMemoryLearning({ store: f.store, connection: f.connection, now: 60_001 });
    await entered.promise;
    await foregroundMain(t, f, "好");
    assert.equal(await running, 0);
    const saved = await f.store.read();
    assert.equal(saved.pending[0].attempts, 0);
    assert.equal(saved.entries.length, 0);
    assert.equal(saved.learningRequests.length, 1);
  }
);

test("releasing an older Run cannot release a newer foreground lease", async (t) => {
  const { store } = await fixture(t);
  await store.taskForegroundActive("task", "old-run");
  await store.taskForegroundActive("task", "new-run");
  await store.taskForegroundIdle("task", "old-run");
  assert.equal(await store.isForegroundActive(), true);
  await store.taskForegroundIdle("task", "new-run");
  assert.equal(await store.isForegroundActive(), false);
});

test("connection replacement cancels an old extraction and prevents its compression request", async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, async () => {
    entered.resolve();
    await release.promise;
    return { text: JSON.stringify({ changes }) };
  });
  t.after(() => release.resolve());
  const providerB = await modelProtocolFixture("openai-completions", () => ({
    text: JSON.stringify({ changes: [] })
  }));
  t.after(() => providerB.close());
  const old = await f.store.remember({
    content: "喜欢跑步。".repeat(399),
    category: "preference",
    scope: "user",
    source: { taskId: "old-task", runId: "old-run", quote: "喜欢跑步", origin: "automatic" }
  });
  await f.store.enqueueLearning({ taskId: "idle-task", runId: "idle-run", text: speech }, 0);
  let current = f.connection;
  const service = createUserMemoryLearningService({
    store: f.store,
    connection: () => current,
    isTaskActive: () => false
  });
  t.after(() => service.stop());
  service.start();
  await entered.promise;
  current = { ...current, baseUrl: providerB.baseUrl, model: "replacement-model" };
  await delay(250);
  await service.stop();
  release.resolve();
  const saved = await f.store.read();
  assert.equal(f.provider.requests.length, 1, "old connection never receives a compression call");
  assert.equal(providerB.requests.length, 0, "replacement waits for an independent scheduled pass");
  assert.equal(saved.entries[0].content, old.content);
  assert.equal(saved.pending[0].attempts, 0);
  assert.equal(saved.learningRequests.length, 1);
});

async function largeQueue(store) {
  const document = await store.read();
  const exclusion = {
    id: randomUUID(),
    content: "旧".repeat(2000),
    quote: "旧".repeat(2000),
    runIds: ["old-run"]
  };
  document.pending = Array.from({ length: 30 }, (_, index) => ({
    id: `input-${index}`,
    taskId: `task-${index}`,
    runId: `run-${index}`,
    text: speech,
    sources: [{ runId: `run-${index}`, text: speech }],
    availableAt: 0,
    generation: document.generation,
    active: false,
    attempts: 0,
    exclusions: Array.from({ length: 200 }, () => ({ ...exclusion, id: randomUUID() }))
  }));
  await writeFile(store.path, JSON.stringify(document), { mode: 0o600 });
  await store.readProfile(); // Migrate the fixture's externally written document once.
  assert.ok((await stat(store.path)).size > 50_000_000);
}

test(
  "foreground projection, durable intake and activity never scan or rewrite a legal large learning queue",
  { timeout: 15000 },
  async (t) => {
    const { store } = await fixture(t);
    await store.remember({
      content: "偏好中文",
      category: "preference",
      scope: "user",
      source: { taskId: "settings", runId: "settings", quote: "偏好中文", origin: "settings" }
    });
    await largeQueue(store);
    const before = await stat(store.path);
    class ForegroundStore extends UserMemoryStore {
      async read() {
        assert.fail("foreground attempted to parse the private learning queue");
      }
    }
    const foreground = new ForegroundStore(store.path);
    assert.match(await userMemoryContext(foreground), /偏好中文/);
    await foreground.taskForegroundActive("new-task", "new-run");
    for (let index = 0; index < 5; index++) {
      assert.match(await userMemoryContext(foreground), /偏好中文/);
      await foreground.enqueueForegroundLearning({
        taskId: "new-task",
        runId: `new-run-${index}`,
        text: speech
      });
    }
    await foreground.taskForegroundIdle("new-task", "new-run");
    const after = await stat(store.path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs, "normal task handling did not rewrite learning metadata");
    const names = (await readdir(`${store.path}.inbox`)).filter((name) => name.endsWith(".json"));
    assert.equal(names.length, 1);
    const queued = JSON.parse(await readFile(join(`${store.path}.inbox`, names[0]), "utf8"));
    assert.equal(queued.inputs.length, 5);
    assert.ok((await stat(join(`${store.path}.inbox`, names[0]))).size < 5000);
  }
);

test(
  "an in-flight request polls lightweight state without rereading a legal large queue",
  { timeout: 15000 },
  async (t) => {
    const entered = deferred(),
      release = deferred();
    const f = await fixture(t, async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes: [] }) };
    });
    t.after(() => release.resolve());
    await largeQueue(f.store);
    class CountingStore extends UserMemoryStore {
      reads = 0;
      async read() {
        this.reads++;
        return super.read();
      }
    }
    const counted = new CountingStore(f.store.path);
    const controller = new AbortController();
    const running = processUserMemoryLearning({
      store: counted,
      connection: f.connection,
      signal: controller.signal
    });
    await entered.promise;
    const reads = counted.reads;
    await delay(450);
    assert.equal(counted.reads, reads, "four foreground polls must not reread tens of MB of queued metadata");
    controller.abort();
    assert.equal(await running, 0);
  }
);

test("foreground intake survives restart and the idle background pass performs consolidation", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  await f.store.taskForegroundActive("current-task", "current-run");
  await f.store.enqueueForegroundLearning(
    { taskId: "current-task", runId: "current-run", text: speech },
    now
  );
  assert.equal((await f.store.read()).pending.length, 0);
  await f.store.taskForegroundIdle("current-task", "current-run", now);
  const restarted = new UserMemoryStore(f.store.path);
  assert.equal(
    await processUserMemoryLearning({ store: restarted, connection: f.connection, now: now + 60_001 }),
    1
  );
  assert.equal((await restarted.read()).entries[0].content, changes[0].content);
  assert.equal((await readdir(`${f.store.path}.inbox`)).filter((name) => name.endsWith(".json")).length, 0);
});

test("external profile edits invalidate the projection and corrupt canonical data fails closed", async (t) => {
  const { store } = await fixture(t);
  const profile = await store.readProfile();
  assert.equal(profile.enabled, true);
  const document = await store.read();
  await writeFile(store.path, JSON.stringify({ ...document, enabled: false }));
  assert.equal(await userMemoryContext(new UserMemoryStore(store.path)), "");
  await writeFile(store.path, "{corrupt");
  await assert.rejects(new UserMemoryStore(store.path).readProfile(), /existing data was not overwritten/);
});

test("foreground backlog is bounded across Tasks and repeated Runs without scanning private metadata", async (t) => {
  const { store } = await fixture(t);
  for (let index = 0; index < 35; index++) {
    await store.enqueueForegroundLearning(
      { taskId: `task-${index}`, runId: `run-${index}`, text: speech },
      0
    );
  }
  for (let index = 0; index < 12; index++) {
    await store.enqueueForegroundLearning(
      { taskId: "task-34", runId: `new-${index}`, text: "我通常喜欢简洁。".repeat(1000) },
      0
    );
  }
  const names = (await readdir(`${store.path}.inbox`)).filter((name) => name.endsWith(".json"));
  assert.equal(names.length, 30);
  const records = await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(`${store.path}.inbox`, name), "utf8")))
  );
  assert.ok(
    !records.some((record) => record.taskId === "task-0"),
    "the bounded queue evicts the oldest accepted Tasks"
  );
  const newest = records.find((record) => record.taskId === "task-34");
  assert.equal(newest.inputs.length, 8);
  assert.ok(newest.inputs.every((input) => input.text.length <= 6000));
  assert.equal((await store.read()).pending.length, 0);
});

for (const edit of ["pause", "settings", "manual"]) {
  test(`durable foreground evidence handles ${edit} changes across restart`, async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    await f.store.enqueueForegroundLearning({ taskId: "task", runId: "run", text: speech }, now);
    if (edit === "pause") {
      await f.store.setLearningEnabled(false);
      assert.equal(
        await processUserMemoryLearning({ store: f.store, connection: f.connection, now: now + 60_001 }),
        0
      );
      await f.store.setLearningEnabled(true);
    } else if (edit === "settings") {
      await f.store.setLearningOptions({ maxTokens: 768 });
    } else {
      await f.store.remember({
        content: "手动偏好",
        category: "preference",
        scope: "user",
        source: { taskId: "settings", runId: "settings", quote: "手动偏好", origin: "settings" }
      });
    }
    const restarted = new UserMemoryStore(f.store.path);
    assert.equal(
      await processUserMemoryLearning({ store: restarted, connection: f.connection, now: now + 60_001 }),
      edit === "manual" ? 0 : 1
    );
    assert.equal(f.provider.requests.length, edit === "manual" ? 0 : 1);
    assert.equal((await readdir(`${f.store.path}.inbox`)).filter((name) => name.endsWith(".json")).length, 0);
  });
}

for (const edit of ["manual", "disable", "pause-learning"]) {
  test(`an interleaved ${edit} change during drain cannot revive old evidence or lose paused intake`, async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    await f.store.enqueueForegroundLearning({ taskId: "task", runId: "run-1", text: speech }, now);
    await f.store.enqueueForegroundLearning(
      { taskId: "task", runId: "run-2", text: "我平时偏好先给结论再解释" },
      now
    );
    class InterleavedStore extends UserMemoryStore {
      async readProfile() {
        const profile = await super.readProfile();
        if (!this.edited) {
          this.edited = true;
          if (edit === "manual")
            await f.store.remember({
              content: "手动修正",
              category: "preference",
              scope: "user",
              source: { taskId: "settings", runId: "settings", quote: "手动修正", origin: "settings" }
            });
          else if (edit === "disable") await f.store.setEnabled(false);
          else await f.store.setLearningEnabled(false);
        }
        return profile;
      }
    }
    const racing = new InterleavedStore(f.store.path);
    await racing.drainForegroundLearning(now + 60_001);
    assert.equal((await f.store.read()).pending.length, 0);
    const queued = (await readdir(`${f.store.path}.inbox`)).filter((name) => name.endsWith(".json"));
    assert.equal(queued.length, edit === "manual" ? 0 : 1);
    if (edit !== "manual") {
      if (edit === "disable") await f.store.setEnabled(true);
      else await f.store.setLearningEnabled(true);
      await new UserMemoryStore(f.store.path).drainForegroundLearning(now + 60_001);
      const pending = (await f.store.read()).pending;
      assert.equal(pending.length, 1);
      assert.equal(
        pending[0].sources.length,
        2,
        "the entire accepted batch transfers exactly once after resume"
      );
    }
  });
}

for (const prompt of ["好", "```text\nexternal\n```"]) {
  test("a short or filtered resumed Task postpones old pending evidence for a full idle minute", async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    await f.store.enqueueLearning({ taskId: "task", runId: "old-run", text: speech }, 0);
    await f.store.taskForegroundActive("task", "new-run");
    await f.store.enqueueForegroundLearning({ taskId: "task", runId: "new-run", text: prompt }, now);
    await f.store.taskForegroundIdle("task", "new-run", now);
    assert.equal(
      await processUserMemoryLearning({ store: f.store, connection: f.connection, now: now + 59_999 }),
      0
    );
    assert.equal(f.provider.requests.length, 0);
    assert.equal((await f.store.read()).pending[0].attempts, 0);
    assert.equal(
      await processUserMemoryLearning({ store: f.store, connection: f.connection, now: now + 60_001 }),
      1
    );
  });
}

test("restart after an interrupted intake acknowledgement cannot requeue an already processed batch", async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  await f.store.enqueueForegroundLearning({ taskId: "task", runId: "run-1", text: speech }, now);
  const names = (await readdir(`${f.store.path}.inbox`)).filter((name) => name.endsWith(".json"));
  const path = join(`${f.store.path}.inbox`, names[0]);
  const original = await readFile(path, "utf8");
  assert.equal(
    await processUserMemoryLearning({ store: f.store, connection: f.connection, now: now + 60_001 }),
    1
  );
  await writeFile(path, original, { mode: 0o600 }); // Simulate death after the main transaction but before removing its intake file.
  assert.equal(
    await processUserMemoryLearning({
      store: new UserMemoryStore(f.store.path),
      connection: f.connection,
      now: now + 60_001
    }),
    0
  );
  assert.equal(f.provider.requests.length, 1);
  assert.equal((await f.store.read()).pending.length, 0);
});

test("replayed earlier speech preserves the merged job identity, failures and bounded retries", async (t) => {
  const { store } = await fixture(t);
  const first = { taskId: "task", runId: "run-a", text: speech };
  await store.enqueueLearning(first, 0);
  await store.enqueueLearning({ taskId: "task", runId: "run-b", text: "我平时偏好先给结论再解释" }, 0);
  const job = (await store.read()).pending[0];
  await store.failLearning(job, 60_001);
  await store.enqueueLearning(first, 120_001);
  const replayed = (await store.read()).pending[0];
  assert.equal(replayed.id, job.id);
  assert.equal(replayed.text, job.text);
  assert.deepEqual(replayed.sources, job.sources);
  assert.equal(replayed.attempts, 1);
  assert.equal(replayed.lastError, "extraction_failed");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { UserMemoryStore } from "../dist/src/runtime/user-memory-store.js";
import {
  processUserMemoryLearning,
  createUserMemoryLearningService
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
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Expected memory scheduling state was not reached");
}
async function fixture(
  t,
  api = "openai-completions",
  handler = () => ({ text: JSON.stringify({ changes }) })
) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-scheduling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory.json"));
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const provider = await modelProtocolFixture(api, handler);
  t.after(() => provider.close());
  const connection = {
    baseUrl: provider.baseUrl,
    apiKey: "fixture",
    model: "main-model",
    api,
    thinkingFormat: "zai",
    thinkingLevel: "high",
    supportsReasoningEffort: true,
    maxTokens: 65536
  };
  const enqueue = (taskId = "idle-task", text = speech) =>
    store.enqueueLearning({ taskId, runId: `${taskId}-run`, text }, 0);
  return { root, store, provider, connection, enqueue };
}

async function activeHost(t, store) {
  const moduleUrl = new URL("../dist/src/runtime/user-memory-store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { UserMemoryStore } from ${JSON.stringify(moduleUrl)};
       const store = new UserMemoryStore(process.argv[1]);
       await store.enqueueLearning({ taskId: "other-host-task", runId: "other-host-run",
         text: "我通常喜欢详细解释背景", active: true }, 0);
       process.send("active");
       setInterval(() => {}, 1000);`,
      store.path
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });
  await once(child, "message");
  return child;
}

test(
  "learning recovers a lease left by a real worker killed while holding it",
  { timeout: 10000 },
  async (t) => {
    const { store, connection, provider, enqueue } = await fixture(t);
    await enqueue();
    const moduleUrl = new URL("../dist/src/storage/file-lock.js", import.meta.url).href;
    const target = `${store.path}.learning`;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { withFileLock } from ${JSON.stringify(moduleUrl)};
       await withFileLock(process.argv[1], async () => {
         process.send("locked");
         setInterval(() => {}, 1000);
         await new Promise(() => {});
       }, { timeoutMs: 1000, recoverDeadOwner: true });`,
        target
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    await once(child, "message");
    const owner = JSON.parse(await readFile(`${target}.lock/owner.json`, "utf8"));
    assert.equal(owner.pid, child.pid);
    child.kill("SIGKILL");
    await once(child, "exit");
    assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 1);
    assert.equal(provider.requests.length, 1);
    assert.equal((await store.read()).pending.length, 0);
  }
);

test("a different foreground Task prevents learning without spending a request or retry", async (t) => {
  const { store, connection, provider, enqueue } = await fixture(t);
  await enqueue();
  assert.equal(
    await processUserMemoryLearning({
      store,
      connection,
      now: 60_001,
      isTaskActive: (taskId) => taskId === "busy-task",
      isForegroundActive: () => true
    }),
    0
  );
  const saved = await store.read();
  assert.equal(provider.requests.length, 0);
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].attempts, 0);
  assert.equal(saved.learningRequests.length, 0);
});

test("live active input owned by another host also blocks an unrelated idle Task", async (t) => {
  const { store, connection, provider, enqueue } = await fixture(t);
  await enqueue();
  await activeHost(t, store);
  assert.equal(
    await processUserMemoryLearning({
      store,
      connection,
      now: 60_001,
      isTaskActive: () => false,
      isForegroundActive: () => false
    }),
    0
  );
  assert.equal(provider.requests.length, 0);
  assert.equal((await store.read()).learningRequests.length, 0);
});

for (const host of ["this host", "another host"]) {
  test(`foreground activity on ${host} interrupts extraction without a failure`, async (t) => {
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const { store, connection, provider, enqueue } = await fixture(t, "openai-completions", async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes }) };
    });
    await enqueue();
    let busy = false;
    const running = processUserMemoryLearning({
      store,
      connection,
      now: 60_001,
      isTaskActive: () => false,
      isForegroundActive: () => busy
    });
    await entered.promise;
    if (host === "this host") busy = true;
    else await activeHost(t, store);
    assert.equal(await running, 0, "cancellation must not wait for the provider to finish");
    const saved = await new UserMemoryStore(store.path).read();
    assert.equal(provider.requests.length, 1);
    const pending = saved.pending.find((item) => item.taskId === "idle-task");
    assert.ok(pending);
    assert.equal(pending.attempts, 0);
    assert.equal(saved.processed.length, 0);
    assert.equal(saved.entries.length, 0);
    assert.equal(
      saved.learningRequests.length,
      1,
      "an already sent request still consumes its durable budget"
    );
  });
}

test("pause aborts the current service pass and start can resume without replacing the service", async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { store, connection, provider, enqueue } = await fixture(
    t,
    "openai-completions",
    async (_body, requests) => {
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { text: JSON.stringify({ changes }) };
    }
  );
  await enqueue();
  const service = createUserMemoryLearningService({
    store,
    connection: () => connection,
    isTaskActive: () => false,
    isForegroundActive: () => false
  });
  t.after(() => service.stop());
  service.start();
  await entered.promise;
  service.pause();
  await waitFor(async () => {
    service.start();
    return (await store.read()).entries.length === 1;
  });
  await service.stop();
  assert.equal(provider.requests.length, 2);
  assert.equal((await store.read()).pending.length, 0);
});

test("pause during an asynchronous foreground check prevents request dispatch", async (t) => {
  const checking = deferred();
  const release = deferred();
  t.after(() => release.resolve(false));
  const { store, connection, provider, enqueue } = await fixture(t);
  await enqueue();
  let checks = 0;
  const service = createUserMemoryLearningService({
    store,
    connection: () => connection,
    isTaskActive: () => false,
    isForegroundActive: () => {
      if (++checks === 4) {
        checking.resolve();
        return release.promise;
      }
      return false;
    }
  });
  t.after(() => service.stop());
  service.start();
  await checking.promise;
  service.pause();
  release.resolve(false);
  await service.stop();
  const saved = await store.read();
  assert.equal(provider.requests.length, 0);
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].attempts, 0);
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`learning uses its own model and small output limit with reasoning off: ${api}`, async (t) => {
    const { store, connection, provider, enqueue } = await fixture(t, api);
    await store.setLearningOptions({ model: "memory-small", maxTokens: 512, maxRequestsPerHour: 6 });
    await enqueue();
    assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 1);
    const body = provider.requests[0].body;
    assert.equal(body.model, "memory-small");
    assert.equal(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens, 512);
    assert.equal(body.reasoning_effort, undefined);
    if (api === "openai-completions") assert.deepEqual(body.thinking, { type: "disabled" });
    else assert.equal(body.reasoning?.effort, undefined);
  });
}

test("default learning output budget stays small even when Main allows 65536 tokens", async (t) => {
  const { store, connection, provider, enqueue } = await fixture(t);
  await enqueue();
  assert.equal(await processUserMemoryLearning({ store, connection, now: 60_001 }), 1);
  const body = provider.requests[0].body;
  assert.equal(body.model, connection.model);
  assert.equal(body.max_completion_tokens ?? body.max_tokens, 2048);
  assert.equal(body.reasoning_effort, undefined);
});

test("extraction and compression share a durable hourly request budget across restarts", async (t) => {
  let old;
  const { store, connection, provider, enqueue } = await fixture(t, "openai-completions", (body) => {
    const payload = JSON.parse(body.messages.find((message) => message.role === "user").content);
    return {
      text: JSON.stringify(
        payload.automaticMemories ? { entries: [{ id: old.id, content: "喜欢跑步" }] } : { changes }
      )
    };
  });
  await store.setLearningOptions({ maxRequestsPerHour: 2 });
  old = await store.remember({
    content: "喜欢跑步。".repeat(399),
    category: "preference",
    scope: "user",
    source: { taskId: "old-task", runId: "old-run", quote: "喜欢跑步", origin: "automatic" }
  });
  await enqueue();
  const now = 60_001;
  assert.equal(await store.claimLearningRequest(now), true, "another host already used one request");
  assert.equal(await processUserMemoryLearning({ store, connection, now }), 0);
  let saved = await store.read();
  assert.equal(provider.requests.length, 1, "compression may not bypass the exhausted budget");
  assert.equal(saved.learningRequests.length, 2);
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].attempts, 0);
  assert.equal(saved.entries[0].content, old.content, "uncommitted compression does not alter memory");
  assert.equal(
    await processUserMemoryLearning({ store: new UserMemoryStore(store.path), connection, now: now + 1 }),
    0
  );
  assert.equal(provider.requests.length, 1, "restarting the worker does not reset its allowance");
  assert.equal(
    await processUserMemoryLearning({
      store: new UserMemoryStore(store.path),
      connection,
      now: now + 3_600_001
    }),
    1
  );
  saved = await store.read();
  assert.equal(provider.requests.length, 3);
  assert.equal(saved.learningRequests.length, 2);
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.entries.find((entry) => entry.id === old.id).content, "喜欢跑步");
});

for (const edit of ["disable", "pause-learning", "learning-options"]) {
  test(`a ${edit} edit cancels old extraction without spending a retry or starting compression`, async (t) => {
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const { store, connection, provider, enqueue } = await fixture(t, "openai-completions", async () => {
      entered.resolve();
      await release.promise;
      return { text: JSON.stringify({ changes }) };
    });
    const old = await store.remember({
      content: "喜欢跑步。".repeat(390),
      category: "preference",
      scope: "user",
      source: { taskId: "old-task", runId: "old-run", quote: "喜欢跑步", origin: "automatic" }
    });
    await enqueue();
    const running = processUserMemoryLearning({ store, connection, now: 60_001 });
    await entered.promise;
    if (edit === "disable") await store.setEnabled(false);
    else if (edit === "pause-learning") await store.setLearningEnabled(false);
    else await store.setLearningOptions({ model: "replacement-memory-model", maxTokens: 768 });
    assert.equal(await running, 0, "epoch changes must not wait for the old provider response");
    const saved = await store.read();
    assert.equal(provider.requests.length, 1);
    assert.equal(saved.pending.length, 1);
    assert.equal(saved.pending[0].attempts, 0);
    assert.equal(saved.entries[0].content, old.content);
    assert.equal(saved.learningRequests.length, 1, "changing options does not erase sent request usage");
  });
}

for (const editAt of ["before-reservation", "after-reservation"]) {
  test(`an epoch change ${editAt} cannot dispatch an old request`, async (t) => {
    const { store, connection, provider, enqueue } = await fixture(t);
    await enqueue();
    class ChangingStore extends UserMemoryStore {
      async claimLearningRequest(now, expectedGeneration) {
        if (editAt === "before-reservation") await this.setLearningOptions({ model: "new-memory-model" });
        const claimed = await super.claimLearningRequest(now, expectedGeneration);
        if (editAt === "after-reservation") await this.setLearningOptions({ model: "new-memory-model" });
        return claimed;
      }
    }
    assert.equal(
      await processUserMemoryLearning({ store: new ChangingStore(store.path), connection, now: 60_001 }),
      0
    );
    const saved = await store.read();
    assert.equal(provider.requests.length, 0);
    assert.equal(saved.pending.length, 1);
    assert.equal(saved.pending[0].attempts, 0);
    assert.equal(saved.learningRequests.length, editAt === "before-reservation" ? 0 : 1);
  });
}

test("aborting during the final Task activity check cannot settle a cancelled result", async (t) => {
  const { store, connection, provider, enqueue } = await fixture(t);
  await enqueue();
  const controller = new AbortController();
  let checks = 0;
  assert.equal(
    await processUserMemoryLearning({
      store,
      connection,
      now: 60_001,
      signal: controller.signal,
      isTaskActive: () => {
        if (++checks === 2) controller.abort();
        return false;
      }
    }),
    0
  );
  const saved = await store.read();
  assert.equal(provider.requests.length, 1);
  assert.equal(saved.pending.length, 1);
  assert.equal(saved.pending[0].attempts, 0);
  assert.equal(saved.processed.length, 0);
  assert.equal(saved.entries.length, 0);
});

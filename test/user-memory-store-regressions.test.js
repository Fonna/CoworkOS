import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { USER_MEMORY_MAX_CONTEXT_CHARS } from "../dist/src/domain/user-memory.js";
import {
  UserMemoryStore,
  userMemoryContext,
  userMemoryRevision
} from "../dist/src/runtime/user-memory-store.js";

const firstSpeech = "我平时喜欢用中文交流";
const secondSpeech = "我的工作主要是数据分析";
const source = { taskId: "settings", runId: "settings", quote: "manual", origin: "settings" };

async function fixture(t, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-store-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMemoryStore(join(root, "memory.json"));
  if (enabled) {
    await store.setEnabled(true);
    await store.setLearningEnabled(true);
  }
  return { root, store };
}

function change(content, quote, extra = {}) {
  return {
    action: "remember",
    content,
    category: "preference",
    scope: "user",
    quote,
    durability: "persistent",
    evidence: "direct",
    ...extra
  };
}

for (const secondRun of ["run-a", "run-b"]) {
  test(`replaying the latest input preserves merged speech and retry state: ${secondRun}`, async (t) => {
    const { store } = await fixture(t);
    await store.enqueueLearning({ taskId: "task", runId: "run-a", text: firstSpeech }, 0);
    const latest = { taskId: "task", runId: secondRun, text: secondSpeech };
    await store.enqueueLearning(latest, 1);
    await store.failLearning((await store.read()).pending[0], 60_001);
    await store.remember({ content: "手动保存的无关偏好", category: "preference", scope: "user", source });
    const previous = (await store.read()).pending[0];
    await store.enqueueLearning({ ...latest, active: true }, 60_002);
    const replayed = (await new UserMemoryStore(store.path).read()).pending[0];
    assert.equal(replayed.text, `${firstSpeech}\n${secondSpeech}`);
    assert.deepEqual(replayed.sources, previous.sources);
    assert.equal(replayed.sources.length, 2);
    assert.equal(replayed.attempts, 1);
    assert.equal(replayed.lastError, "extraction_failed");
    assert.deepEqual(replayed.exclusions, previous.exclusions);
    assert.equal(replayed.active, true);
    assert.equal(replayed.activeOwnerPid, process.pid);
    assert.equal(replayed.availableAt, 120_002);
    await store.taskIdle("task", secondRun, 60_003);
    const job = (await store.read()).pending[0];
    assert.equal(
      await store.applyLearning(job, [change("喜欢中文", firstSpeech), change("从事数据分析", secondSpeech)]),
      2
    );
    const entries = (await store.read()).entries;
    assert.equal(entries.find((entry) => entry.content === "喜欢中文").source.runId, "run-a");
    assert.equal(entries.find((entry) => entry.content === "从事数据分析").source.runId, secondRun);
    await store.enqueueLearning(latest, 70_000);
    assert.equal((await store.read()).pending.length, 0);
  });
}

for (const origin of ["explicit", "settings"]) {
  test(`explicitly saving an automatic duplicate preserves identity and protects old evidence: ${origin}`, async (t) => {
    const { store } = await fixture(t);
    const oldQuote = "我平时喜欢简洁地写邮件";
    const unrelated = "我长期从事数据分析工作";
    const old = await store.remember({
      content: "邮件偏好简洁",
      category: "preference",
      scope: "user",
      source: { taskId: "old", runId: "old", quote: oldQuote, origin: "automatic" }
    });
    await store.enqueueLearning({ taskId: "task", runId: "run", text: `${oldQuote}\n${unrelated}` }, 0);
    const before = await store.read();
    const manualSource = { taskId: "current", runId: "current", quote: "请明确记住邮件偏好简洁", origin };
    const saved = await store.remember({
      content: old.content,
      category: old.category,
      scope: old.scope,
      source: manualSource
    });
    assert.equal(saved.id, old.id);
    assert.equal(saved.createdAt, old.createdAt);
    assert.equal(saved.revision, old.revision + 1);
    assert.deepEqual(saved.source, manualSource);
    assert.notEqual(userMemoryRevision(await store.read()), userMemoryRevision(before));
    assert.equal(
      await store.applyLearning(before.pending[0], [], {
        compaction: { revision: userMemoryRevision(before), entries: [{ id: old.id, content: "邮件简洁" }] }
      }),
      0
    );
    const changes = [
      change("邮件偏好详细", oldQuote, { action: "update", id: old.id, revision: old.revision }),
      change("喜欢写简短邮件", oldQuote),
      change("从事数据分析", unrelated)
    ];
    assert.equal(await store.applyLearning(before.pending[0], changes), 0);
    assert.deepEqual(
      (await store.read()).entries.find((entry) => entry.id === old.id),
      saved
    );
    assert.equal(await store.applyLearning((await store.read()).pending[0], changes), 1);
    const futureSpeech = "我长期更喜欢详细地写邮件";
    await store.enqueueLearning({ taskId: "task", runId: "future", text: futureSpeech }, 1);
    assert.equal(
      await store.applyLearning((await store.read()).pending[0], [
        change("邮件偏好详细", futureSpeech, { action: "update", id: saved.id, revision: saved.revision })
      ]),
      0
    );
    assert.deepEqual(
      (await store.read()).entries.find((entry) => entry.id === old.id),
      saved
    );
    const repeated = await store.remember({
      content: saved.content,
      category: saved.category,
      scope: saved.scope,
      source: manualSource
    });
    assert.equal(repeated.revision, saved.revision);
    const automaticDuplicate = await store.remember({
      content: saved.content,
      category: saved.category,
      scope: saved.scope,
      source: { ...manualSource, origin: "automatic" }
    });
    assert.deepEqual(automaticDuplicate.source, manualSource);
  });
}

test("settings can protect an automatic duplicate while use is disabled", async (t) => {
  const { store } = await fixture(t);
  const automatic = await store.remember({
    content: "邮件简洁",
    category: "preference",
    scope: "user",
    source: { ...source, origin: "automatic" }
  });
  await store.setEnabled(false);
  await assert.rejects(
    store.remember({
      content: automatic.content,
      category: automatic.category,
      scope: automatic.scope,
      source: { ...source, origin: "explicit" }
    }),
    /disabled/
  );
  const saved = await store.remember({
    content: automatic.content,
    category: automatic.category,
    scope: automatic.scope,
    source
  });
  assert.equal(saved.id, automatic.id);
  assert.equal(saved.revision, automatic.revision + 1);
  assert.deepEqual(saved.source, source);
  assert.equal((await store.read()).enabled, false);
});

test("use and learning switches are independent and disabling use pauses queued work", async (t) => {
  const { store } = await fixture(t, false);
  await store.setLearningEnabled(true);
  assert.equal((await store.read()).enabled, false);
  assert.equal((await store.read()).learningEnabled, true);
  await store.enqueueLearning({ taskId: "task", runId: "run", text: firstSpeech }, 0);
  assert.equal((await store.read()).pending.length, 0);
  await store.setEnabled(true);
  await store.enqueueLearning({ taskId: "task", runId: "run", text: firstSpeech }, 0);
  const job = (await store.read()).pending[0];
  await store.setEnabled(false);
  assert.equal((await store.read()).learningEnabled, true);
  assert.equal((await store.read()).pending[0].text, firstSpeech);
  assert.equal(await store.applyLearning(job, [change("喜欢中文", firstSpeech)]), 0);
  await store.setEnabled(true);
  await store.setLearningEnabled(false);
  assert.equal((await store.read()).enabled, true);
  await store.remember({ content: "已有个人偏好", category: "preference", scope: "user", source });
  assert.match(await userMemoryContext(store), /已有个人偏好/);
  await store.enqueueLearning({ taskId: "other", runId: "other", text: secondSpeech }, 1);
  assert.equal((await store.read()).pending.length, 1);
});

test("learning options validate, invalidate in-flight work and retain request usage", async (t) => {
  const { store } = await fixture(t);
  await store.enqueueLearning({ taskId: "task", runId: "run", text: firstSpeech }, 0);
  const before = await store.read();
  assert.equal(await store.claimLearningRequest(1000), true);
  await store.setLearningOptions({ model: "small-model", maxTokens: 512, maxRequestsPerHour: 2 });
  const after = await new UserMemoryStore(store.path).read();
  assert.deepEqual(after.learningOptions, { model: "small-model", maxTokens: 512, maxRequestsPerHour: 2 });
  assert.deepEqual(after.learningRequests, [1000]);
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.pending[0].generation, after.generation);
  assert.equal(await store.applyLearning(before.pending[0], [change("喜欢中文", firstSpeech)]), 0);
  for (const options of [
    { maxTokens: 255 },
    { maxTokens: 4097 },
    { maxRequestsPerHour: 0 },
    { maxRequestsPerHour: 1 },
    { maxRequestsPerHour: 25 },
    { model: "invalid model" },
    { unexpected: true }
  ])
    await assert.rejects(store.setLearningOptions(options));
  assert.deepEqual((await store.read()).learningOptions, after.learningOptions);
});

test("request reservations are atomic, survive restart and expire after one hour", async (t) => {
  const { store } = await fixture(t);
  await store.setLearningOptions({ maxRequestsPerHour: 3 });
  const claimed = await Promise.all(
    Array.from({ length: 5 }, () => new UserMemoryStore(store.path).claimLearningRequest(1000))
  );
  assert.equal(claimed.filter(Boolean).length, 3);
  assert.deepEqual((await store.read()).learningRequests, [1000, 1000, 1000]);
  assert.equal(await new UserMemoryStore(store.path).claimLearningRequest(2000), false);
  await store.setLearningOptions({ maxRequestsPerHour: 2 });
  assert.deepEqual((await store.read()).learningRequests, [1000, 1000, 1000]);
  assert.equal(await store.claimLearningRequest(3000), false);
  assert.equal(await store.claimLearningRequest(3_601_000), true);
  assert.deepEqual((await store.read()).learningRequests, [3_601_000]);
  await store.setEnabled(false);
  assert.equal(await store.claimLearningRequest(7_202_000), false);
  await store.setEnabled(true);
  await store.setLearningEnabled(false);
  assert.equal(await store.claimLearningRequest(7_202_000), false);
});

test("context includes only complete entries within its full serialized budget", async (t) => {
  const { store } = await fixture(t);
  const document = await store.read();
  document.entries = Array.from({ length: 150 }, (_, index) => ({
    id: randomUUID(),
    content: String.fromCharCode(0x4e00 + index),
    category: "preference",
    scope: "user",
    source,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  await writeFile(store.path, JSON.stringify(document));
  const context = await userMemoryContext(store);
  assert.ok(context.length <= USER_MEMORY_MAX_CONTEXT_CHARS);
  assert.match(context, /More memories exist; use manage_user_memory to list them/);
  assert.equal(context.match(/<\/user_memory>/g).length, 1);
  const selected = context
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map(JSON.parse);
  assert.ok(selected.length > 0 && selected.length < document.entries.length);
  for (const entry of selected)
    assert.equal(entry.content, document.entries.find((candidate) => candidate.id === entry.id).content);
});

test("escaped content cannot exceed the context budget or disappear without a list hint", async (t) => {
  const { store } = await fixture(t);
  await store.remember({ content: "<".repeat(2000), category: "preference", scope: "user", source });
  const context = await userMemoryContext(store);
  assert.ok(context.length <= USER_MEMORY_MAX_CONTEXT_CHARS);
  assert.match(context, /manage_user_memory to list them/);
  assert.equal(context.split("\n").filter((line) => line.startsWith("{")).length, 0);
});

async function lockedWrite(path) {
  const moduleUrl = new URL("../dist/src/runtime/user-memory-store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { UserMemoryStore } from ${JSON.stringify(moduleUrl)};
       const started = Date.now();
       try { await new UserMemoryStore(${JSON.stringify(path)}).setEnabled(true);
         console.log(JSON.stringify({ok:true,elapsed:Date.now()-started})); }
       catch(error) { console.log(JSON.stringify({ok:false,elapsed:Date.now()-started,error:error.message})); }`
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null, `storage write exceeded 1500ms: ${output}`);
    assert.equal(code, 0, output);
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}

test("a live data-lock owner causes a short failure without blocking reads or losing data", async (t) => {
  const { store } = await fixture(t, false);
  await store.saveText("保留已有内容", userMemoryRevision(await store.read()));
  const original = await readFile(store.path, "utf8");
  await mkdir(`${store.path}.lock`);
  const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname() });
  await writeFile(`${store.path}.lock/owner.json`, owner);
  assert.equal((await store.read()).entries[0].content, "保留已有内容");
  const result = await lockedWrite(store.path);
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out acquiring file lock/);
  assert.ok(result.elapsed < 1000);
  assert.equal(await readFile(store.path, "utf8"), original);
  assert.equal(await readFile(`${store.path}.lock/owner.json`, "utf8"), owner);
});

test("a fresh data lock left by a dead local owner is recovered immediately", async (t) => {
  const { store } = await fixture(t, false);
  const departed = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(departed, "exit");
  await mkdir(`${store.path}.lock`);
  await writeFile(
    `${store.path}.lock/owner.json`,
    JSON.stringify({ token: randomUUID(), pid: departed.pid, host: hostname() })
  );
  const result = await lockedWrite(store.path);
  assert.equal(result.ok, true);
  assert.ok(result.elapsed < 1000);
  assert.equal((await store.read()).enabled, true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalContextStore } from "../dist/src/runtime/personal-context-store.js";
import { PersonalContextService } from "../dist/src/runtime/personal-context-service.js";
import { PersonalContextManagement } from "../dist/src/runtime/personal-context-management.js";
import { PersonalContextDelivery } from "../dist/src/runtime/personal-context-delivery.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { PersonalContextChat } from "../dist/src/runtime/personal-context-chat.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { writeSleep } from "../dist/src/runtime/main-sleep.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cowork-context-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PersonalContextStore({ path: join(root, "home/personal-context/context.json") });
  const workspaceRoot = join(root, "tasks");
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  for (const taskId of ["task-a", "task-b", "task-c"]) {
    await workspace.createTask(taskId);
    await workspace.createRun(taskId, "run-a");
    await workspace.updateTask(taskId, { status: "waiting", activeRunId: "run-a" });
  }
  const host = { workspaceRoot, taskId: "task-b", runId: "run-a" };
  let serial = 0;
  const request = () =>
    new PersonalContextService(store, {
      assess: async () => ({ authorized: true, sensitive: false, statement: "self_report" })
    }).openRequest({
      workspaceRoot,
      taskId: "task-a",
      runId: "run-a",
      messageId: `message-${++serial}`,
      operationId: "save",
      receivedAt: "2026-11-06T01:00:00Z",
      text: "保存会议",
      purpose: "personal_planning",
      permissions: ["read", "save", "update", "delete", "settings"],
      visibility: ["user", "task", "project"]
    });
  await (await request()).configure({ enabled: true });
  const input = {
    kind: "arrangement",
    status: "confirmed",
    title: "会议",
    content: "私密会议正文",
    visibility: "user",
    quote: "保存会议",
    observedAt: "2026-11-06T01:00:00Z"
  };
  const saved = await (await request()).save(input);
  const delivery = new PersonalContextDelivery(store);
  const inbox = (taskId = "task-b", runId = "run-a") =>
    new InboxStore(join(workspaceRoot, taskId, "runs", runId, "agents/main/inbox-store.json"));
  const follow = () => delivery.follow(host, saved.id, saved.revision);
  const update = () =>
    request().then((r) => r.update(saved.id, 1, { ...input, content: "更新后的私密正文" }));
  return {
    root,
    store,
    workspaceRoot,
    workspace,
    host,
    request,
    input,
    saved,
    delivery,
    inbox,
    follow,
    update
  };
}

test("only explicitly linked existing work receives a durable reference-only change", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await f.follow();
  assert.equal((await f.store.read()).links.length, 1);
  await f.update();
  await f.delivery.runTask(f.host);
  await f.delivery.runTask(f.host);
  const messages = await f.inbox().list();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.contextId, f.saved.id);
  assert.equal(messages[0].payload.revision, 2);
  assert.equal(JSON.stringify(messages).includes("私密"), false);
  assert.equal((await f.inbox("task-c").list()).length, 0);
  assert.equal((await f.store.read()).events.length, 0);
  assert.equal((await f.workspace.listTasks()).length, 3);
});

test("crash after enqueue before acknowledgement replays the same Inbox identity", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await f.update();
  const crashing = new PersonalContextDelivery(f.store, {
    afterEnqueue: () => {
      throw new Error("crash");
    }
  });
  await assert.rejects(crashing.runTask(f.host), /crash/);
  assert.equal((await f.inbox().list()).length, 1);
  assert.equal((await f.store.read()).events.filter((e) => e.targets.length).length, 1);
  await new PersonalContextDelivery(new PersonalContextStore({ path: f.store.path })).runTask(f.host);
  assert.equal((await f.inbox().list()).length, 1);
  assert.equal((await f.store.read()).events.length, 0);
});

test("revocation after enqueue prevents a stale event from reaching Main", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await f.update();
  await f.delivery.runTask(f.host);
  await (await f.request()).configure({ enabled: false });
  let launches = 0;
  await new MainSupervisor({
    workspaceRoot: f.workspaceRoot,
    personalContextStore: f.store,
    launch: () => {
      launches++;
    }
  }).runCycle({ taskId: "task-b" });
  assert.equal(launches, 0);
  const sent = [];
  const main = new MainInboxDelivery(f.workspaceRoot, "task-b", "run-a", { personalContextStore: f.store });
  await main.deliver((message) => sent.push(message));
  assert.deepEqual(sent, []);
  assert.equal((await f.inbox().list())[0].state, "consumed");
  await (await f.request()).configure({ enabled: true });
  assert.equal((await f.delivery.current(f.host)).length, 0);
});

test("scope, revision, run ownership and closed tasks cannot create links", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.delivery.follow(f.host, f.saved.id, 9), { code: "conflict" });
  await assert.rejects(f.delivery.follow({ ...f.host, runId: "other" }, f.saved.id, 1), { code: "conflict" });
  const scoped = await (await f.request()).save({ ...f.input, visibility: "task" });
  await assert.rejects(f.delivery.follow(f.host, scoped.id, 1), { code: "permission_denied" });
  await f.workspace.updateTask("task-b", { status: "cancelled" });
  await assert.rejects(f.follow(), { code: "inactive" });
  assert.equal((await f.store.read()).links.length, 0);
});

test("cancel and delete invalidate facts without resurrecting stale private data", async (t) => {
  const f = await fixture(t);
  await f.follow();
  const management = new PersonalContextManagement(f.store);
  let doc = await management.overview();
  await management.change({
    basis: doc.basis,
    snapshotRevision: doc.snapshotRevision,
    change: { action: "cancel", id: f.saved.id, revision: 1 }
  });
  const facts = await f.delivery.current(f.host);
  assert.equal(facts[0].status, "cancelled");
  await f.delivery.runTask(f.host);
  doc = await management.overview();
  await management.change({
    basis: doc.basis,
    snapshotRevision: doc.snapshotRevision,
    change: { action: "forget", id: f.saved.id, revision: 2 }
  });
  await f.delivery.runTask(f.host);
  assert.equal((await f.store.read()).records.length, 0);
  assert.equal((await f.inbox().list()).at(-1).payload.reason, "deleted");
  const sent = [];
  await new MainInboxDelivery(f.workspaceRoot, "task-b", "run-a", { personalContextStore: f.store }).deliver(
    (m) => sent.push(m)
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /deleted/);
  assert.equal((await f.delivery.current(f.host)).length, 0);
  assert.equal((await readFile(f.store.path, "utf8")).includes("私密"), false);
});

test("existing poll and Main supervisors hold paused dependencies, then resume the original work", async (t) => {
  const f = await fixture(t);
  const programs = new WatchProgramStore(f.workspaceRoot);
  const program = await programs.createProgram({
    taskId: "task-b",
    subject: "existing work",
    objective: "continue existing work"
  });
  await f.delivery.follow(f.host, f.saved.id, 1, program.programId);
  await programs.updateProgram("task-b", program.programId, { status: "paused" });
  await f.update();
  const poll = () =>
    new WatchSupervisor({
      workspaceRoot: f.workspaceRoot,
      baseUrl: "",
      apiKey: "",
      personalContext: f.delivery
    }).runCycle({ taskId: "task-b", phase: "poll" });
  const paused = await poll();
  assert.deepEqual(paused.failures, []);
  assert.deepEqual(await f.inbox().list(), []);
  assert.equal((await f.store.read()).events.filter((e) => e.targets.length).length, 1);
  let launches = 0;
  const supervisor = () =>
    new MainSupervisor({
      workspaceRoot: f.workspaceRoot,
      personalContextStore: f.store,
      launch: () => {
        launches++;
      }
    });
  await supervisor().runCycle({ taskId: "task-b" });
  assert.equal(launches, 0);
  await programs.updateProgram("task-b", program.programId, { status: "active" });
  const resumed = await poll();
  assert.deepEqual(resumed.failures, []);
  assert.equal((await f.inbox().list()).length, 1);
  assert.equal((await supervisor().runCycle({ taskId: "task-b" })).resumed, 1);
  assert.equal(launches, 1);
});

test("multiple recipients acknowledge independently and superseded events do not replay old plans", async (t) => {
  const f = await fixture(t);
  const other = { ...f.host, taskId: "task-c" };
  await f.follow();
  await f.delivery.follow(other, f.saved.id, 1);
  await f.update();
  await f.delivery.runTask(f.host);
  assert.equal((await f.store.read()).events.filter((e) => e.targets.length).length, 1);
  await (await f.request()).update(f.saved.id, 2, { ...f.input, content: "最新安排" });
  await f.delivery.runTask(f.host);
  await f.delivery.runTask(other);
  const sent = [];
  await new MainInboxDelivery(f.workspaceRoot, "task-b", "run-a", { personalContextStore: f.store }).deliver(
    (m) => sent.push(m)
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.revision, 3);
  assert.equal((await f.inbox("task-c").list()).length, 1);
  assert.equal((await f.store.read()).events.length, 0);
});

test("restored chat can read linked current facts without acquiring write authority", async (t) => {
  const f = await fixture(t);
  const chat = () =>
    new PersonalContextChat({
      ...f.host,
      store: f.store,
      assess: async () => {
        throw new Error("internal recovery must not authorize a write");
      }
    });
  const original = chat();
  original.setSource({
    messageId: "current",
    receivedAt: "2026-11-06T01:00:00Z",
    text: "查看我的会议安排并继续规划"
  });
  await original.tool.execute({ action: "follow", id: f.saved.id, revision: 1 });
  await f.update();
  const restored = chat();
  assert.match(await restored.project(), /更新后的私密正文/);
  const result = await restored.tool.execute({ action: "query" });
  assert.equal(result.linkedOnly, true);
  assert.equal(result.records[0].revision, 2);
  await assert.rejects(restored.tool.execute({ action: "save", context: f.input }), {
    code: "source_rejected"
  });
  const unrelated = new PersonalContextChat({
    ...f.host,
    taskId: "task-c",
    store: f.store,
    assess: async () => {
      throw new Error();
    }
  });
  assert.equal(await unrelated.project(), "");
  assert.deepEqual((await unrelated.tool.execute({ action: "query" })).records, []);
  await f.delivery.unfollow(f.host, f.saved.id);
  assert.equal(await chat().project(), "");
});

test("legacy snapshots migrate without inventing recipients or losing revocation barriers", async (t) => {
  const f = await fixture(t);
  const original = await f.store.read();
  const legacy = { ...original, version: 1 };
  delete legacy.links;
  legacy.events = legacy.events.map(({ targets, ...event }) => event);
  await writeFile(f.store.path, JSON.stringify(legacy));
  const migrated = await f.store.read();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.links, []);
  assert.deepEqual(migrated.requests, original.requests);
  assert.equal(migrated.generation, original.generation);
  await f.follow();
  assert.equal(JSON.parse(await readFile(f.store.path, "utf8")).version, 2);
});

test("a v2 event missing its recipient list is corruption, not an empty notification", async (t) => {
  const f = await fixture(t);
  await f.follow();
  await f.update();
  const doc = await f.store.read();
  delete doc.events.at(-1).targets;
  const raw = JSON.stringify(doc);
  await writeFile(f.store.path, raw);
  await assert.rejects(f.store.read(), { code: "storage_invalid" });
  assert.equal(await readFile(f.store.path, "utf8"), raw);
});

test("corrupt personal context reports a failure without blocking an unrelated scheduled wake", async (t) => {
  const f = await fixture(t);
  await writeSleep(f.workspaceRoot, "task-c", {
    runId: "run-a",
    reason: "unrelated work",
    monitorIds: [],
    parkedAt: "2026-01-01T00:00:00Z",
    wakeAt: "2026-01-01T00:01:00Z"
  });
  await writeFile(f.store.path, "{broken");
  const result = await new WatchSupervisor({
    workspaceRoot: f.workspaceRoot,
    baseUrl: "",
    apiKey: "",
    personalContext: f.delivery
  }).runCycle({ taskId: "task-c", phase: "poll" });
  assert.equal(result.failures.length, 1);
  assert.equal(result.parkWakes, 1);
  assert.equal((await f.inbox("task-c").list())[0].payload.type, "main.scheduled_wake");
  assert.equal(await readFile(f.store.path, "utf8"), "{broken");
});

test(
  "real Pi requests refresh registered dependencies on recovery and reject internal writes",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.follow();
    await f.update();
    const requests = [];
    let step = 0;
    const provider = await modelProtocolFixture("openai-completions", async (body) => {
      requests.push(body);
      if (step++ === 0) return { name: "manage_personal_context", arguments: { action: "query" } };
      if (step === 2)
        return { name: "manage_personal_context", arguments: { action: "save", context: f.input } };
      return { text: "Done" };
    });
    t.after(() => provider.close());
    const restored = new PersonalContextChat({
      ...f.host,
      store: new PersonalContextStore({ path: f.store.path }),
      assess: async () => {
        throw new Error("no internal assessment");
      }
    });
    const result = await new PiSession({
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      api: "openai-completions",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      tools: new Map([["manage_personal_context", restored.tool]]),
      preparePersonalContext: () => restored.project(),
      refreshPersonalContext: (messages) => restored.refreshMessages(messages),
      timeoutMs: 15000
    }).run("Internal continuation for existing work");
    assert.equal(result.termination, "completed");
    assert.match(JSON.stringify(requests[0].messages.filter((m) => m.role === "system")), /更新后的私密正文/);
    const finalTools = JSON.stringify(requests.at(-1).messages.filter((m) => m.role === "tool"));
    assert.match(finalTools, /linkedOnly/);
    assert.match(finalTools, /source_rejected/);
    assert.doesNotMatch(finalTools, /query revoked or changed/);
    assert.equal((await f.store.read()).records.length, 1);
    assert.equal((await f.store.read()).records[0].revision, 2);
  }
);

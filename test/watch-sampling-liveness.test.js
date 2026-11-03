import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WatchSupervisor, WatchSupervisorLoop } from "../dist/src/runtime/watch-supervisor.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";

const success = { status: "succeeded", response: "classification: relevant_change\nVerified", artifacts: [] };

async function fixture(t, spec = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-watch-sampling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("task", { goal: "monitor" });
  await workspace.createRun("task", "main-task");
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({ taskId: "task", subject: "x", objective: "x" });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "x",
    activate: true,
    ...spec
  });
  const state = () => programs.readVirtualAgentState("task", program.programId, monitor.monitorId);
  const due = () =>
    programs.updateVirtualAgentState("task", program.programId, monitor.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
  const inbox = new InboxStore(
    join(root, "task", "runs", `watch-${program.programId}`, "agents", monitor.monitorId, "inbox-store.json")
  );
  const main = new InboxStore(join(root, "task", "runs", "main-task", "agents", "main", "inbox-store.json"));
  let sequence = 0;
  const event = () => [
    {
      watcherId: monitor.monitorId,
      source: "fixture",
      type: "changed",
      dedupeKey: `event-${++sequence}`,
      payload: { sequence }
    }
  ];
  return { root, programs, program, monitor, state, due, inbox, main, event };
}

test("an analysis finishing after a source outage preserves the outage and its retry deadline", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let offline = false;
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: f.monitor.monitorId,
      poll: async () => {
        if (offline) throw new Error("source is offline");
        return f.event();
      }
    }),
    executor: async () => {
      started.resolve();
      return finish.promise;
    }
  });
  await supervisor.runCycle({ phase: "poll" });
  const analysis = supervisor.runCycle({ phase: "analyze" });
  try {
    await started.promise;
    offline = true;
    await f.due();
    await supervisor.runCycle({ phase: "poll" });
    const failed = await f.state();
    assert.equal(failed.processing, true);
    assert.equal(failed.pollFailures, 1);
    finish.resolve(success);
    await analysis;
    const final = await f.state();
    assert.equal(final.pollRetryAt, failed.pollRetryAt);
    assert.equal(final.pollFailures, 1);
    assert.equal(final.analysisFailures, 0);
    assert.equal(final.status, "failed");
    assert.match(final.lastSummary, /source is offline/);
    assert.equal(final.checkCount, 2);
    assert.equal(final.processing, false);
    assert.equal((await f.main.list("main")).length, 1);
  } finally {
    finish.resolve(success);
    await analysis;
  }
});

test("a poll finishing after an analysis failure keeps the model error and captures new evidence", async (t) => {
  const f = await fixture(t);
  const analysisStarted = Promise.withResolvers();
  const pollStarted = Promise.withResolvers();
  const finishAnalysis = Promise.withResolvers();
  const finishPoll = Promise.withResolvers();
  let polls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: f.monitor.monitorId,
      poll: async () => {
        if (++polls === 2) {
          pollStarted.resolve();
          await finishPoll.promise;
        }
        return f.event();
      }
    }),
    executor: async () => {
      analysisStarted.resolve();
      await finishAnalysis.promise;
      throw new Error("model is offline");
    }
  });
  await supervisor.runCycle({ phase: "poll" });
  const analysis = supervisor.runCycle({ phase: "analyze" });
  await analysisStarted.promise;
  await f.due();
  const poll = supervisor.runCycle({ phase: "poll" });
  try {
    await pollStarted.promise;
    finishAnalysis.resolve();
    await analysis;
    const failed = await f.state();
    finishPoll.resolve();
    await poll;
    const final = await f.state();
    assert.equal(final.analysisRetryAt, failed.analysisRetryAt);
    assert.equal(final.analysisFailures, 1);
    assert.equal(final.pollFailures, 0);
    assert.equal(final.status, "failed");
    assert.match(final.lastSummary, /model is offline/);
    assert.equal(final.eventCount, 2);
    assert.equal(final.checkCount, 2);
    assert.equal(final.modelRunCount, 1);
    assert.equal(
      (await f.inbox.list(f.monitor.monitorId)).filter((message) => message.state !== "consumed").length,
      2
    );
  } finally {
    finishAnalysis.resolve();
    finishPoll.resolve();
    await Promise.all([analysis, poll]);
  }
});

test("direct delivery cannot consume an unapplied control or clear a running control analysis", async (t) => {
  const f = await fixture(t, { eventMode: "direct", maxWakeRequestsPerDay: 1 });
  await f.programs.enqueueControl("task", f.monitor.monitorId, "Review the changed monitoring goal");
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({ watcherId: f.monitor.monitorId, poll: async () => f.event() }),
    executor: async ({ controlMessages }) => {
      assert.deepEqual(controlMessages, ["Review the changed monitoring goal"]);
      started.resolve();
      return finish.promise;
    }
  });
  const analysis = supervisor.runCycle({ phase: "analyze" });
  try {
    await started.promise;
    await supervisor.runCycle({ phase: "poll" });
    assert.equal((await f.state()).processing, true);
    assert.equal((await f.programs.listControls("task", f.program.programId, f.monitor.monitorId)).length, 1);
    finish.resolve(success);
    await analysis;
    assert.equal((await f.main.list("main")).length, 1);
    assert.equal((await f.state()).wakeRequestsToday, 1);
    assert.ok((await f.state()).wakeRetryAt);
    assert.equal(
      (await f.programs.listControls("task", f.program.programId, f.monitor.monitorId)).length,
      1,
      "a control whose result could not be delivered remains queued"
    );
    const checks = (await f.state()).checkCount;
    await f.due();
    await supervisor.runCycle({ phase: "poll" });
    assert.equal((await f.state()).checkCount, checks + 1, "wake quotas cannot block cheap collection");
  } finally {
    finish.resolve(success);
    await analysis;
  }
});

test("a successful control cannot clear a concurrent direct-delivery failure", async (t) => {
  const f = await fixture(t, { eventMode: "direct", maxWakeRequestsPerDay: 2 });
  await f.programs.enqueueControl("task", f.monitor.monitorId, "Review this goal");
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const originalEnqueue = InboxStore.prototype.enqueue;
  InboxStore.prototype.enqueue = async function (message) {
    if (
      message.payload?.type === "watch.virtual_agent_result" &&
      !message.payload.monitorRunId.startsWith("control-")
    )
      throw new Error("main inbox is temporarily unavailable");
    return originalEnqueue.call(this, message);
  };
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({ watcherId: f.monitor.monitorId, poll: async () => f.event() }),
    executor: async () => {
      started.resolve();
      return finish.promise;
    }
  });
  const analysis = supervisor.runCycle({ phase: "analyze" });
  try {
    await started.promise;
    await supervisor.runCycle({ phase: "poll" });
    const failed = await f.state();
    assert.equal(failed.deliveryFailures, 1);
    assert.equal(failed.processing, true);
    finish.resolve(success);
    await analysis;
    const final = await f.state();
    assert.equal(final.deliveryRetryAt, failed.deliveryRetryAt);
    assert.equal(final.deliveryFailures, 1);
    assert.equal(final.analysisFailures, 0);
    assert.match(final.lastSummary, /main inbox is temporarily unavailable/);
    assert.equal(final.status, "failed");
    assert.equal((await f.inbox.list(f.monitor.monitorId))[0].state, "ready");
    InboxStore.prototype.enqueue = originalEnqueue;
    await f.programs.updateVirtualAgentState("task", f.program.programId, f.monitor.monitorId, {
      deliveryRetryAt: undefined,
      wakeRetryAt: "2999-01-01T00:00:00Z"
    });
    await supervisor.runCycle({ phase: "poll" });
    assert.equal((await f.inbox.list(f.monitor.monitorId))[0].state, "consumed");
    assert.equal((await f.state()).deliveryFailures, 0);
    assert.equal((await f.state()).modelRunCount, 1);
    assert.equal(
      (await f.state()).wakeRequestsToday,
      2,
      "a failed enqueue keeps its reservation when retried"
    );
  } finally {
    InboxStore.prototype.enqueue = originalEnqueue;
    finish.resolve(success);
    await analysis;
  }
});

test("a changed wake quota takes effect during analysis and increasing it releases the cached result", async (t) => {
  const f = await fixture(t, { maxWakeRequestsPerDay: 2 });
  const management = new WatchManagement(f.root, resolve("."));
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({ watcherId: f.monitor.monitorId, poll: async () => f.event() }),
    executor: async () => {
      started.resolve();
      return finish.promise;
    }
  });
  await f.programs.updateVirtualAgentState("task", f.program.programId, f.monitor.monitorId, {
    wakeBudgetDay: new Date().toISOString().slice(0, 10),
    wakeRequestsToday: 1,
    wakeRequestCount: 1,
    wakeRequestIds: ["previous-delivery"]
  });
  await supervisor.runCycle({ phase: "poll" });
  const analysis = supervisor.runCycle({ phase: "analyze" });
  try {
    await started.promise;
    await management.control("task", f.monitor.monitorId, "configure", { maxWakeRequestsPerDay: 1 });
    finish.resolve(success);
    await analysis;
    assert.equal((await f.main.list("main")).length, 0);
    assert.ok((await f.state()).wakeRetryAt);
    await management.control("task", f.monitor.monitorId, "configure", { maxWakeRequestsPerDay: 2 });
    await supervisor.runCycle({ phase: "analyze" });
    assert.equal((await f.main.list("main")).length, 1);
    assert.equal((await f.state()).modelRunCount, 1, "delivery retries reuse the successful analysis");
    assert.equal((await f.state()).wakeRetryAt, undefined);
  } finally {
    finish.resolve(success);
    await analysis;
  }
});

test("the CLI supervisor loop keeps polling while an analysis is held", { timeout: 8000 }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const observedAgain = Promise.withResolvers();
  let analysisHasStarted = false;
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    signal: controller.signal,
    pollerFactory: () => ({ watcherId: f.monitor.monitorId, poll: async () => f.event() }),
    executor: async () => {
      started.resolve();
      return finish.promise;
    }
  });
  const loop = new WatchSupervisorLoop();
  const running = loop.run(supervisor, {
    intervalMs: 1000,
    signal: controller.signal,
    onCycle: (result) => {
      if (result.polled && analysisHasStarted) observedAgain.resolve();
    }
  });
  try {
    await started.promise;
    // The callback observes a second poll after the held analysis has begun.
    analysisHasStarted = true;
    await f.due();
    await observedAgain.promise;
    assert.equal((await f.state()).checkCount, 2);
    assert.equal((await f.state()).processing, true);
    assert.equal((await f.state()).modelRunCount, 1);
  } finally {
    controller.abort();
    finish.resolve(success);
    await running;
  }
});

test("a single CLI cycle also runs when no reporting callback is installed", async (t) => {
  const f = await fixture(t, { eventMode: "direct" });
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({ watcherId: f.monitor.monitorId, poll: async () => f.event() })
  });
  await new WatchSupervisorLoop().run(supervisor, { once: true });
  assert.equal((await f.state()).checkCount, 1);
  assert.equal((await f.main.list("main")).length, 1);
});

for (const eventMode of ["direct", "analyze"]) {
  test(`${eventMode}: a one-shot template retires as soon as its final event is delivered`, async (t) => {
    const f = await fixture(t);
    const startAt = new Date(Date.now() + 3000).toISOString();
    const created = await new WatchManagement(f.root, resolve(".")).create("task", "main-task", {
      template: "timer",
      task: "one final reminder",
      cadenceSeconds: 60,
      eventMode,
      config: { startAt, intervalMs: null }
    });
    assert.equal(created.activated, true);
    await delay(Math.max(0, Date.parse(startAt) - Date.now()) + 20);
    await f.programs.updateVirtualAgentState("task", created.programId, created.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
    const supervisor = new WatchSupervisor({
      workspaceRoot: f.root,
      baseUrl: "fixture",
      apiKey: "k",
      executor: async () => success
    });
    const cycle = await supervisor.runCycle({ taskId: "task", programId: created.programId });
    assert.equal(cycle.wakeRequests, 1);
    assert.equal((await f.programs.findVirtualAgent("task", created.monitorId)).monitor.status, "retired");
    assert.equal(
      (await f.programs.readVirtualAgentState("task", created.programId, created.monitorId)).modelRunCount ??
        0,
      eventMode === "direct" ? 0 : 1
    );
  });
}

test("an active monitor can rebuild missing runtime state and still report a source failure", async (t) => {
  const f = await fixture(t);
  await rm(
    join(
      f.root,
      "task",
      "watch",
      "programs",
      f.program.programId,
      "monitor-state",
      `${f.monitor.monitorId}.json`
    )
  );
  const supervisor = new WatchSupervisor({
    workspaceRoot: f.root,
    baseUrl: "fixture",
    apiKey: "k",
    pollerFactory: () => ({
      watcherId: f.monitor.monitorId,
      poll: async () => {
        throw new Error("source unavailable after restart");
      }
    })
  });
  await supervisor.runCycle();
  const state = await f.state();
  assert.equal(state.status, "failed");
  assert.equal(state.pollFailures, 1);
  assert.equal(state.checkCount, 1);
  assert.match(state.lastSummary, /source unavailable after restart/);
});

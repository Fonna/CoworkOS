import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor, WatchSupervisorLoop } from "../dist/src/runtime/watch-supervisor.js";
import { writeSleep } from "../dist/src/runtime/main-sleep.js";
import { WatcherRuntime } from "../dist/src/runtime/watcher.js";

const execute = promisify(execFile);

async function recoverInNewProcess(root) {
  const module = pathToFileURL(resolve("dist/src/runtime/watch-supervisor.js")).href;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|ATRIA_|PI_|SERPER_)/.test(name))
  );
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { WatchSupervisor } from ${JSON.stringify(module)};
    const supervisor = new WatchSupervisor({
      workspaceRoot: process.argv[1], baseUrl: "http://unused.test", apiKey: "fixture",
      executor: async () => { throw new Error("fixture: unexpected repeated model analysis"); }
    });
    console.log(JSON.stringify(await supervisor.runCycle({ taskId: "t" })));
  `,
      root
    ],
    { env, timeout: 10_000 }
  );
  return JSON.parse(stdout);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-watch-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("t");
  await workspace.createRun("t", "main-t");
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({
    taskId: "t",
    programId: "topic",
    subject: "fixture",
    objective: "find changes"
  });
  const monitor = await programs.createVirtualAgent({
    programId: program.programId,
    task: "classify",
    profileId: "custom",
    cadenceSeconds: 60,
    wake: "important",
    activate: true
  });
  // A pending source event is accepted before the supervisor starts. Avoid
  // polling again so each assertion isolates its analysis/delivery lifecycle.
  await programs.updateVirtualAgentState("t", program.programId, monitor.monitorId, {
    lastCheckedAt: new Date().toISOString()
  });
  await new WatcherRuntime({
    workspaceRoot: root,
    taskId: "t",
    runId: "watch-topic",
    programId: program.programId,
    recipientAgentId: monitor.monitorId
  }).ingest({
    watcherId: monitor.monitorId,
    source: "fixture",
    type: "fixture.changed",
    dedupeKey: "change-1",
    payload: { title: "important change" }
  });
  const mainPath = join(root, "t", "runs", "main-t", "agents", "main", "inbox-store.json");
  const mainInbox = new InboxStore(mainPath);
  const sourceInbox = new InboxStore(
    join(root, "t", "runs", "watch-topic", "agents", monitor.monitorId, "inbox-store.json")
  );
  const supervisor = (executor) =>
    new WatchSupervisor({ workspaceRoot: root, baseUrl: "http://unused.test", apiKey: "fixture", executor });
  return { root, workspace, programs, program, monitor, mainPath, mainInbox, sourceInbox, supervisor };
}

const outcome = {
  status: "succeeded",
  response: "classification: relevant_change\nFixture evidence",
  artifacts: [],
  outputFiles: ["fixture.txt"]
};

test("an analyzed Watch result survives a failed Main write and a supervisor restart", async (t) => {
  const f = await fixture(t);
  let executions = 0;
  const first = await f
    .supervisor(async () => {
      executions += 1;
      await mkdir(f.mainPath, { recursive: true });
      return outcome;
    })
    .runCycle({ taskId: "t" });
  assert.equal(first.failures.length, 1);
  assert.match(first.failures[0].error, /EISDIR/);
  assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "ready");
  const failedState = await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId);
  assert.equal(failedState.pendingWake.message.payload.summary, outcome.response);
  assert.equal(
    failedState.lastWakeAt,
    undefined,
    "an uncommitted delivery must not claim to have woken Main"
  );
  await rm(f.mainPath, { recursive: true });
  await f.programs.updateProgram("t", "topic", { status: "paused" });
  const paused = await f
    .supervisor(async () => {
      assert.fail("a paused outbox must not restart analysis");
    })
    .runCycle({ taskId: "t" });
  assert.equal(paused.wakeRequests, 0);
  assert.equal((await f.mainInbox.list("main")).length, 0);
  assert.ok(
    (await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId)).pendingWake,
    "pausing must retain the pending delivery until resumed"
  );
  await f.programs.updateProgram("t", "topic", { status: "monitoring" });
  await f.workspace.updateTask("t", { activeRunId: "different-main-run" });
  const restarted = f.supervisor(async () => {
    assert.fail("a saved analysis must not spend another model run");
  });
  const repaired = await recoverInNewProcess(f.root);
  assert.equal(repaired.failures.length, 0);
  assert.equal(repaired.wakeRequests, 1);
  assert.equal(executions, 1);
  const [wake] = await f.mainInbox.list("main");
  assert.equal(wake.payload.summary, outcome.response);
  assert.deepEqual(wake.payload.outputFiles, ["fixture.txt"]);
  assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "consumed");
  const state = await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId);
  assert.equal(state.pendingWake, undefined);
  assert.equal(state.status, "active");
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastSummary, outcome.response);
  await restarted.runCycle({ taskId: "t" });
  assert.equal((await f.mainInbox.list("main")).length, 1);
});

test("a restart after enqueue before outbox acknowledgement preserves Main's consumed receipt", async (t) => {
  const f = await fixture(t);
  const original = WatchProgramStore.prototype.updateVirtualAgentState;
  let interrupted = false;
  const fault = t.mock.method(
    WatchProgramStore.prototype,
    "updateVirtualAgentState",
    async function (taskId, programId, monitorId, patch) {
      const changes =
        typeof patch === "function"
          ? patch(await this.readVirtualAgentState(taskId, programId, monitorId))
          : patch;
      if (!interrupted && Object.hasOwn(changes, "pendingWake") && changes.pendingWake === undefined) {
        interrupted = true;
        throw new Error("fixture interrupted after enqueue");
      }
      return original.call(this, taskId, programId, monitorId, patch);
    }
  );
  const failed = await f.supervisor(async () => outcome).runCycle({ taskId: "t" });
  assert.equal(failed.failures.length, 1);
  assert.ok((await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId)).pendingWake);
  const [wake] = await f.mainInbox.list("main");
  await f.mainInbox.leaseMessage("main", wake.messageId);
  await f.mainInbox.consume(wake.messageId);
  fault.mock.restore();
  const recovered = await recoverInNewProcess(f.root);
  assert.equal(recovered.failures.length, 0);
  const receipts = await f.mainInbox.list("main");
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].state,
    "consumed",
    "replay must not turn a delivered result into another instruction"
  );
  assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "consumed");
});

test("a successfully analyzed control survives a failed Main write without being executed again", async (t) => {
  const f = await fixture(t);
  const source = await f.sourceInbox.lease(f.monitor.monitorId);
  await f.sourceInbox.consume(source.messageId);
  const control = await f.programs.enqueueControl("t", f.monitor.monitorId, "narrow the monitor scope");
  let executions = 0;
  const first = await f
    .supervisor(async (input) => {
      assert.deepEqual(input.controlMessages, [control.message]);
      executions += 1;
      await mkdir(f.mainPath, { recursive: true });
      return outcome;
    })
    .runCycle({ taskId: "t" });
  assert.equal(first.failures.length, 1);
  const saved = await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId);
  assert.deepEqual(saved.pendingWake.controlMessageIds, [control.messageId]);
  assert.equal(
    (await f.programs.listControls("t", "topic", f.monitor.monitorId)).length,
    1,
    "delivery failure must not consume the control prematurely"
  );
  await rm(f.mainPath, { recursive: true });
  const restarted = f.supervisor(async () => {
    assert.fail("a completed control must not spend another model run");
  });
  const repaired = await recoverInNewProcess(f.root);
  assert.equal(repaired.failures.length, 0);
  assert.equal(repaired.wakeRequests, 1);
  assert.equal(executions, 1);
  assert.equal((await f.programs.listControls("t", "topic", f.monitor.monitorId)).length, 0);
  const [wake] = await f.mainInbox.list("main");
  assert.equal(wake.payload.summary, outcome.response);
  assert.equal(
    (await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId)).pendingWake,
    undefined
  );
  await restarted.runCycle({ taskId: "t" });
  assert.equal((await f.mainInbox.list("main")).length, 1);
});

for (const pollingFailed of [false, true])
  test(`a failed source receipt retries without repeating work${pollingFailed ? " or hiding a polling failure" : ""}`, async (t) => {
    const f = await fixture(t);
    const original = InboxStore.prototype.consume;
    let interrupted = false;
    const fault = t.mock.method(InboxStore.prototype, "consume", async function (messageId) {
      if (!interrupted && messageId.startsWith("external-")) {
        interrupted = true;
        throw new Error("fixture source receipt failed");
      }
      return original.call(this, messageId);
    });
    const first = await f.supervisor(async () => outcome).runCycle({ taskId: "t" });
    assert.equal(first.failures.length, 1);
    assert.equal((await f.mainInbox.list("main")).length, 1);
    assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "ready");
    fault.mock.restore();
    if (pollingFailed)
      await f.programs.updateVirtualAgentState("t", "topic", f.monitor.monitorId, {
        pollFailures: 1,
        pollError: "fixture polling failure",
        pollRetryAt: new Date(Date.now() + 60_000).toISOString()
      });
    const repaired = await f
      .supervisor(async () => {
        assert.fail("an analyzed source must not run again");
      })
      .runCycle({ taskId: "t" });
    assert.equal(repaired.failures.length, 0);
    assert.equal((await f.mainInbox.list("main")).length, 1);
    assert.equal((await f.sourceInbox.list(f.monitor.monitorId))[0].state, "consumed");
    const state = await f.programs.readVirtualAgentState("t", "topic", f.monitor.monitorId);
    assert.equal(state.status, pollingFailed ? "failed" : "active");
    assert.equal(state.consecutiveFailures, pollingFailed ? 1 : 0);
    assert.equal(state.lastSummary, pollingFailed ? "fixture polling failure" : outcome.response);
  });

for (const status of ["paused", "completed"])
  test(`an event-only park ${status === "paused" ? "stays paused" : "wakes"} when its only Watch Program becomes ${status}`, async (t) => {
    const f = await fixture(t);
    await writeSleep(f.root, "t", {
      runId: "main-t",
      reason: "wait for this monitor",
      monitorIds: [f.monitor.monitorId],
      parkedAt: new Date().toISOString()
    });
    await f.programs.updateProgram("t", "topic", { status });
    const supervisor = f.supervisor(async () => {
      assert.fail("a closed program must not run a model");
    });
    assert.equal((await supervisor.runCycle({ taskId: "t" })).parkWakes, status === "paused" ? 0 : 1);
    if (status === "paused") {
      assert.deepEqual(await f.mainInbox.list("main"), []);
      await supervisor.runCycle({ taskId: "t" });
      assert.deepEqual(await f.mainInbox.list("main"), [], "a paused source cannot fabricate a wake");
      return;
    }
    const [wake] = await f.mainInbox.list("main");
    assert.equal(wake.payload.type, "main.monitors_lost");
    await supervisor.runCycle({ taskId: "t" });
    assert.equal((await f.mainInbox.list("main")).length, 1, "the lost-condition wake is idempotent");
  });

test("a workspace supervisor notices Tasks created after its first cycle", async (t) => {
  const f = await fixture(t);
  await f.programs.updateProgram("t", "topic", { status: "paused" });
  const controller = new AbortController();
  const loop = new WatchSupervisorLoop();
  let cycles = 0;
  await loop.run(
    f.supervisor(async () => {
      assert.fail("clock wakes do not need a model");
    }),
    {
      intervalMs: 1_000,
      signal: controller.signal,
      onCycle: async () => {
        cycles += 1;
        if (cycles === 1) {
          await f.workspace.createTask("later-task");
          await f.workspace.createRun("later-task", "main-later");
          await writeSleep(f.root, "later-task", {
            runId: "main-later",
            reason: "due now",
            monitorIds: [],
            parkedAt: new Date().toISOString(),
            wakeAt: new Date(Date.now() - 1_000).toISOString()
          });
        } else controller.abort();
      }
    }
  );
  assert.equal(cycles, 2);
  const inbox = new InboxStore(
    join(f.root, "later-task", "runs", "main-later", "agents", "main", "inbox-store.json")
  );
  assert.equal((await inbox.list("main"))[0].payload.type, "main.scheduled_wake");
});

test("two Task-scoped supervisor loops do not starve each other's due parks", async (t) => {
  const f = await fixture(t);
  await f.programs.updateProgram("t", "topic", { status: "paused" });
  await f.workspace.createTask("other");
  await f.workspace.createRun("other", "main-other");
  await writeSleep(f.root, "other", {
    runId: "main-other",
    reason: "due now",
    monitorIds: [],
    parkedAt: new Date().toISOString(),
    wakeAt: new Date(Date.now() - 1_000).toISOString()
  });
  const controller = new AbortController();
  let ready;
  const firstCycle = new Promise((resolve) => (ready = resolve));
  const first = new WatchSupervisorLoop().run(
    f.supervisor(async () => {
      assert.fail("no model expected");
    }),
    {
      taskId: "t",
      signal: controller.signal,
      onCycle: () => ready()
    }
  );
  try {
    await firstCycle;
    await new WatchSupervisorLoop().run(
      f.supervisor(async () => {
        assert.fail("no model expected");
      }),
      {
        taskId: "other",
        once: true
      }
    );
    const inbox = new InboxStore(
      join(f.root, "other", "runs", "main-other", "agents", "main", "inbox-store.json")
    );
    assert.equal((await inbox.list("main"))[0].payload.type, "main.scheduled_wake");
  } finally {
    controller.abort();
    await first;
  }
});

test("a workspace cycle skips a busy scoped Task and still wakes an unrelated Task", async (t) => {
  const f = await fixture(t);
  let release,
    started,
    executions = 0;
  const gate = new Promise((resolve) => (release = resolve));
  const analyzing = new Promise((resolve) => (started = resolve));
  const first = f
    .supervisor(async () => {
      executions += 1;
      started();
      await gate;
      return outcome;
    })
    .runCycle({ taskId: "t" });
  try {
    await analyzing;
    await f.workspace.createTask("other");
    await f.workspace.createRun("other", "main-other");
    await writeSleep(f.root, "other", {
      runId: "main-other",
      reason: "due now",
      monitorIds: [],
      parkedAt: new Date().toISOString(),
      wakeAt: new Date(Date.now() - 1_000).toISOString()
    });
    const before = Date.now();
    const overlapping = await f
      .supervisor(async () => {
        assert.fail("must not duplicate a live analysis");
      })
      .runCycle();
    assert.equal(overlapping.failures.length, 0);
    assert.equal(overlapping.parkWakes, 1);
    assert.ok(
      Date.now() - before < 1_000,
      "a busy Task must not stall the workspace for the full lock timeout"
    );
    assert.equal(executions, 1);
  } finally {
    release();
    await first;
  }
  assert.equal((await f.mainInbox.list("main")).length, 1);
});

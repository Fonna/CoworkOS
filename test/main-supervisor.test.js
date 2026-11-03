import assert from "node:assert/strict";
import { test } from "node:test";
import { hostname } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { MainSupervisor, MainSupervisorLoop } from "../dist/src/runtime/main-supervisor.js";
import { mainIsAlive, readHeartbeat, writeHeartbeat, HEARTBEAT_STALE_MS } from "../dist/src/runtime/main-heartbeat.js";
import { now } from "../dist/src/domain/types.js";

const RUN = "run-1";

async function workspace(t, { status = "running" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "opt-task";
  const store = new LocalWorkspaceStore(root);
  await store.createTask(taskId, { goal: "iterate" });
  await store.createRun(taskId, RUN);
  await store.updateTask(taskId, { activeRunId: RUN });
  if (status !== "created") await store.transitionTask(taskId, status, { runId: RUN });
  return { root, taskId, store };
}

function inboxFor(root, taskId) {
  return new InboxStore(join(root, taskId, "runs", RUN, "agents", "main", "inbox-store.json"));
}

async function queueCallback(root, taskId, messageId = "callback-1") {
  await inboxFor(root, taskId).enqueue({
    messageId, recipientAgentId: "main", kind: "callback", callId: "call-1",
    eventId: "event-1", priority: 1, state: "ready",
    payload: { status: "succeeded", response: "round finished" }, createdAt: now()
  });
}

/** A supervisor that records launches instead of starting real processes. */
function supervisorFor(root, extra = {}) {
  const launches = [];
  const supervisor = new MainSupervisor({
    workspaceRoot: root,
    launch: (input) => { launches.push(input); },
    ...extra
  });
  return { supervisor, launches };
}

test("a task with a pending callback and no live Main is resumed", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  const { supervisor, launches } = supervisorFor(root);

  const result = await supervisor.runCycle();
  assert.equal(result.resumed, 1);
  assert.deepEqual(launches, [{ taskId, runId: RUN }]);

  // The decision is recorded, so a restart is visible after the fact.
  const events = await readFile(join(root, taskId, "runs", RUN, "run_events.jsonl"), "utf8");
  assert.match(events, /main\.supervisor_resume/);
});

test("a task whose Main is alive is left alone", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  // This process stands in for a running Main: a fresh heartbeat with a live pid.
  await writeHeartbeat(root, taskId, RUN);

  const { supervisor, launches } = supervisorFor(root);
  const result = await supervisor.runCycle();
  assert.equal(result.resumed, 0);
  assert.equal(result.decisions[0].reason, "main_alive");
  assert.deepEqual(launches, [], "starting a second Main would put two agents on one project");
});

test("a stale heartbeat does not protect a Main that is gone", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  await writeHeartbeat(root, taskId, RUN);
  const { supervisor, launches } = supervisorFor(root, {
    nowMs: () => Date.now() + HEARTBEAT_STALE_MS * 2
  });
  await supervisor.runCycle();
  assert.equal(launches.length, 1, "a crashed Main stops refreshing; that is what absence looks like");
});

test("a task parked on a human question stays parked", async (t) => {
  const { root, taskId } = await workspace(t, { status: "waiting" });
  await queueCallback(root, taskId);
  await new HumanRequestStore(root).create({ taskId, runId: RUN, question: "Which paths are the scorer?" });

  const { supervisor, launches } = supervisorFor(root);
  const result = await supervisor.runCycle();
  assert.equal(result.decisions[0].reason, "awaiting_human");
  assert.deepEqual(launches, [], "resuming past a question would answer it on the user's behalf");
});

test("a task with nothing addressed to it is not resumed", async (t) => {
  const { root, taskId } = await workspace(t);
  const { supervisor, launches } = supervisorFor(root);
  const result = await supervisor.runCycle();
  assert.equal(result.decisions[0].reason, "no_pending_work");
  assert.deepEqual(launches, []);
});

test("an already consumed callback is not work", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  const inbox = inboxFor(root, taskId);
  await inbox.lease("main");
  await inbox.consume("callback-1");

  const { supervisor, launches } = supervisorFor(root);
  assert.equal((await supervisor.runCycle()).decisions[0].reason, "no_pending_work");
  assert.deepEqual(launches, []);
});

test("a leased-but-unconsumed callback still counts as work", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  // A Main that died mid-delivery leaves the message leased. It was never
  // consumed, so it still needs a Main.
  await inboxFor(root, taskId).lease("main");
  const { supervisor, launches } = supervisorFor(root);
  assert.equal((await supervisor.runCycle()).resumed, 1);
  assert.equal(launches.length, 1);
});

test("a finished task is not reopened by the supervisor", async (t) => {
  for (const status of ["completed", "cancelled", "failed"]) {
    await test(`status ${status}`, async (t2) => {
      const { root, taskId } = await workspace(t2, { status: "running" });
      await queueCallback(root, taskId);
      await new LocalWorkspaceStore(root).transitionTask(taskId, status, { runId: RUN });
      const { supervisor, launches } = supervisorFor(root);
      assert.equal((await supervisor.runCycle()).decisions[0].reason, "task_closed");
      assert.deepEqual(launches, [], "only the user reopens a finished task");
    });
  }
});

test("two supervisors racing the same task start exactly one Main", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);

  const launches = [];
  // Each supervisor writes a heartbeat as a real launch would, so the loser of
  // the lock re-checks liveness and finds the winner's Main.
  const make = () => new MainSupervisor({
    workspaceRoot: root,
    launch: async (input) => { launches.push(input); await writeHeartbeat(root, input.taskId, input.runId); }
  });
  const [a, b] = await Promise.all([make().runCycle(), make().runCycle()]);
  assert.equal(launches.length, 1, "the task lock must make the launch decision exclusive");
  assert.equal(a.resumed + b.resumed, 1);
});

test("a launch failure is reported rather than crashing the cycle", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  const supervisor = new MainSupervisor({
    workspaceRoot: root,
    launch: () => { throw new Error("spawn refused"); }
  });
  const result = await supervisor.runCycle();
  assert.equal(result.resumed, 0);
  assert.equal(result.decisions[0].reason, "launch_failed");
  assert.match(result.decisions[0].error, /spawn refused/);
});

test("one broken task does not stop the others from being inspected", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  // A directory that is not a task at all.
  await writeFile(join(root, "stray.txt"), "not a task");
  const { supervisor, launches } = supervisorFor(root);
  const result = await supervisor.runCycle();
  assert.equal(launches.length, 1);
  assert.ok(result.inspected >= 1);
});

test("heartbeat liveness distinguishes fresh, stale, dead and remote", async (t) => {
  const { root, taskId } = await workspace(t);
  assert.equal(mainIsAlive(await readHeartbeat(root, taskId)), false, "no heartbeat means no Main");

  await writeHeartbeat(root, taskId, RUN);
  const beat = await readHeartbeat(root, taskId);
  assert.equal(beat.pid, process.pid);
  assert.equal(mainIsAlive(beat), true);
  assert.equal(mainIsAlive(beat, Date.now() + HEARTBEAT_STALE_MS * 2), false, "an unrefreshed heartbeat expires");

  // A pid that cannot be running: absence is detected before the window elapses.
  assert.equal(mainIsAlive({ ...beat, pid: 2 ** 31 - 1 }), false);
  // A fresh heartbeat from another host is trusted on its timestamp, since its
  // pid means nothing here.
  assert.equal(mainIsAlive({ ...beat, pid: 2 ** 31 - 1, host: `${hostname()}-other` }), true);
  assert.equal(mainIsAlive({ ...beat, updatedAt: "not a date" }), false);
});

test("the loop can run a single cycle and stop", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);
  const { supervisor, launches } = supervisorFor(root);
  const cycles = [];
  await new MainSupervisorLoop().run(supervisor, { workspaceRoot: root, once: true, onCycle: (result) => { cycles.push(result); } });
  assert.equal(cycles.length, 1);
  assert.equal(launches.length, 1);
});

test("a Main that keeps dying is relaunched with growing backoff", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);

  const launches = [];
  let clock = Date.now();
  // The launcher writes no heartbeat, which is what a Main crashing on startup
  // looks like: relaunching every cycle would spend real money on a loop that
  // cannot make progress.
  const supervisor = new MainSupervisor({
    workspaceRoot: root,
    launch: (input) => { launches.push(input); },
    nowMs: () => clock
  });

  const first = await supervisor.runCycle();
  assert.equal(first.resumed, 1, "the first attempt is immediate");

  const immediate = await supervisor.runCycle();
  assert.equal(immediate.decisions[0].reason, "backoff");
  assert.ok(immediate.decisions[0].retryInMs > 0);
  assert.equal(launches.length, 1);

  clock += 61_000;
  assert.equal((await supervisor.runCycle()).resumed, 1, "eligible again after the wait");
  assert.equal(launches.length, 2);

  // The wait grows, so a persistent failure becomes cheap instead of constant.
  clock += 61_000;
  assert.equal((await supervisor.runCycle()).decisions[0].reason, "backoff", "the second wait is longer than the first");
  clock += 5 * 60_000;
  assert.equal((await supervisor.runCycle()).resumed, 1);
  assert.equal(launches.length, 3);
});

test("backoff resets once a Main proves it can start", async (t) => {
  const { root, taskId } = await workspace(t);
  await queueCallback(root, taskId);

  const launches = [];
  let clock = Date.now();
  const supervisor = new MainSupervisor({ workspaceRoot: root, launch: (input) => { launches.push(input); }, nowMs: () => clock });
  await supervisor.runCycle();
  assert.equal((await supervisor.runCycle()).decisions[0].reason, "backoff");

  // A live heartbeat means a Main got far enough to run, so the next failure
  // is a new problem rather than a continuation of a crash loop.
  await writeHeartbeat(root, taskId, RUN);
  assert.equal((await supervisor.runCycle()).decisions[0].reason, "main_alive");

  const { rm: removeFile } = await import("node:fs/promises");
  await removeFile(join(root, taskId, "agents", "main", "heartbeat.json"));
  assert.equal((await supervisor.runCycle()).resumed, 1, "a fresh crash starts from an immediate attempt again");
  assert.equal(launches.length, 2);
});

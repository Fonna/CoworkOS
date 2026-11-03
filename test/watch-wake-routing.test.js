import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { writeSleep } from "../dist/src/runtime/main-sleep.js";

/**
 * A wake is only a wake if the reader finds it. These tests pin the two halves
 * together: what the watch supervisor writes, what Main and its supervisor read.
 */

const TASK = "routing-task";
const MAIN_RUN = `main-${TASK}`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-wake-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "follow a topic" });
  // The Main Run the extension would use, parked in `waiting` as a Main that
  // ended its turn with monitors still registered would be.
  await store.createRun(TASK, MAIN_RUN);
  await store.transitionTask(TASK, "waiting", { runId: MAIN_RUN, reason: "parked_for_wake" });
  return { root, store };
}

function relevantChange(monitorId) {
  return {
    pollerFactory: () => ({ watcherId: monitorId, poll: async () => [{ watcherId: monitorId, source: "fixture", type: "fixture.changed", dedupeKey: "fixture-1", payload: { title: "Important change" } }] }),
    executor: async () => ({ status: "succeeded", response: "classification: relevant_change\nEvidence: fixture", artifacts: [] })
  };
}

test("a wake from a program created without watchRunId reaches the Run Main reads", async (t) => {
  const { root, store } = await workspace(t);
  const programs = new WatchProgramStore(root);
  // Exactly what `watch create` produces: no watchRunId at all.
  const program = await programs.createProgram({ taskId: TASK, programId: "topic", subject: "Topic", objective: "find changes" });
  const monitor = await programs.createVirtualAgent({ programId: program.programId, task: "classify", cadenceSeconds: 60, wake: "important", activate: true });
  const supervisor = new WatchSupervisor({ workspaceRoot: root, baseUrl: "http://model.test", apiKey: "k", ...relevantChange(monitor.monitorId) });

  const cycle = await supervisor.runCycle({ taskId: TASK });
  assert.equal(cycle.wakeRequests, 1);

  const mainInbox = new InboxStore(join(root, TASK, "runs", MAIN_RUN, "agents", "main", "inbox-store.json"));
  assert.equal((await mainInbox.list("main")).length, 1, "wake lands where Main listens");
  const watcherInbox = new InboxStore(join(root, TASK, "runs", `watch-${program.programId}`, "agents", "main", "inbox-store.json"));
  assert.equal((await watcherInbox.list("main")).length, 0, "and not in the watcher's own Run");

  // The watcher Run was created for filing events, but it is not Main's Run.
  assert.equal((await store.readTask(TASK)).activeRunId, MAIN_RUN);
});

test("the Main supervisor can act on that wake: the two halves meet", async (t) => {
  const { root } = await workspace(t);
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({ taskId: TASK, programId: "topic", subject: "Topic", objective: "find changes" });
  const monitor = await programs.createVirtualAgent({ programId: program.programId, task: "classify", cadenceSeconds: 60, wake: "important", activate: true });
  await new WatchSupervisor({ workspaceRoot: root, baseUrl: "http://model.test", apiKey: "k", ...relevantChange(monitor.monitorId) }).runCycle({ taskId: TASK });

  const launches = [];
  const main = new MainSupervisor({ workspaceRoot: root, launch: (input) => { launches.push(input); } });
  const result = await main.runCycle({ taskId: TASK });
  assert.equal(result.resumed, 1);
  assert.deepEqual(launches, [{ taskId: TASK, runId: MAIN_RUN }]);
});

test("a parked Main's own runId wins over every other guess", async (t) => {
  const { root, store } = await workspace(t);
  // A Task whose activeRunId points somewhere stale; the park says where Main
  // really is, and that is the only source true by construction.
  await store.updateTask(TASK, { activeRunId: "stale-run" });
  await writeSleep(root, TASK, { runId: MAIN_RUN, reason: "waiting on monitors", monitorIds: [], parkedAt: new Date().toISOString() });
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({ taskId: TASK, programId: "topic", subject: "Topic", objective: "find changes" });
  const monitor = await programs.createVirtualAgent({ programId: program.programId, task: "classify", cadenceSeconds: 60, wake: "important", activate: true });
  await new WatchSupervisor({ workspaceRoot: root, baseUrl: "http://model.test", apiKey: "k", ...relevantChange(monitor.monitorId) }).runCycle({ taskId: TASK });

  const parkedInbox = new InboxStore(join(root, TASK, "runs", MAIN_RUN, "agents", "main", "inbox-store.json"));
  assert.equal((await parkedInbox.list("main")).length, 1);
  const staleInbox = new InboxStore(join(root, TASK, "runs", "stale-run", "agents", "main", "inbox-store.json"));
  assert.equal((await staleInbox.list("main")).length, 0);
});

test("a monitor with a profile but no rule fails loudly instead of reporting quiet", async (t) => {
  const { root } = await workspace(t);
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({ taskId: TASK, programId: "topic", subject: "Topic", objective: "find changes" });
  // rss-news has no built-in adapter and this monitor has written no rule.
  const monitor = await programs.createVirtualAgent({ programId: program.programId, task: "watch a feed", profileId: "rss-news", cadenceSeconds: 60, wake: "important", activate: true });
  const supervisor = new WatchSupervisor({ workspaceRoot: root, baseUrl: "http://model.test", apiKey: "k", executor: async () => { throw new Error("must not run"); } });

  const cycle = await supervisor.runCycle({ taskId: TASK });
  assert.equal(cycle.failures.length, 1);
  assert.equal(cycle.failures[0].stage, "poll");
  assert.match(cycle.failures[0].error, /no watcher\/rule\.mjs/);
  const state = await programs.readVirtualAgentState(TASK, program.programId, monitor.monitorId);
  assert.equal(state.status, "failed");
  assert.equal(state.consecutiveFailures, 1);
});

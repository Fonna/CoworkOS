import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";

/**
 * A timer has no source to observe, so a Virtual Agent run would spend a model
 * call to report that time passed. These tests pin that cost property.
 */

const TASK = "timer-task";
const RUN = `main-${TASK}`;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-timer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "review on a cadence" });
  await store.createRun(TASK, RUN);
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({ taskId: TASK, programId: "review", subject: "Topic", objective: "periodic review" });
  const monitor = await programs.createVirtualAgent({ programId: program.programId, task: "weekly quality review", profileId: "timer", cadenceSeconds: 60, wake: "important", activate: true });
  return { root, programs, program, monitor };
}

test("a due timer wakes Main without running a model, and respects cadence", async (t) => {
  const { root, programs, program, monitor } = await workspace(t);
  let executorCalls = 0;
  const supervisor = new WatchSupervisor({
    workspaceRoot: root, baseUrl: "http://model.test", apiKey: "k",
    executor: async () => { executorCalls += 1; return { status: "succeeded", response: "classification: no_change", artifacts: [] }; }
  });

  const first = await supervisor.runCycle({ taskId: TASK });
  assert.equal(first.wakeRequests, 1);
  assert.equal(first.polled, 0, "a timer has no source to poll");
  assert.equal(executorCalls, 0, "and nothing for a model to classify");

  const inbox = new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json"));
  const messages = await inbox.list("main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "watch.virtual_agent_result");
  assert.equal(messages[0].payload.monitorId, monitor.monitorId);

  const second = await supervisor.runCycle({ taskId: TASK });
  assert.equal(second.wakeRequests, 0, "cadence prevents an immediate second wake");
  assert.equal(executorCalls, 0);

  const state = await programs.readVirtualAgentState(TASK, program.programId, monitor.monitorId);
  assert.ok(state.lastWakeAt);
  assert.ok(Date.parse(state.nextCheckAt) > Date.now());
});

test("the timer profile is a registered, reusable built-in", async (t) => {
  const { programs } = await workspace(t);
  assert.equal(programs.profile("timer")?.kind, "timer");
  assert.equal(programs.profile("timer")?.reusable, true);
});

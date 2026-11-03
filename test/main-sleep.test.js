import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { assessTaskCompletion } from "../dist/src/runtime/task-completion.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { GoalSupervisor } from "../dist/src/runtime/goal-supervisor.js";

/**
 * Sleeping and finishing look the same from outside: no work is queued either
 * way. These tests pin what tells them apart — a record Main writes on purpose
 * — and that nothing else about completion changed.
 */

const extensionPath = resolve(".pi/extensions/cowork.ts");
const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const TASK = "sleep-task";
const RUN = `main-${TASK}`;

function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  return {
    tools,
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerProvider() {},
    registerCommand() {},
    getActiveTools() {
      return [...tools.keys()];
    },
    setActiveTools() {},
    sendMessage: async () => {}
  };
}

async function loadExtension() {
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const jiti = createJiti(pathToFileURL(extensionPath).href, { interopDefault: true });
  const module = await jiti.import(extensionPath, { default: true });
  return module.default ?? module;
}

const ctx = { ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [] } };

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-sleep-"));
  const previous = { ...process.env };
  // The tool's runtime-state write is fire-and-forget by design; let it land.
  t.after(async () => {
    process.env = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  process.env.COWORK_API_BASE = "https://example.test";
  process.env.COWORK_API_KEY = "test-key";
  process.env.COWORK_CONFIG = join(root, "config.json");
  await writeFile(process.env.COWORK_CONFIG, "{}\n");
  process.env.COWORK_WORKSPACE = root;
  process.env.COWORK_TASK_ID = TASK;
  process.env.COWORK_RUN_ID = RUN;
  const store = new LocalWorkspaceStore(root);
  await store.createTask(TASK, { goal: "keep watch" });
  await store.createRun(TASK, RUN);
  const pi = fakePi();
  (await loadExtension())(pi);
  return { root, store, pi };
}

/** Drive the lifecycle the way Pi does after a final answer. */
async function settle(pi) {
  await pi.handlers.get("agent_end")(
    {
      messages: [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done for now." }] }
      ]
    },
    ctx
  );
  await pi.handlers.get("agent_settled")({}, ctx);
}

async function activeMonitor(root) {
  const programs = new WatchProgramStore(root);
  const program = await programs.createProgram({
    taskId: TASK,
    programId: "topic",
    subject: "Topic",
    objective: "find changes"
  });
  return programs.createVirtualAgent({
    programId: program.programId,
    task: "classify",
    cadenceSeconds: 60,
    wake: "important",
    activate: true
  });
}

test("the completion gate treats a park as outstanding work, and only a park", () => {
  assert.deepEqual(assessTaskCompletion({ parkedForWake: true, hasFinalAnswer: true }), {
    ready: false,
    reason: "parked_for_wake"
  });
  assert.deepEqual(assessTaskCompletion({ parkedForWake: false, hasFinalAnswer: true }), {
    ready: true,
    reason: "ready"
  });
  // Real outstanding work still comes first: a parked Task with a blocked
  // Subagent is reported as blocked, since that needs a different action.
  assert.equal(
    assessTaskCompletion({ parkedForWake: true, pendingSubagentQuestions: 1 }).reason,
    "pending_subagent_questions"
  );
});

test("sleep_until refuses a park nothing could wake", async (t) => {
  const { root, pi } = await harness(t);
  const result = await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "nothing to do" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.reason, "no_wake_condition");
  assert.equal(await readSleep(root, TASK), undefined);
});

test("sleep_until with an interval records a wake time and ends the turn", async (t) => {
  const { root, pi } = await harness(t);
  const before = Date.now();
  const result = await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "refresh the report", wakeInSeconds: 10 }, undefined, undefined, ctx);
  assert.equal(result.terminate, true);
  const parked = await readSleep(root, TASK);
  assert.equal(parked.runId, RUN);
  assert.equal(parked.reason, "refresh the report");
  // Below the floor is raised to it; the supervisor could not act sooner anyway.
  assert.ok(Date.parse(parked.wakeAt) >= before + 60_000);
});

test("parking a managed source does not turn its sampling cadence into a model wake clock", async (t) => {
  const { root, pi } = await harness(t);
  const manager = new GoalManagement(root);
  const goal = await manager.create(TASK, {
    brief: { title: "source", objective: "wait for meaningful source changes" },
    scope: "session",
    requestId: "clock-test"
  });
  const monitor = await new WatchProgramStore(root).createVirtualAgent({
    programId: goal.programId,
    task: "sample without model calls",
    cadenceSeconds: 60,
    wake: "important",
    activate: true
  });
  const result = await pi.tools.get("sleep_until").execute(
    "park",
    {
      reason: "wait for the next sample",
      programId: goal.programId,
      monitorIds: [monitor.monitorId],
      wakeInSeconds: 60
    },
    undefined,
    undefined,
    ctx
  );
  assert.equal(result.details.parked, true);
  assert.equal(result.details.taskClockIgnored, true);
  assert.equal((await readSleep(root, TASK)).wakeAt, undefined);
  assert.deepEqual((await readSleep(root, TASK)).monitorIds, [monitor.monitorId]);
});

test("a background goal cannot arm a Task polling clock even without programId", async (t) => {
  const { root, store, pi } = await harness(t);
  const goal = await new GoalManagement(root).create(TASK, {
    brief: { title: "source", objective: "wait for meaningful source changes" },
    scope: "session",
    requestId: "background-clock"
  });
  await store.updateTask(TASK, { monitoring: { scope: "background" } });
  const monitor = await new WatchProgramStore(root).createVirtualAgent({
    programId: goal.programId,
    task: "sample without model calls",
    cadenceSeconds: 60,
    wake: "important",
    activate: true
  });
  const result = await pi.tools
    .get("sleep_until")
    .execute("park", { reason: "Wait for a source change", wakeInSeconds: 60 }, undefined, undefined, ctx);
  assert.equal(result.details.parked, true);
  assert.equal(result.details.taskClockIgnored, true);
  assert.equal((await readSleep(root, TASK)).wakeAt, undefined);
  assert.deepEqual((await readSleep(root, TASK)).monitorIds, [monitor.monitorId]);
});

test("an independent session clock survives unrelated goal sources and reaches Main", async (t) => {
  const { root, pi } = await harness(t);
  const manager = new GoalManagement(root);
  const goal = await manager.create(TASK, {
    brief: { title: "weather", objective: "wait for meaningful weather changes" },
    scope: "session",
    requestId: "weather-clock"
  });
  await new WatchProgramStore(root).createVirtualAgent({
    programId: goal.programId,
    task: "sample weather",
    cadenceSeconds: 60,
    wake: "important",
    activate: true
  });
  await manager.progress(TASK, goal.programId, goal.goal.revision, {
    summary: "The weather source is ready",
    disposition: "wait",
    waitingFor: "A meaningful weather change"
  });
  const result = await pi.tools
    .get("sleep_until")
    .execute(
      "meeting-reminder",
      { reason: "Remind the user about a meeting; unrelated to weather", wakeInSeconds: 3600 },
      undefined,
      undefined,
      ctx
    );
  assert.equal(result.details.parked, true);
  assert.equal(result.details.taskClockIgnored, undefined);
  const parked = await readSleep(root, TASK);
  assert.ok(parked.wakeAt, "an unrelated goal must not remove the requested clock");
  assert.deepEqual(parked.monitorIds, [], "an independent timer does not depend on unrelated sources");
  const current = await manager.get(TASK, goal.programId);
  await manager.control(TASK, goal.programId, "pause", current.goal.revision);
  await settle(pi);
  await writeSleep(root, TASK, { ...parked, wakeAt: new Date(Date.now() - 1_000).toISOString() });
  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "http://model.test",
    apiKey: "k",
    executor: async () => {
      throw new Error("a deterministic clock does not run an analysis model");
    }
  });
  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 1);
  let launches = 0;
  assert.equal(
    (
      await new MainSupervisor({
        workspaceRoot: root,
        launch: () => {
          launches++;
        }
      }).runCycle({ taskId: TASK })
    ).resumed,
    1
  );
  assert.equal(launches, 1);
  const delivered = [];
  await new MainInboxDelivery(root, TASK, RUN).deliver((message) => delivered.push(message));
  assert.equal(delivered.length, 1);
  assert.equal(await readSleep(root, TASK), undefined);
});

test("an explicitly parked session goal wakes through its review rather than a Task clock", async (t) => {
  const { root, pi } = await harness(t);
  const manager = new GoalManagement(root);
  const goal = await manager.create(TASK, {
    brief: { title: "review", objective: "review recorded results later" },
    scope: "session",
    requestId: "explicit-clock"
  });
  await manager.progress(TASK, goal.programId, goal.goal.revision, {
    summary: "Review the results after waiting",
    disposition: "wait",
    waitingFor: "The next goal review",
    nextReviewAt: new Date(Date.now() + 120_000).toISOString()
  });
  const result = await pi.tools
    .get("sleep_until")
    .execute(
      "goal-review",
      { reason: "Wait for the goal review", programId: goal.programId, wakeInSeconds: 60 },
      undefined,
      undefined,
      ctx
    );
  assert.equal(result.details.parked, true);
  assert.equal(result.details.taskClockIgnored, true);
  assert.equal((await readSleep(root, TASK)).wakeAt, undefined);
  await manager.store.withGoal(TASK, goal.programId, (program) =>
    manager.store.save(program, {
      ...program.goal,
      nextReviewAt: new Date(Date.now() - 1_000).toISOString()
    })
  );
  await new GoalSupervisor(root).runTask(TASK, RUN);
  const inbox = new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json"));
  assert.deepEqual(
    (await inbox.list("main")).map((message) => message.payload.type),
    ["watch.goal_review"]
  );
  const delivered = [];
  await new MainInboxDelivery(root, TASK, RUN).deliver((message) => delivered.push(message));
  assert.equal(delivered.length, 1);
  assert.equal(await readSleep(root, TASK), undefined);
});

test("sleep_until rejects unknown goals and monitor lists belonging to a different program", async (t) => {
  const { root, pi } = await harness(t);
  const unrelated = await activeMonitor(root);
  const manager = new GoalManagement(root);
  const goal = await manager.create(TASK, {
    brief: { title: "source", objective: "wait for meaningful changes" },
    scope: "session",
    requestId: "invalid-clock"
  });
  const tool = pi.tools.get("sleep_until");
  for (const programId of ["missing", "topic"]) {
    const result = await tool.execute(
      "invalid-goal",
      { reason: "unrelated work", programId, wakeInSeconds: 60 },
      undefined,
      undefined,
      ctx
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.reason, "invalid_goal");
  }
  const result = await tool.execute(
    "mismatched-monitor",
    {
      reason: "unrelated work",
      programId: goal.programId,
      monitorIds: [unrelated.monitorId],
      wakeInSeconds: 60
    },
    undefined,
    undefined,
    ctx
  );
  assert.equal(result.isError, true);
  assert.equal(result.details.reason, "inactive_monitor");
  await manager.control(TASK, goal.programId, "pause", goal.goal.revision);
  const paused = await tool.execute(
    "paused-goal",
    { reason: "Wait for the paused goal", programId: goal.programId, wakeInSeconds: 60 },
    undefined,
    undefined,
    ctx
  );
  assert.equal(paused.isError, true);
  assert.equal(paused.details.reason, "inactive_goal");
  assert.equal(await readSleep(root, TASK), undefined);
});

test("sleep_until with an active monitor and no interval is an event-only park", async (t) => {
  const { root, pi } = await harness(t);
  const monitor = await activeMonitor(root);
  const result = await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "wait for a relevant change" }, undefined, undefined, ctx);
  assert.equal(result.details.parked, true);
  const parked = await readSleep(root, TASK);
  assert.equal(parked.wakeAt, undefined);
  assert.deepEqual(parked.monitorIds, [monitor.monitorId]);
});

test("a parked Main settles to waiting; an unparked Main still completes", async (t) => {
  const { root, store, pi } = await harness(t);
  // The regression guard: ordinary work is unaffected by the sleep machinery.
  await settle(pi);
  assert.equal((await store.readTask(TASK)).status, "completed");

  await store.transitionTask(TASK, "running", { runId: RUN });
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "come back later", wakeInSeconds: 60 }, undefined, undefined, ctx);
  await settle(pi);
  const task = await store.readTask(TASK);
  assert.equal(task.status, "waiting");
  assert.ok(await readSleep(root, TASK), "the park survives the settle");
});

test("a background goal parks after a normal final answer even without sleep_until", async (t) => {
  const { root, store, pi } = await harness(t);
  const monitor = await activeMonitor(root);
  await store.updateTask(TASK, { monitoring: { scope: "background" } });
  await settle(pi);
  assert.equal((await store.readTask(TASK)).status, "waiting");
  assert.deepEqual((await readSleep(root, TASK)).monitorIds, [monitor.monitorId]);
  assert.equal((await readSleep(root, TASK)).wakeAt, undefined);
});

test("a due park is woken once, delivered to Main, and cleared on delivery", async (t) => {
  const { root, store, pi } = await harness(t);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "refresh", wakeInSeconds: 60 }, undefined, undefined, ctx);
  await settle(pi);
  // Move the clock: rewrite the park as already due.
  const parked = await readSleep(root, TASK);
  await writeSleep(root, TASK, { ...parked, wakeAt: new Date(Date.now() - 1_000).toISOString() });

  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "http://model.test",
    apiKey: "k",
    executor: async () => {
      throw new Error("no model run for a clock");
    }
  });
  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 1);
  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 0, "a second cycle does not re-fire");
  const inbox = new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json"));
  const messages = await inbox.list("main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "main.scheduled_wake");

  // With no live Main, the supervisor is what starts one.
  const launches = [];
  assert.equal(
    (
      await new MainSupervisor({
        workspaceRoot: root,
        launch: (input) => {
          launches.push(input);
        }
      }).runCycle({ taskId: TASK })
    ).resumed,
    1
  );
  assert.equal(launches[0].runId, RUN);

  // Delivery is what ends the park: Main is awake once it reads the message.
  const delivered = [];
  await new MainInboxDelivery(root, TASK, RUN).deliver(async (message) => {
    delivered.push(message);
    await store.transitionTask(TASK, "running", { runId: RUN, reason: "main_turn_started" });
  });
  assert.equal(delivered.length, 1);
  assert.equal(await readSleep(root, TASK), undefined);
  assert.equal((await store.readTask(TASK)).status, "running");
});

test("an event-only park whose monitors all went away tells Main rather than hanging", async (t) => {
  const { root, pi } = await harness(t);
  const monitor = await activeMonitor(root);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "wait for a relevant change" }, undefined, undefined, ctx);
  await settle(pi);

  const supervisor = new WatchSupervisor({
    workspaceRoot: root,
    baseUrl: "http://model.test",
    apiKey: "k",
    executor: async () => {
      throw new Error("no model run");
    }
  });
  // While Main sleeps nothing is lost yet, so nothing is reported.
  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 0);

  // The park-time guard proved a wake condition existed then, not that it
  // still does: retiring the last monitor removes it. A user pause is intentional.
  const programs = new WatchProgramStore(root);
  const { program } = await programs.findVirtualAgent(TASK, monitor.monitorId);
  await programs.updateVirtualAgent(TASK, program.programId, monitor.monitorId, { status: "retired" });

  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 1);
  const messages = await new InboxStore(
    join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json")
  ).list("main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.type, "main.monitors_lost");
  // Once queued the standing park does not fire a second wake.
  assert.equal((await supervisor.runCycle({ taskId: TASK })).parkWakes, 0);
  assert.equal(
    (await new InboxStore(join(root, TASK, "runs", RUN, "agents", "main", "inbox-store.json")).list("main"))
      .length,
    1
  );
});

test("finish_task supersedes a park and says so", async (t) => {
  const { root, store, pi } = await harness(t);
  await pi.tools
    .get("sleep_until")
    .execute("call-1", { reason: "come back later", wakeInSeconds: 60 }, undefined, undefined, ctx);
  const result = await pi.tools.get("finish_task").execute("call-2", { summary: "objective reached" });
  assert.equal(result.details.completed, true);
  assert.equal(result.details.supersededPark, "come back later");
  assert.equal(await readSleep(root, TASK), undefined);
  assert.equal((await store.readTask(TASK)).status, "completed");
});

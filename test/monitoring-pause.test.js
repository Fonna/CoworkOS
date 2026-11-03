import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { MainSupervisor } from "../dist/src/runtime/main-supervisor.js";
import { MainInboxDelivery } from "../dist/src/runtime/main-inbox-delivery.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { WatchSupervisor } from "../dist/src/runtime/watch-supervisor.js";
import { readSleep, writeSleep } from "../dist/src/runtime/main-sleep.js";
import { monitoringPrograms } from "../dist/src/runtime/monitoring-control.js";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "./dashboard-fixture.mjs";

async function fixture(t, scope = "background") {
  const root = await mkdtemp(join(tmpdir(), "atria-pause-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("task", { goal: "watch" });
  await workspace.createRun("task", "main-task");
  await workspace.updateTask("task", { monitoring: { scope }, activeRunId: "main-task" });
  await workspace.transitionTask("task", "waiting", { runId: "main-task" });
  const management = new WatchManagement(root, resolve("."));
  const input = {
    template: "timer",
    task: "wait",
    cadenceSeconds: 60,
    config: { startAt: new Date(Date.now() + 3600000).toISOString(), intervalMs: 60000 }
  };
  const created = await management.create("task", "main-task", input);
  assert.equal(created.activated, true, JSON.stringify(created));
  const inbox = new InboxStore(join(root, "task/runs/main-task/agents/main/inbox-store.json"));
  const queue = (id, payload, kind = "external_event") =>
    inbox.enqueue({
      messageId: id,
      recipientAgentId: "main",
      kind,
      eventId: id,
      priority: 1,
      state: "ready",
      createdAt: new Date().toISOString(),
      payload
    });
  return { root, workspace, management, created, input, inbox, queue };
}

test("a paused legacy background task holds every automatic wake across restarts, then explicitly resumes", async (t) => {
  const f = await fixture(t);
  // Reproduce old persisted data: only the source was paused, not its program.
  await f.management.store.updateVirtualAgent("task", f.created.programId, f.created.monitorId, {
    status: "paused"
  });
  await writeSleep(f.root, "task", {
    runId: "main-task",
    reason: "old timed review",
    monitorIds: [],
    parkedAt: "2026-01-01T00:00:00Z",
    wakeAt: "2026-01-01T00:01:00Z"
  });
  for (const [id, payload, kind] of [
    ["clock", { type: "main.scheduled_wake" }],
    ["lost", { type: "main.monitors_lost" }],
    ["retry", { type: "watch.main_retry" }],
    ["callback", { response: "old work finished" }, "callback"],
    ["answer", { type: "human.answer", requestId: "old-question" }]
  ])
    await f.queue(id, payload, kind);
  let launches = 0;
  for (let restart = 0; restart < 2; restart++) {
    const main = new MainSupervisor({
      workspaceRoot: f.root,
      launch: () => {
        launches++;
      }
    });
    assert.equal((await main.runCycle()).decisions[0].reason, "monitoring_paused");
    let delivered = 0;
    await new MainInboxDelivery(f.root, "task", "main-task").deliver(() => {
      delivered++;
    });
    assert.equal(delivered, 0);
    const cycle = await new WatchSupervisor({ workspaceRoot: f.root, baseUrl: "", apiKey: "" }).runCycle();
    assert.equal(cycle.parkWakes, 0);
    assert.equal(cycle.polled, 0);
    assert.equal((await readSleep(f.root, "task")).wakeFiredAt, undefined);
  }
  assert.equal(launches, 0);
  assert.ok((await f.inbox.list("main")).every((entry) => entry.state === "ready"));
  await f.management.control("task", f.created.monitorId, "resume");
  assert.equal(
    (
      await new MainSupervisor({
        workspaceRoot: f.root,
        launch: () => {
          launches++;
        }
      }).runCycle()
    ).resumed,
    1
  );
  assert.equal(launches, 1);
  assert.equal(
    (await new WatchSupervisor({ workspaceRoot: f.root, baseUrl: "", apiKey: "" }).runCycle()).parkWakes,
    1
  );
});

test("pause is enforced by registration, including changed configs and attempts to escape into another task", async (t) => {
  const f = await fixture(t);
  await f.management.control("task", f.created.monitorId, "pause");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "paused");
  const tasks = (await f.workspace.listTasks()).length;
  for (const input of [
    f.input,
    { ...f.input, programId: f.created.programId },
    { ...f.input, scope: "background", task: "rebuild paused observer", config: { intervalMs: 120000 } }
  ])
    await assert.rejects(
      new WatchManagement(f.root, resolve(".")).create("task", "main-task", input),
      /暂停/
    );
  await assert.rejects(
    f.management.activate("task", "main-task", { path: "new-package", task: "rebuild", cadenceSeconds: 60 }),
    /暂停/
  );
  assert.equal((await f.workspace.listTasks()).length, tasks);
  assert.equal((await f.management.store.listVirtualAgents("task", f.created.programId)).length, 1);
  await f.management.control("task", f.created.monitorId, "resume");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "monitoring");
  const repeated = await f.management.create("task", "main-task", f.input);
  assert.equal(repeated.monitorId, f.created.monitorId);
  assert.equal(repeated.alreadyActive, true);
});

test("session source pause holds its timer but permits ordinary callbacks and user messages", async (t) => {
  const f = await fixture(t, "session");
  await f.management.control("task", f.created.monitorId, "pause");
  await f.queue("monitor-clock", { type: "main.scheduled_wake", monitorIds: [f.created.monitorId] });
  await f.queue("unrelated-clock", { type: "main.scheduled_wake", monitorIds: [] });
  await f.queue("work", { response: "training finished" }, "callback");
  await f.queue("user", { type: "user.request" }, "human_command");
  let delivered = 0;
  await new MainInboxDelivery(f.root, "task", "main-task").deliver(() => {
    delivered++;
  });
  assert.equal(delivered, 3);
  assert.equal(
    (await f.inbox.list("main")).find((entry) => entry.messageId === "monitor-clock").state,
    "ready"
  );
  assert.equal((await monitoringPrograms(f.root, "task"))[0].status, "paused");
});

test("pausing one source cannot be bypassed by repeating its creation while another source remains active", async (t) => {
  const f = await fixture(t);
  const other = await f.management.create("task", "main-task", {
    ...f.input,
    programId: f.created.programId,
    task: "other source",
    config: { ...f.input.config, intervalMs: 120000 }
  });
  assert.equal(other.activated, true, JSON.stringify(other));
  await f.management.control("task", f.created.monitorId, "pause");
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "monitoring");
  await assert.rejects(f.management.create("task", "main-task", f.input), /暂停/);
  const original = (await f.management.store.findVirtualAgent("task", f.created.monitorId)).monitor;
  await assert.rejects(
    f.management.activate("task", "main-task", {
      path: original.config.packagePath,
      cadenceSeconds: 60,
      task: "re-activate paused package"
    }),
    /暂停/
  );
  assert.equal((await f.management.store.findVirtualAgent("task", other.monitorId)).monitor.status, "active");
});

test("model guidance and question timeouts cannot resume a paused monitor or create another goal", async (t) => {
  const f = await fixture(t);
  const tools = new Map();
  const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = await import(requirePi.resolve("jiti"));
  const context = {
    taskId: "task",
    mainRunId: "main-task",
    workspaceRoot: f.root,
    harnessRoot: resolve("."),
    watchStore: f.management.store,
    humanStore: new HumanRequestStore(f.root),
    inboxDelivery: new MainInboxDelivery(f.root, "task", "main-task"),
    runtimeEnv: { COWORK_HUMAN_ANSWER_TIMEOUT_MS: "0" },
    updateRuntime() {}
  };
  for (const [file, register] of [
    ["coordination", "registerCoordinationTools"],
    ["goals", "registerGoalTools"]
  ]) {
    const path = resolve(`.pi/runtime/tools/${file}.ts`);
    const module = await createJiti(pathToFileURL(path).href, { interopDefault: true }).import(path);
    module[register](
      {
        registerTool(tool) {
          tools.set(tool.name, tool);
        }
      },
      context
    );
  }
  const cancelled = await tools.get("cancel_subagent").execute("cancel", { callId: f.created.monitorId });
  assert.equal(cancelled.details.status, "paused");
  const unanswered = await tools.get("askhuman").execute(
    "ask",
    {
      question: "恢复已暂停的监控？",
      options: ["恢复", "保持暂停"],
      recommended: 0
    },
    undefined,
    undefined,
    { ui: { notify() {} } }
  );
  assert.equal(unanswered.details.status, "timeout");
  assert.equal(unanswered.details.recommendedOption, "恢复");
  await assert.rejects(
    f.management.create("task", "main-task", {
      ...f.input,
      programId: f.created.programId,
      task: "rebuild after timeout"
    }),
    /暂停/
  );
  const guided = await tools.get("send_subagent_message").execute("guide", {
    callId: f.created.monitorId,
    message: "Try rebuilding after the old question timed out"
  });
  assert.equal(guided.details.status, "paused");
  assert.equal(
    (await f.management.store.listControls("task", f.created.programId, f.created.monitorId)).length,
    1
  );
  const brief = { title: "replacement", objective: "try moving the paused work" };
  for (const action of ["create", "resume", "edit", "steer"])
    await assert.rejects(
      tools.get("manage_goal").execute("goal", {
        action,
        programId: f.created.programId,
        revision: 1,
        brief
      }),
      /暂停/
    );
  await assert.rejects(
    new GoalManagement(f.root).create("task", {
      brief,
      requestId: "escape",
      scope: "background"
    }),
    /暂停/
  );
  assert.equal((await f.workspace.listTasks()).length, 1);
});

test("pause during a custom activation probe wins final acceptance for legacy programs too", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "task/artifacts/slow-package");
  await mkdir(join(directory, "watcher"), { recursive: true });
  await mkdir(join(directory, "tests"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      name: "slow",
      version: "1.0.0",
      entrypoint: "watcher/rule.mjs",
      handler: "AGENT.md",
      state: "watcher/state.json",
      sources: ["clock"],
      events: { dedupeKey: "fixture", wake: "important" }
    })
  );
  await writeFile(join(directory, "AGENT.md"), "Fixture observer.");
  await writeFile(
    join(directory, "watcher/rule.mjs"),
    "export default async () => {await new Promise(r=>setTimeout(r,500));return {events:[],state:{ok:true}}};"
  );
  const activating = f.management.activate("task", "main-task", {
    path: "artifacts/slow-package",
    task: "new source",
    cadenceSeconds: 60,
    programId: f.created.programId
  });
  let draft;
  for (let n = 0; n < 200; n++) {
    draft = (await f.management.store.listVirtualAgents("task", f.created.programId)).find(
      (m) => m.config?.packagePath === "artifacts/slow-package"
    );
    if (draft) break;
    await delay(10);
  }
  assert.ok(draft);
  await f.management.control("task", f.created.monitorId, "pause");
  const result = await activating;
  assert.equal(result.activated, false);
  assert.match(result.error, /暂停/);
  assert.ok(
    (await f.management.store.listVirtualAgents("task", f.created.programId)).every(
      (m) => m.status !== "active"
    )
  );
  assert.equal((await f.management.store.readProgram("task", f.created.programId)).status, "paused");
});

test("real Dashboard restarts keep legacy pauses quiet; HTTP resume releases retained work", async (t) => {
  const f = await fixture(t);
  await f.management.store.updateVirtualAgent("task", f.created.programId, f.created.monitorId, {
    status: "paused"
  });
  await writeSleep(f.root, "task", {
    runId: "main-task",
    reason: "old review",
    monitorIds: [],
    parkedAt: "2026-01-01T00:00:00Z",
    wakeAt: "2026-01-01T00:01:00Z"
  });
  await f.queue("old-clock", { type: "main.scheduled_wake" });
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (request.method !== "POST") {
      response.end(JSON.stringify({ data: [{ id: "pause-fixture" }] }));
      return;
    }
    modelCalls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = (value, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "pause", object: "chat.completion.chunk", model: "pause-fixture", created: 1, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`
      );
    delta({ role: "assistant", content: "Retained work handled. Continue waiting." });
    delta({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const modelEndpoint = `http://127.0.0.1:${model.address().port}/v1`;
  let dashboard;
  try {
    dashboard = await startDashboard({
      workspace: f.root,
      defaultProject: false,
      monitoring: true,
      modelEndpoint,
      model: "pause-fixture"
    });
    for (let restart = 0; restart < 2; restart++) {
      if (restart > 0) await dashboard.restart();
      const detail = `${dashboard.base}/api/tasks/task/monitors`;
      const initial = await (await fetch(detail)).json();
      for (let n = 0; n < 100; n++) {
        await delay(50);
        if ((await (await fetch(detail)).json()).scheduler.lastCycleAt !== initial.scheduler.lastCycleAt)
          break;
        if (n === 99) assert.fail("scheduler did not complete another cycle");
      }
      assert.equal(modelCalls, 0, "no provider calls while paused, even after host restart");
      assert.equal((await readSleep(f.root, "task")).wakeFiredAt, undefined);
      const goals = await (await fetch(`${dashboard.base}/api/goals`)).json();
      assert.equal(goals.goals.find((p) => p.programId === f.created.programId).status, "paused");
      const rejected = await fetch(detail, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f.input, task: "rebuild", programId: f.created.programId })
      });
      assert.equal(rejected.ok, false);
      assert.match(await rejected.text(), /暂停/);
    }
    const resumed = await fetch(`${dashboard.base}/api/tasks/task/monitors/${f.created.monitorId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resume" })
    });
    assert.equal(resumed.ok, true, await resumed.text());
    for (let n = 0; n < 200 && modelCalls === 0; n++) await delay(50);
    assert.ok(modelCalls > 0, "only explicit HTTP resume releases the queued wake to real Main");
  } finally {
    await dashboard?.stop();
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }
});

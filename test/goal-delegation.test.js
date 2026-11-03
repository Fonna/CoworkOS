import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { GoalManagement } from "../dist/src/runtime/goal-management.js";
import { WatchManagement } from "../dist/src/runtime/watch-management.js";
import { requireCollectorOwnership } from "../dist/src/runtime/goal-delegation.js";
import {
  goalDelegationRequestId,
  readGoalDelegationRequest,
  restoreGoalDelegationRequest,
  syncGoalDelegationRequest
} from "../dist/src/runtime/goal-delegation-request.js";
import { queuedUserTurn } from "../dist/src/runtime/queued-user-turn.js";
import { SUPERVISOR_WAKE_TURN } from "../dist/src/runtime/main-supervisor.js";

const user = (id, text, timestamp = 1) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }], timestamp }
});
const originalUser = user("first-user", "Register a training goal");
const laterUser = user("next-user", "Independent meeting reminder", 2);
const requestContext = (
  branch,
  messages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message)
) => ({
  sessionId: "session",
  branch,
  messages
});

async function fixture(t, scoped = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-goal-delegation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspaceStore(root);
  await workspace.createTask("chat", { goal: "registration conversation" });
  await workspace.createRun("chat", "main-chat");
  if (scoped) await syncGoalDelegationRequest(root, "chat", "main-chat", requestContext([originalUser]));
  const manager = new GoalManagement(root);
  const goal = await manager.create(
    "chat",
    {
      brief: { title: "training", objective: "follow training" },
      scope: "background",
      requestId: "register"
    },
    "main-chat"
  );
  const input = {
    template: "timer",
    task: "follow training",
    cadenceSeconds: 60,
    scope: "background",
    config: { startAt: new Date(Date.now() + 3600000).toISOString() }
  };
  return { root, workspace, manager, goal, input, watches: new WatchManagement(root, resolve(".")) };
}

test("a registration Run cannot create a replacement collector after handing a goal to its Main", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.watches.create("chat", "main-chat", { ...f.input, programId: f.goal.programId }),
    /交接/
  );
  await assert.rejects(f.watches.create("chat", "main-chat", f.input), /交接/);
  await assert.rejects(
    f.watches.activate("chat", "main-chat", { path: "unused", task: "replacement", cadenceSeconds: 60 }),
    /交接/
  );
  assert.equal((await f.workspace.listTasks()).length, 2);
  const created = await f.watches.create(f.goal.taskId, f.goal.watchRunId, {
    ...f.input,
    programId: f.goal.programId
  });
  assert.equal(created.activated, true);
  assert.equal(created.taskId, f.goal.taskId);
  assert.equal(created.programId, f.goal.programId);
});

for (const action of ["pause", "complete"])
  test(`handoff ownership survives restart and ${action} while a different user Run remains independent`, async (t) => {
    const f = await fixture(t);
    await f.manager.control(f.goal.taskId, f.goal.programId, action, f.goal.goal.revision);
    const restarted = new WatchManagement(f.root, resolve("."));
    await assert.rejects(
      restarted.create("chat", "main-chat", { ...f.input, task: "reworded replacement" }),
      /交接/
    );
    await f.workspace.createRun("chat", "next-user-run");
    const independent = await restarted.create("chat", "next-user-run", f.input);
    assert.equal(independent.activated, true);
  });

test("an explicit user creation can add an independent monitor without overriding delegated model ownership", async (t) => {
  const f = await fixture(t);
  const manual = await f.watches.create("chat", "main-chat", f.input, "user");
  assert.equal(manual.activated, true);
  await assert.rejects(f.watches.create("chat", "main-chat", f.input), /交接/);
});

for (const paused of [false, true])
  test(`a ${paused ? "rejected paused" : "successful"} cross-conversation steer prevents collector fallback`, async (t) => {
    const f = await fixture(t);
    await f.workspace.createTask("followup", { goal: "reuse existing goal" });
    await f.workspace.createRun("followup", "main-followup");
    if (paused) await f.manager.control(f.goal.taskId, f.goal.programId, "pause", f.goal.goal.revision);
    const current = await f.manager.get(f.goal.taskId, f.goal.programId);
    const steer = () =>
      f.manager.steer(current.taskId, current.programId, current.goal.revision, {
        sourceTaskId: "followup",
        sourceRunId: "main-followup",
        requestId: "reuse",
        message: "reuse the original Main"
      });
    if (paused) await assert.rejects(steer, /暂停/);
    else await steer();
    await assert.rejects(
      new WatchManagement(f.root, resolve(".")).create("followup", "main-followup", f.input),
      /交接/
    );
    assert.equal((await f.workspace.listTasks()).length, 3);
  });

test("a stale handoff revision cannot reopen collector fallback after another client pauses the goal", async (t) => {
  const f = await fixture(t);
  await f.workspace.createTask("followup", { goal: "reuse existing goal" });
  await f.workspace.createRun("followup", "main-followup");
  await f.manager.control(f.goal.taskId, f.goal.programId, "pause", f.goal.goal.revision);
  await assert.rejects(
    f.manager.steer(f.goal.taskId, f.goal.programId, f.goal.goal.revision, {
      sourceTaskId: "followup",
      sourceRunId: "main-followup",
      requestId: "stale",
      message: "reuse"
    }),
    /目标已更新/
  );
  await assert.rejects(f.watches.create("followup", "main-followup", f.input), /交接/);
});

test("only delivered fresh user input releases a prior request's collector restriction", async (t) => {
  const f = await fixture(t, true);
  await f.manager.control(f.goal.taskId, f.goal.programId, "complete", f.goal.goal.revision);
  const backgroundEntries = [
    originalUser,
    { type: "compaction", id: "compact", summary: "Preserved the standing goal" },
    { type: "custom_message", id: "watch", customType: "cowork-watch-event", content: "New source event" },
    { type: "custom_message", id: "answer", customType: "cowork-human-answer", content: "An answer" },
    user("wake", SUPERVISOR_WAKE_TURN)
  ];
  for (const context of [
    requestContext([]),
    requestContext(backgroundEntries),
    requestContext([...backgroundEntries, laterUser], [originalUser.message])
  ]) {
    await syncGoalDelegationRequest(f.root, "chat", "main-chat", context);
    await assert.rejects(
      new WatchManagement(f.root, resolve(".")).create("chat", "main-chat", f.input),
      /交接/
    );
  }
  await syncGoalDelegationRequest(
    f.root,
    "chat",
    "main-chat",
    requestContext([...backgroundEntries, laterUser])
  );
  const independent = await f.watches.create("chat", "main-chat", f.input);
  assert.equal(independent.activated, true);
});

test("legacy receipts stay attached to their recovered request while fresh input is independent", async (t) => {
  const f = await fixture(t);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", {
    ...requestContext([originalUser]),
    initializeOnly: true
  });
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser, laterUser]));
  await requireCollectorOwnership(f.root, "chat", "main-chat");
  const current = await readGoalDelegationRequest(f.root, "chat", "main-chat");
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", {
    ...requestContext([originalUser]),
    initializeOnly: true
  });
  assert.deepEqual(await readGoalDelegationRequest(f.root, "chat", "main-chat"), current);
});

test("delegating the same goal in a newer request retains the original request's receipt", async (t) => {
  const f = await fixture(t, true);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser, laterUser]));
  await f.manager.steer(f.goal.taskId, f.goal.programId, f.goal.goal.revision, {
    sourceTaskId: "chat",
    sourceRunId: "main-chat",
    requestId: "later-handoff",
    message: "Continue the existing goal"
  });
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser]));
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
});

test("restored composer inputs and delivered user Inbox messages retain durable identities", () => {
  const mainInput = {
    version: 1,
    prompt: "Independent meeting reminder",
    submittedAt: 2,
    messageId: "accepted-user",
    source: "composer"
  };
  const context = { taskId: "chat", runId: "main-chat", sessionId: "session", mainInput };
  const original = goalDelegationRequestId({ ...context, branch: [laterUser] });
  const restored = user(
    "restored-entry",
    queuedUserTurn({
      taskId: "chat",
      runId: "main-chat",
      messageId: "accepted-user",
      text: mainInput.prompt
    }),
    2
  );
  assert.equal(goalDelegationRequestId({ ...context, branch: [restored] }), original);
  const inbox = {
    type: "custom_message",
    id: "delivered",
    customType: "cowork-user-message",
    content: "New user request",
    details: { _coworkInbox: { taskId: "chat", runId: "main-chat", messageId: "inbox-user" } }
  };
  assert.equal(goalDelegationRequestId({ ...context, branch: [laterUser, inbox] }), "user:inbox-user");
  assert.equal(
    goalDelegationRequestId({
      ...context,
      branch: [laterUser],
      mainInput: { ...mainInput, source: "human" }
    }),
    undefined
  );
});

test("unknown archived ownership binds legacy receipts to the recovered input until a fresh request", async (t) => {
  const f = await fixture(t);
  await restoreGoalDelegationRequest(f.root, "chat", "main-chat", undefined, {
    branch: [originalUser, laterUser],
    messages: [originalUser.message]
  });
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser]));
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser, laterUser]));
  await requireCollectorOwnership(f.root, "chat", "main-chat");
});

test("a known archived request recovers legacy ownership even when its pointer was lost", async (t) => {
  const f = await fixture(t);
  const original = goalDelegationRequestId({ taskId: "chat", runId: "main-chat", branch: [originalUser] });
  await restoreGoalDelegationRequest(f.root, "chat", "main-chat", original);
  await assert.rejects(requireCollectorOwnership(f.root, "chat", "main-chat"), /交接/);
  await syncGoalDelegationRequest(f.root, "chat", "main-chat", requestContext([originalUser, laterUser]));
  await requireCollectorOwnership(f.root, "chat", "main-chat");
});

test("a repeated prompt is a fresh request after the first matching saved input, including human answers", () => {
  const first = user("first-yes", "yes", 2);
  const repeated = user("second-yes", "yes", 3);
  const input = {
    taskId: "chat",
    runId: "main-chat",
    sessionId: "session",
    mainInput: { version: 1, prompt: "yes", submittedAt: 1, messageId: "accepted-yes", source: "composer" }
  };
  const original = goalDelegationRequestId({ ...input, branch: [first] });
  const subsequent = goalDelegationRequestId({
    ...input,
    branch: [first, repeated],
    messages: [repeated.message]
  });
  assert.notEqual(subsequent, original);
  assert.equal(
    goalDelegationRequestId({
      ...input,
      branch: [first, repeated],
      mainInput: { ...input.mainInput, source: "human" }
    }),
    subsequent
  );
  assert.equal(
    goalDelegationRequestId({ ...input, sessionId: "forked-session", branch: [first, repeated] }),
    subsequent
  );
});

test("only the delivered message's full content selects a request, including image attachments", () => {
  const first = user("first-image", "Read this", 1);
  const pending = user("second-image", "Read this", 1);
  first.message.content.push({ type: "image", mimeType: "image/png", data: "first" });
  pending.message.content.push({ type: "image", mimeType: "image/png", data: "second" });
  const base = { taskId: "chat", runId: "main-chat", branch: [first, pending], messages: [first.message] };
  assert.equal(goalDelegationRequestId(base), goalDelegationRequestId({ ...base, branch: [first] }));
});

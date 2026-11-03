import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test("an ordinary Main message reaches a streaming Subagent's next real model turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-subagent-message-loop-"));
  let release, started;
  const gate = new Promise((resolve) => (release = resolve));
  const firstRequest = new Promise((resolve) => (started = resolve));
  const provider = await modelProtocolFixture("openai-completions", async (body, requests) => {
    if (requests.length === 1) {
      started();
      await gate;
      return { text: "first turn completed" };
    }
    return { text: "Main's guidance incorporated" };
  });
  let running;
  t.after(async () => {
    release();
    await running;
    await provider.close();
    await rm(root, { recursive: true, force: true });
  });
  await new LocalWorkspaceStore(root).createTask("t");
  const coordinator = new CoordinatorRuntime();
  running = coordinator.dispatch({
    workspaceRoot: root,
    taskId: "t",
    runId: "r",
    callId: "c",
    agentId: "reviewer",
    task: "review the fixture",
    mode: "async",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
    apiKey: "local-fixture",
    model: "protocol-fixture",
    maxAttempts: 1,
    maxErrorRetries: 0,
    timeoutMs: 10_000,
    skillRoots: [],
    toolFactory: () => new Map(),
    questionTimeoutMs: 0
  });
  await firstRequest;
  const queued = await coordinator.sendMessage({
    workspaceRoot: root,
    taskId: "t",
    runId: "r",
    callId: "c",
    message: "Use the revised evaluation fixture."
  });
  assert.equal(queued.status, "queued");
  const inbox = new InboxStore(
    join(root, "t", "runs", "r", "agents", "subagents", "reviewer", "inbox-store.json")
  );
  const deadline = Date.now() + 5_000;
  while ((await inbox.list("reviewer"))[0]?.state !== "consumed" && Date.now() < deadline) await delay(25);
  assert.equal(
    (await inbox.list("reviewer"))[0]?.state,
    "consumed",
    "a streaming Subagent must drain its own recipient identity"
  );
  release();
  assert.equal((await running).status, "succeeded");
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1].body.messages), /Use the revised evaluation fixture/);
});

test("a Subagent peer message reaches another Subagent's next real model turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-peer-message-loop-"));
  let releaseA, releaseB, startedA, startedB;
  const gateA = new Promise((resolve) => (releaseA = resolve));
  const gateB = new Promise((resolve) => (releaseB = resolve));
  const firstA = new Promise((resolve) => (startedA = resolve));
  const firstB = new Promise((resolve) => (startedB = resolve));
  const providerA = await modelProtocolFixture("openai-completions", async (_body, requests) => {
    if (requests.length === 1) {
      startedA();
      await gateA;
    }
    return { text: "sender completed" };
  });
  const providerB = await modelProtocolFixture("openai-completions", async (body, requests) => {
    if (requests.length === 1) {
      startedB();
      await gateB;
      return { text: "receiver first turn completed" };
    }
    return { text: "receiver incorporated peer message" };
  });
  let runningA, runningB;
  t.after(async () => {
    releaseA();
    releaseB();
    await Promise.all([runningA, runningB]);
    await Promise.all([providerA.close(), providerB.close()]);
    await rm(root, { recursive: true, force: true });
  });
  await new LocalWorkspaceStore(root).createTask("t");
  const coordinator = new CoordinatorRuntime();
  runningA = coordinator.dispatch({
    workspaceRoot: root,
    taskId: "t",
    runId: "r",
    callId: "sender-call",
    agentId: "sender",
    task: "send a peer finding",
    mode: "async",
    api: "openai-completions",
    baseUrl: providerA.baseUrl,
    apiKey: "local-fixture",
    model: "protocol-fixture",
    maxAttempts: 1,
    maxErrorRetries: 0,
    timeoutMs: 10_000,
    skillRoots: [],
    toolFactory: () => new Map(),
    questionTimeoutMs: 0
  });
  runningB = coordinator.dispatch({
    workspaceRoot: root,
    taskId: "t",
    runId: "r",
    callId: "receiver-call",
    agentId: "receiver",
    task: "receive a peer finding",
    mode: "async",
    api: "openai-completions",
    baseUrl: providerB.baseUrl,
    apiKey: "local-fixture",
    model: "protocol-fixture",
    maxAttempts: 1,
    maxErrorRetries: 0,
    timeoutMs: 10_000,
    skillRoots: [],
    toolFactory: () => new Map(),
    questionTimeoutMs: 0
  });
  await Promise.all([firstA, firstB]);
  assert.equal(
    providerA.requests[0].body.tools.some((tool) => tool.function.name === "send_peer_message"),
    true
  );
  const queued = await coordinator.sendPeerMessage({
    workspaceRoot: root,
    taskId: "t",
    runId: "r",
    senderCallId: "sender-call",
    targetCallId: "receiver-call",
    message: "Please check the counterexample in work/counterexample.md."
  });
  assert.equal(queued.status, "queued");
  const inbox = new InboxStore(
    join(root, "t", "runs", "r", "agents", "subagents", "receiver", "inbox-store.json")
  );
  const deadline = Date.now() + 5_000;
  while ((await inbox.list("receiver"))[0]?.state !== "consumed" && Date.now() < deadline) await delay(25);
  assert.equal((await inbox.list("receiver"))[0]?.state, "consumed");
  releaseB();
  assert.equal((await runningB).status, "succeeded");
  assert.equal(providerB.requests.length, 2);
  assert.match(JSON.stringify(providerB.requests[1].body.messages), /counterexample\.md/);
  assert.match(JSON.stringify(providerB.requests[1].body.messages), /sender-call/);
  await assert.rejects(
    () =>
      coordinator.sendPeerMessage({
        workspaceRoot: root,
        taskId: "t",
        runId: "r",
        senderCallId: "sender-call",
        targetCallId: "receiver-call",
        message: "This target has already finished."
      }),
    /already completed/
  );
  releaseA();
  assert.equal((await runningA).status, "succeeded");
});

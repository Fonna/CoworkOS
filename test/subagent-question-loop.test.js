import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { configuredSubagentMaxQuestions, configuredSubagentQuestionTimeout, runtimeSettingsEnv } from "../dist/src/runtime/runtime-settings.js";

/**
 * These drive a real pi-agent-core loop against a fake model server.
 *
 * Every other test of this feature replaces PiSession.prototype.run and calls
 * the tool by hand, which proves the tool's promise behaves — not that the
 * agent loop actually waits on it. The whole design rests on the loop blocking
 * (steering is drained only after a turn's tool calls return, so the reply has
 * to arrive by another route), and only a real loop can show that.
 */
async function modelServer(t, handle) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ at: Date.now(), body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) =>
      response.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 1, model: "glm-5.3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const reply = ({ text, calls }) => {
      send({ role: "assistant" });
      if (text) send({ content: text });
      if (calls) send({ tool_calls: calls.map(([name, args], index) => ({ index, id: `tc-${requests.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
      send({}, calls?.length ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    };
    await handle(requests.length, body, reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function workspace(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    // Runtime writes can still be settling when the dispatch promise resolves.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); return; }
      catch (error) {
        if (error?.code !== "ENOTEMPTY" && error?.code !== "EBUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });
  await new LocalWorkspaceStore(root).createTask("t");
  return root;
}

function dispatch(root, baseUrl, overrides = {}) {
  return new CoordinatorRuntime().dispatch({
    workspaceRoot: root, taskId: "t", runId: "r", agentId: "a", callId: "c",
    baseUrl, apiKey: "k", model: "glm-5.3", task: "核对评测脚本", mode: "async",
    maxAttempts: 1, skillRoots: [], toolFactory: () => new Map(),
    questionTimeoutMs: 30_000, ...overrides
  });
}

/** Poll until a question exists, then run `then` against it. */
async function onFirstQuestion(store, then, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [pending] = await store.list("t", "pending");
    if (pending) return then(pending);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the agent loop never invoked ask_main");
}

test("ask_main blocks the real agent loop until Main answers, and the answer reaches the model", async (t) => {
  const root = await workspace(t, "atria-question-loop-");
  const { requests, baseUrl } = await modelServer(t, (n, body, reply) => {
    if (n === 1) return reply({ calls: [["ask_main", { question: "哪个评测脚本是权威的？", assumption: "用 scripts/eval.py" }]] });
    const toolResults = body.messages.filter((message) => message.role === "tool").map((message) => message.content).join(" ");
    reply({ text: `收到回答：${toolResults}` });
  });
  const store = new SubagentQuestionStore(root);
  let answeredAt;
  const answering = onFirstQuestion(store, async (pending) => {
    // Hold the answer back long enough that a non-blocking tool would have let
    // the loop move on to its next turn already.
    await new Promise((resolve) => setTimeout(resolve, 600));
    answeredAt = Date.now();
    return store.answer("t", pending.questionId, "configs/eval.py 才是权威的");
  });
  const [outcome] = await Promise.all([dispatch(root, baseUrl), answering]);

  assert.equal(outcome.status, "succeeded");
  assert.equal(requests.length, 2, "the loop must take a second turn after the tool returns");
  assert.ok(requests[1].at > answeredAt, "the loop continued before the answer existed, so ask_main did not block it");
  assert.match(JSON.stringify(requests[1].body.messages), /configs\/eval\.py 才是权威的/, "the answer must reach the model as a tool result");
  assert.deepEqual(await store.list("t", "pending"), []);
  // The question reached Main as its own inbox kind, ahead of ordinary callbacks.
  const inbox = await new InboxStore(join(root, "t", "runs", "r", "agents", "main", "inbox-store.json")).list("main");
  const question = inbox.find((message) => message.kind === "subagent_question");
  assert.ok(question, "Main must be notified that a collaborator is blocked");
  assert.ok(question.priority > 1, "a blocked collaborator must outrank a queued callback");
  assert.equal(question.payload.assumption, "用 scripts/eval.py");
});

test("an unanswered question releases the real loop on its stated assumption", async (t) => {
  const root = await workspace(t, "atria-question-timeout-");
  const { requests, baseUrl } = await modelServer(t, (n, body, reply) => {
    if (n === 1) return reply({ calls: [["ask_main", { question: "要用哪个数据集？", assumption: "用 data/train.jsonl" }]] });
    const toolResults = body.messages.filter((message) => message.role === "tool").map((message) => message.content).join(" ");
    reply({ text: `无人回答，按假设继续：${toolResults}` });
  });
  const outcome = await dispatch(root, baseUrl, { questionTimeoutMs: 300 });

  assert.equal(outcome.status, "succeeded", "a silent Main must cost a delay, not the run");
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].body.messages), /data\/train\.jsonl/, "the fallback must name the assumption the Subagent declared");
  assert.deepEqual(await new SubagentQuestionStore(root).list("t", "pending"), [], "a timed-out question must not park the Task");
});

test("cancelling a blocked Subagent releases it instead of waiting out the deadline", async (t) => {
  const root = await workspace(t, "atria-question-cancel-");
  const { baseUrl } = await modelServer(t, (n, body, reply) => {
    if (n === 1) return reply({ calls: [["ask_main", { question: "继续吗？", assumption: "继续" }]] });
    reply({ text: "不该走到这里" });
  });
  const coordinator = new CoordinatorRuntime();
  const store = new SubagentQuestionStore(root);
  const started = Date.now();
  // A deadline far beyond the test: only cancellation can end this wait.
  const running = coordinator.dispatch({
    workspaceRoot: root, taskId: "t", runId: "r", agentId: "a", callId: "c",
    baseUrl, apiKey: "k", model: "glm-5.3", task: "x", mode: "async",
    maxAttempts: 1, skillRoots: [], toolFactory: () => new Map(), questionTimeoutMs: 600_000
  });
  await onFirstQuestion(store, () => coordinator.cancelSubagent({ taskId: "t", runId: "r", workspaceRoot: root, callId: "c", reason: "test" }));
  const outcome = await running;

  assert.equal(outcome.status, "cancelled");
  assert.ok(Date.now() - started < 60_000, "cancellation must not wait out the question deadline");
  assert.deepEqual(await store.list("t", "pending"), []);
});

test("an answer landing as the wait expires is honoured, not discarded", async (t) => {
  const root = await workspace(t, "atria-question-race-");
  const store = new SubagentQuestionStore(root);
  await store.create({
    questionId: "q-race", taskId: "t", runId: "r", callId: "c",
    agentId: "a", agentName: "Ada", question: "q?", assumption: "fallback"
  });
  // The window is between the loop's last read and the expiry that closes the
  // question: Main's answer lands there, so the record is already answered by
  // the time the deadline is acted on. A zero deadline puts the wait in that
  // window on its first pass.
  const settled = await store.waitForAnswer("t", "q-race", {
    timeoutMs: 0,
    isCancelled: async () => { await store.answer("t", "q-race", "MAIN-ANSWERED"); return false; }
  });
  assert.equal(settled.status, "answered", "a decision Main was told was delivered must not be dropped on the deadline");
  assert.equal(settled.question.answer, "MAIN-ANSWERED");
  assert.equal((await store.read("t", "q-race")).status, "answered", "the record must not be rewritten to expired");
});

test("question settings default sensibly, clamp, and let config fill in for absent env", () => {
  assert.equal(configuredSubagentQuestionTimeout({}), 180_000);
  assert.equal(configuredSubagentMaxQuestions({}), 3);
  // Zero is the documented kill switch, so it must survive rather than fall back.
  assert.equal(configuredSubagentQuestionTimeout({ COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "0" }), 0);
  assert.equal(configuredSubagentQuestionTimeout({ COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "5000" }), 5_000);
  // A misconfiguration must not park a delegation for longer than an hour.
  assert.equal(configuredSubagentQuestionTimeout({ COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "999999999" }), 3_600_000);
  assert.equal(configuredSubagentQuestionTimeout({ COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "-5" }), 180_000);
  assert.equal(configuredSubagentQuestionTimeout({ COWORK_SUBAGENT_QUESTION_TIMEOUT_MS: "abc" }), 180_000);
  assert.equal(configuredSubagentMaxQuestions({ COWORK_SUBAGENT_MAX_QUESTIONS: "1" }), 1);
  assert.equal(configuredSubagentMaxQuestions({ COWORK_SUBAGENT_MAX_QUESTIONS: "999" }), 20);
  assert.equal(configuredSubagentMaxQuestions({ COWORK_SUBAGENT_MAX_QUESTIONS: "0" }), 3);
  const config = { subagentQuestionTimeoutMs: 9_000, subagentMaxQuestions: 2 };
  const fromConfig = runtimeSettingsEnv(config);
  assert.equal(configuredSubagentQuestionTimeout(fromConfig), 9_000);
  assert.equal(configuredSubagentMaxQuestions(fromConfig), 2);
});

test("a delegation with questions disabled is not told it is synchronous", async (t) => {
  const root = await workspace(t, "atria-question-disabled-");
  const { baseUrl } = await modelServer(t, (n, body, reply) => reply({ text: "done" }));
  const prompts = [];
  const original = PiSession.prototype.run;
  PiSession.prototype.run = async function (...args) {
    prompts.push(this.agent.state.systemPrompt);
    return original.apply(this, args);
  };
  t.after(() => { PiSession.prototype.run = original; });

  await dispatch(root, baseUrl, { questionTimeoutMs: 0 });
  assert.doesNotMatch(prompts[0], /synchronous delegation/, "an async call must not be told Main is waiting inside a tool call");
  assert.doesNotMatch(prompts[0], /ask_main/, "the tool is withheld, so it must not be described");
  assert.match(prompts[0], /no way to reach Main/);

  await dispatch(root, baseUrl, { runId: "r2", agentId: "a2", callId: "c2", mode: "sync" });
  assert.match(prompts[1], /synchronous delegation/, "a sync call must be told why it cannot ask");
});

test("two Subagents blocked at once are answered independently", async (t) => {
  const root = await workspace(t, "atria-question-concurrent-");
  const { baseUrl } = await modelServer(t, (n, body, reply) => {
    const asked = body.messages.some((message) => message.role === "tool");
    if (!asked) return reply({ calls: [["ask_main", { question: `${body.messages.length} 号问题`, assumption: "自己决定" }]] });
    const answers = body.messages.filter((message) => message.role === "tool").map((message) => message.content).join(" ");
    reply({ text: `完成：${answers}` });
  });
  const store = new SubagentQuestionStore(root);
  const coordinator = new CoordinatorRuntime();
  const running = [
    coordinator.dispatch({ workspaceRoot: root, taskId: "t", runId: "r", agentId: "a1", callId: "c1", baseUrl, apiKey: "k", model: "glm-5.3", task: "一", mode: "async", maxAttempts: 1, skillRoots: [], toolFactory: () => new Map(), questionTimeoutMs: 30_000 }),
    coordinator.dispatch({ workspaceRoot: root, taskId: "t", runId: "r", agentId: "a2", callId: "c2", baseUrl, apiKey: "k", model: "glm-5.3", task: "二", mode: "async", maxAttempts: 1, skillRoots: [], toolFactory: () => new Map(), questionTimeoutMs: 30_000 })
  ];
  // Wait for both to be blocked, then answer each with its own decision.
  const deadline = Date.now() + 20_000;
  let pending = [];
  while (Date.now() < deadline && pending.length < 2) {
    pending = await store.list("t", "pending");
    if (pending.length < 2) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(pending.length, 2, "each Subagent must raise its own question");
  assert.equal(new Set(pending.map((question) => question.callId)).size, 2, "questions must not collide across calls");
  for (const question of pending) await store.answer("t", question.questionId, `答案给 ${question.callId}`);
  const outcomes = await Promise.all(running);

  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["succeeded", "succeeded"]);
  // Each answer went to the Subagent that asked for it.
  for (const question of await store.list("t", "answered")) {
    assert.equal(question.answer, `答案给 ${question.callId}`);
  }
  assert.deepEqual(await store.list("t", "pending"), []);
});

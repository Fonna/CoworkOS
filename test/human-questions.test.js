import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HumanRequestStore } from "../dist/src/runtime/human.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import {
  humanAnswer,
  renderHumanQuestion,
  humanAnswerTurn,
  answeredRequestFor
} from "../web/assets/human-questions.js";
import { humanAnswerTurn as runtimeAnswerTurn } from "../dist/src/runtime/human-answer-turn.js";

test("a submitted answer is recognised as one rather than read as a new request", () => {
  // The bug this pins: the Dashboard resumes the run by sending the answer as
  // an ordinary user turn, which the transcript then drew as a message the
  // person had typed — so their own question came back at them as if they had
  // asked for something twice.
  const request = {
    requestId: "h1",
    status: "answered",
    question: "报告要 Markdown 还是 PDF？",
    answer: "Markdown"
  };
  const resumed = {
    role: "user",
    content: [{ type: "text", text: humanAnswerTurn(request.question, request.answer) }]
  };

  assert.equal(answeredRequestFor(resumed, [request])?.requestId, "h1");
  // Something the person actually typed is still their own message, even when
  // a question is open: recognition is by matching the answer that was stored,
  // not by the words happening to look similar.
  assert.equal(answeredRequestFor({ role: "user", content: "Markdown" }, [request]), undefined);
  assert.equal(
    answeredRequestFor(resumed, []),
    undefined,
    "with no answered request there is nothing to attach to"
  );
  // A request still awaiting an answer must not swallow a message either.
  assert.equal(answeredRequestFor(resumed, [{ ...request, status: "pending" }]), undefined);
});

test("the Dashboard and the transcript agree on the shape of a resumed answer", () => {
  // Two copies, one in TypeScript for the Dashboard and one in the browser
  // module. If they drift, every answer silently renders as a duplicate user
  // message again — which is exactly the failure this pins.
  assert.equal(
    runtimeAnswerTurn("报告要 Markdown 还是 PDF？", "Markdown"),
    humanAnswerTurn("报告要 Markdown 还是 PDF？", "Markdown")
  );
});

test("questions allow an explicit option, free text or a supplemented option, without preselecting a decision", () => {
  const question = { question: "选择报告格式", options: ["Markdown", "PDF"] };
  assert.equal(humanAnswer(question), "");
  assert.equal(humanAnswer(question, { choice: 0 }), "Markdown");
  assert.equal(humanAnswer(question, { text: "  Word  " }), "Word");
  assert.equal(humanAnswer(question, { choice: 1, text: "需要目录" }), "PDF\n\n补充说明：需要目录");
  assert.equal(humanAnswer(question, { choice: 8 }), "");
  const html = renderHumanQuestion(question);
  assert.doesNotMatch(html, / checked/);
  assert.match(html, /type="submit" disabled/);
  assert.match(html, /name="human-text"/);
  assert.match(renderHumanQuestion({ question: "目标受众？" }, { text: "开发者" }), /提交并继续/);
});

test("question, option, draft and error content remain plain text", () => {
  const html = renderHumanQuestion(
    { question: '<img src=x onerror="fail()">', context: "<script>bad()</script>", options: ["<iframe>"] },
    { text: "</textarea><script>bad()</script>" },
    { error: "<img>" }
  );
  assert.doesNotMatch(html, /<script>|<iframe>|<img/);
  assert.match(html, /&lt;\/textarea&gt;/);
});

test("a recommended option is offered, and is what an unanswered question falls back to", async (t) => {
  // askhuman blocks for a bounded time, so the recommended option is a
  // commitment rather than a hint: it is what CoworkOS proceeds on when nobody
  // replies. Showing it also lets a person accept the obvious answer without
  // reading every option.
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-human-rec-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new HumanRequestStore(workspaceRoot);
  const request = await store.create({
    taskId: "task-1",
    runId: "run-1",
    question: "报告要什么格式？",
    options: ["Markdown", "PDF"],
    recommended: 1
  });
  assert.equal(request.recommended, 1);
  const html = renderHumanQuestion(request);
  assert.match(html, /推荐/, "the recommended option is marked in the UI");
  assert.match(html, /is-recommended/);

  // An index that points at nothing is dropped rather than stored, so neither
  // the UI nor the timeout path has to guard against it.
  const noOptions = await store.create({
    taskId: "task-1",
    runId: "run-1",
    question: "随便说点什么？",
    recommended: 0
  });
  assert.equal(noOptions.recommended, undefined);
  const outOfRange = await store.create({
    taskId: "task-1",
    runId: "run-1",
    question: "选一个",
    options: ["甲"],
    recommended: 5
  });
  assert.equal(outOfRange.recommended, undefined);
  assert.doesNotMatch(renderHumanQuestion(outOfRange), /推荐/);
});

test("askhuman waits for the answer, and a delivered answer is not replayed from the Inbox", async (t) => {
  // The point of the change: the answer comes back as the tool's own result, so
  // the transcript records a tool call and its result instead of a fabricated
  // user turn — which is what dragged the supervisor's "Resume this task…"
  // prompt into the conversation as though the person had typed it.
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-human-wait-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const store = new HumanRequestStore(workspaceRoot);
  const request = await store.create({
    taskId: "task-1",
    runId: "run-1",
    question: "继续吗？",
    options: ["继续"],
    recommended: 0
  });

  // Answered while the tool is still waiting.
  const waiting = store.waitForAnswer("task-1", request.requestId, { timeoutMs: 5_000, pollMs: 50 });
  await store.submitAnswer("task-1", request.requestId, "继续");
  const settled = await waiting;
  assert.equal(settled.status, "answered");
  assert.equal(settled.request.answer, "继续");

  // The durable Inbox copy exists for a restart. Once the waiting tool has the
  // answer it is a duplicate, and left queued it arrived next turn as a second,
  // unprompted instruction to act on a decision already acted on.
  const inbox = new InboxStore(
    join(workspaceRoot, "task-1", "runs", "run-1", "agents", "main", "inbox-store.json")
  );
  assert.equal((await inbox.list("main")).filter((message) => message.state !== "consumed").length, 1);
  await store.consumeAnswerMessage("task-1", request.requestId);
  assert.equal((await inbox.list("main")).filter((message) => message.state !== "consumed").length, 0);
  // Consuming twice, or with nothing queued, is not an error.
  await store.consumeAnswerMessage("task-1", request.requestId);

  // Nobody answers: a timeout is reported rather than waiting forever, and the
  // question stays open so a late answer still reaches Main durably.
  const ignored = await store.create({ taskId: "task-1", runId: "run-1", question: "还在吗？" });
  const timedOut = await store.waitForAnswer("task-1", ignored.requestId, { timeoutMs: 120, pollMs: 40 });
  assert.equal(timedOut.status, "timeout");
  assert.equal(
    (await store.read("task-1", ignored.requestId)).status,
    "pending",
    "a timeout must not close the question: the person may still answer it"
  );
});

test("saved human questions survive store recreation, with idempotent durable answer delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new HumanRequestStore(root);
  const question = await first.create({
    taskId: "task",
    runId: "run",
    question: "确认交付格式？",
    options: ["PDF", "Markdown"]
  });
  const restored = new HumanRequestStore(root);
  assert.equal((await restored.list("task", "pending"))[0].requestId, question.requestId);
  // Simulate a stop between saving the answer and writing its Inbox message.
  await first.answer("task", question.requestId, "PDF");
  const result = await restored.submitAnswer("task", question.requestId, "Markdown");
  assert.equal(result.request.answer, "PDF");
  const inbox = new InboxStore(join(root, "task", "runs", "run", "agents", "main", "inbox-store.json"));
  const message = await inbox.lease("main");
  await inbox.consume(message.messageId);
  await Promise.all([
    restored.submitAnswer("task", question.requestId, "PDF"),
    first.submitAnswer("task", question.requestId, "PDF")
  ]);
  assert.equal((await inbox.list("main")).length, 1);
  assert.equal((await inbox.list("main"))[0].state, "consumed");
});

test("an answer consumed while its durable Inbox write is delayed never replays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-delivery-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HumanRequestStore(root);
  const request = await store.create({ taskId: "task", runId: "run", question: "继续吗？" });
  const enqueue = InboxStore.prototype.enqueue;
  let release;
  let reached;
  const reachedEnqueue = new Promise((resolve) => {
    reached = resolve;
  });
  const delayedWrite = new Promise((resolve) => {
    release = resolve;
  });
  InboxStore.prototype.enqueue = async function (message) {
    if (message.state === "ready") {
      reached();
      await delayedWrite;
    }
    return enqueue.call(this, message);
  };
  t.after(() => {
    release();
    InboxStore.prototype.enqueue = enqueue;
  });

  const submitted = store.submitAnswer("task", request.requestId, "继续");
  await reachedEnqueue;
  assert.equal(
    (await store.waitForAnswer("task", request.requestId, { timeoutMs: 1000 })).status,
    "answered"
  );
  const consumed = store.consumeAnswerMessage("task", request.requestId);
  // The tool can observe the answer before the submitting process queues its
  // durable copy. Hold the enqueue long enough to reproduce that interleaving.
  await new Promise((resolve) => setTimeout(resolve, 60));
  release();
  await Promise.all([submitted, consumed]);
  const inbox = new InboxStore(join(root, "task", "runs", "run", "agents", "main", "inbox-store.json"));
  assert.equal(
    (await inbox.list("main"))[0].state,
    "consumed",
    "the answer already reached the waiting tool"
  );
});

test("a submission retry cannot replay an answer already read directly from disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-retry-consumed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HumanRequestStore(root);
  const request = await store.create({ taskId: "task", runId: "run", question: "继续吗？" });
  await store.answer("task", request.requestId, "继续");
  await store.consumeAnswerMessage("task", request.requestId);
  const retried = await store.submitAnswer("task", request.requestId, "停下");
  assert.equal(retried.request.answer, "继续");
  assert.equal(retried.message.state, "consumed", "a lost response retry must not inject another decision");
});

test("cancelling a waiting human question closes its durable pending obligation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-cancel-wait-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HumanRequestStore(root);
  const request = await store.create({ taskId: "task", runId: "run", question: "继续吗？" });
  const result = await store.waitForAnswer("task", request.requestId, {
    timeoutMs: 60_000,
    isCancelled: async () => true
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.request.status, "cancelled");
  assert.deepEqual(
    await store.list("task", "pending"),
    [],
    "a stopped tool must not prevent the next turn from completing"
  );
});

test("blank choices do not change the question's recommended decision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-human-choice-normalization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new HumanRequestStore(root);
  const request = await store.create({
    taskId: "task",
    runId: "run",
    question: "格式？",
    options: [" ", " Markdown ", "PDF"],
    recommended: 1
  });
  assert.deepEqual(request.options, ["Markdown", "PDF"]);
  assert.equal(
    request.options[request.recommended],
    "Markdown",
    "cleaning an empty choice must preserve which choice was recommended"
  );
  const blank = await store.create({
    taskId: "task",
    runId: "run",
    question: "格式？",
    options: [" ", "PDF"],
    recommended: 0
  });
  assert.equal(blank.recommended, undefined, "an empty recommendation must not become a different choice");
});

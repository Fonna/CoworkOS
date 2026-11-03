import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { InboxStore } from "../dist/src/runtime/scheduler.js";
import { listAgentOutputFiles, readSubagentProgress } from "../dist/src/runtime/progress.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { listTaskArtifacts } from "../dist/src/workspace/artifact-store.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { SubagentQuestionStore } from "../dist/src/runtime/subagent-questions.js";

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() };
}

function result(session, termination = "completed") {
  const message = assistant("已核查完成，候选文件可供 Main 验收。");
  session.agent.state.messages = [message];
  return { assistant: message, messages: [message], compaction: session.compactionState, termination };
}

async function fixture(t) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atria-artifact-runtime-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const taskId = "task-files";
  const runId = "run-files";
  const agentId = "researcher";
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  await workspace.createTask(taskId);
  const taskRoot = join(workspaceRoot, taskId);
  return { workspaceRoot, taskRoot, workspace, taskId, runId, agentId };
}

function fakeSession(t, run) {
  const original = PiSession.prototype.run;
  PiSession.prototype.run = run;
  t.after(() => {
    PiSession.prototype.run = original;
  });
}

async function writeCandidateFiles(f) {
  const output = join(f.taskRoot, "agents", "subagents", f.agentId, "deliverables", "研究");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "报告初稿.md"), "# 有证据的研究结论\n");
  await writeFile(join(output, "presentation.pptx"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0xff]));
  const logs = join(f.taskRoot, "agents", "subagents", f.agentId, "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, "debug.log"), "intermediate log\n");
  const trace = join(f.taskRoot, "sessions", f.agentId, `${f.runId}.jsonl`);
  await mkdir(dirname(trace), { recursive: true });
  await appendFile(
    trace,
    JSON.stringify({ payload: { type: "message_end", message: assistant("候选文件已写入") } }) + "\n"
  );
  return [
    `agents/subagents/${f.agentId}/deliverables/研究/presentation.pptx`,
    `agents/subagents/${f.agentId}/deliverables/研究/报告初稿.md`
  ].sort();
}

function dispatchInput(f, mode) {
  return {
    ...f,
    callId: "call-files",
    task: "研究并生成可复用报告",
    mode,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    maxAttempts: 1,
    skillRoots: [],
    toolFactory: () => new Map()
  };
}

test("sync and async delegation keep candidate outputs readable without publishing diagnostics", async (t) => {
  for (const mode of ["sync", "async"]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      let expected;
      fakeSession(t, async function () {
        expected = await writeCandidateFiles(f);
        await symlink(
          join(f.taskRoot, "agents", "main"),
          join(f.taskRoot, "agents", "subagents", f.agentId, "deliverables", "shortcut")
        );
        assert.match(this.agent.state.systemPrompt, /Main reviews the files/);
        assert.match(this.agent.state.systemPrompt, /Do not write to Task artifacts/);
        return result(this);
      });
      const coordinator = new CoordinatorRuntime();
      const value = await coordinator.dispatch(dispatchInput(f, mode));
      assert.equal(value.status, "succeeded");
      assert.deepEqual(value.artifacts, []);
      assert.deepEqual(value.outputFiles.toSorted(), expected);
      assert.deepEqual(await listTaskArtifacts(f), []);
      assert.equal(value.diagnostics.tracePath, `sessions/${f.agentId}/${f.runId}.jsonl`);
      assert.equal(value.diagnostics.resultPath, `runs/${f.runId}/agents/subagents/${f.agentId}/result.json`);
      const saved = JSON.parse(await readFile(join(f.taskRoot, value.diagnostics.resultPath), "utf8"));
      assert.equal(saved.termination, "completed");
      assert.match(saved.messages[0].content[0].text, /Main 验收/);
      assert.match(value.response, /Candidate outputs/);
      assert.ok(value.response.includes(expected[1]));
      assert.ok(value.response.includes(value.diagnostics.resultPath));

      const mainTools = createBuiltinTools({
        rootDirectory: join(f.taskRoot, "agents", "main"),
        workspaceDirectory: f.taskRoot
      });
      const read = await mainTools
        .get("browse_workspace")
        .execute({ mode: "read", path: expected.find((path) => path.endsWith(".md")) });
      assert.match(JSON.stringify(read), /有证据的研究结论/);
      const progress = await readSubagentProgress(f);
      assert.deepEqual(progress.agents[0].outputFiles.toSorted(), expected);
      assert.deepEqual(progress.agents[0].artifacts, []);

      const callbacks = await new InboxStore(
        join(f.taskRoot, "runs", f.runId, "agents", "main", "inbox-store.json")
      ).list("main");
      assert.equal(callbacks.length, mode === "async" ? 1 : 0);
      if (mode === "async") {
        assert.deepEqual(callbacks[0].payload.outputFiles.toSorted(), expected);
        assert.deepEqual(callbacks[0].payload.diagnostics, value.diagnostics);
        const waited = await coordinator.waitForSubagents({ ...f, timeoutMs: 0 });
        assert.deepEqual(waited.calls[0].outputFiles.toSorted(), expected);
      }
    });
  }
});

test("failed, timed out and cancelled calls retain partial outputs in callbacks", async (t) => {
  for (const termination of ["failed", "timed_out", "cancelled"]) {
    await t.test(termination, async (t) => {
      const f = await fixture(t);
      let expected;
      fakeSession(t, async function () {
        expected = await writeCandidateFiles(f);
        const value = result(this, termination);
        if (termination === "failed") throw new Error("fixture provider interruption");
        return value;
      });
      const value = await new CoordinatorRuntime().dispatch(dispatchInput(f, "async"));
      assert.equal(value.status, termination);
      assert.deepEqual(value.outputFiles.toSorted(), expected);
      assert.deepEqual(await listTaskArtifacts(f), []);
      const saved = JSON.parse(await readFile(join(f.taskRoot, value.diagnostics.resultPath), "utf8"));
      assert.equal(saved.termination, termination);
      assert.ok(saved.error);
      assert.equal(saved.messages.length, 1);
      const callbacks = await new InboxStore(
        join(f.taskRoot, "runs", f.runId, "agents", "main", "inbox-store.json")
      ).list("main");
      assert.equal(callbacks.length, 1);
      assert.equal(callbacks[0].payload.status, termination);
      assert.deepEqual(callbacks[0].payload.outputFiles.toSorted(), expected);
      assert.deepEqual(callbacks[0].payload.diagnostics, value.diagnostics);
      assert.ok(callbacks[0].payload.response.includes(expected[1]));
    });
  }
});

test("Main can write final files through its normal tools while results stay in run diagnostics", async (t) => {
  const f = await fixture(t);
  let mainTools;
  fakeSession(t, async function () {
    assert.match(this.agent.state.systemPrompt, /Only files in the Task artifacts/);
    assert.ok(this.agent.state.systemPrompt.includes(join(f.taskRoot, "artifacts")));
    await mainTools.get("write_file").execute({ path: "artifacts/最终报告.md", content: "# 已完成验收\n" });
    await mainTools
      .get("write_file")
      .execute({ path: "artifacts/data.json", content: '{"accepted":true}\n' });
    await mainTools
      .get("write_file")
      .execute({ path: "deliverables/draft.md", content: "private candidate" });
    await mainTools.get("write_file").execute({ path: "logs/debug.log", content: "private log" });
    return result(this);
  });
  const value = await new RunService(f.workspaceRoot).runPi({
    taskId: f.taskId,
    runId: f.runId,
    prompt: "交付验收后的报告与数据",
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    tools: (workingDirectory, workspaceDirectory, artifactDirectory) => {
      assert.equal(workingDirectory, join(f.taskRoot, "agents", "main"));
      assert.equal(artifactDirectory, join(f.taskRoot, "artifacts"));
      return (mainTools = createBuiltinTools({
        rootDirectory: workingDirectory,
        workspaceDirectory,
        artifactDirectory
      }));
    }
  });
  assert.equal(value.taskStatus, "completed");
  assert.deepEqual(
    value.artifacts.map((file) => file.relativePath).sort(),
    ["data.json", "最终报告.md"].sort()
  );
  assert.equal(value.diagnostics.resultPath, `runs/${f.runId}/agents/main/result.json`);
  const saved = JSON.parse(await readFile(join(f.taskRoot, value.diagnostics.resultPath), "utf8"));
  assert.equal(saved.termination, "completed");
  assert.equal(saved.messages.length, 1);
  assert.equal(
    await readFile(join(f.taskRoot, "agents", "main", "deliverables", "draft.md"), "utf8"),
    "private candidate"
  );
});

test("Main interruptions save diagnostics and preserve its resumable checkpoint", async (t) => {
  const f = await fixture(t);
  fakeSession(t, async function () {
    return result(this, "timed_out");
  });
  await assert.rejects(
    new RunService(f.workspaceRoot).runPi({
      taskId: f.taskId,
      runId: f.runId,
      prompt: "继续长任务",
      baseUrl: "https://example.test/v1",
      apiKey: "fixture-key",
      tools: () => new Map()
    }),
    /checkpoint retained.*diagnostics:/
  );
  assert.equal((await f.workspace.readTask(f.taskId)).status, "waiting");
  const saved = JSON.parse(
    await readFile(join(f.taskRoot, "runs", f.runId, "agents", "main", "result.json"), "utf8")
  );
  assert.equal(saved.termination, "timed_out");
  assert.deepEqual(await listTaskArtifacts(f), []);
});

test("progress reads a bounded tail of huge traces and only counts new complete events", async (t) => {
  const f = await fixture(t);
  await f.workspace.createRun(f.taskId, f.runId);
  const runRoot = join(f.taskRoot, "runs", f.runId);
  await writeFile(
    join(runRoot, "queue.json"),
    JSON.stringify([
      { stepId: "call-files", agentId: f.agentId, status: "leased", payload: { task: "研究" } }
    ])
  );
  const tracePath = join(f.taskRoot, "sessions", f.agentId, `${f.runId}.jsonl`);
  await mkdir(dirname(tracePath), { recursive: true });
  const traceLine = (payload) => JSON.stringify({ occurredAt: "2026-09-08T00:00:00Z", payload }) + "\n";
  const tail =
    "\n" +
    traceLine({ type: "turn_start" }) +
    traceLine({ type: "tool_execution_end", toolName: "read_file" }) +
    traceLine({ type: "message_end", message: assistant("已经完成第一步") });
  const file = await open(tracePath, "w");
  try {
    await file.write(tail, 1024 * 1024 * 1024, "utf8");
  } finally {
    await file.close();
  }
  let status = (await readSubagentProgress(f)).agents[0];
  assert.equal(status.traceSampled, true);
  assert.equal(status.turns, 1);
  assert.equal(status.messageCount, 1);
  assert.equal(status.lastTool, "read_file");
  assert.equal(status.lastAssistantText, "已经完成第一步");
  await appendFile(tracePath, traceLine({ type: "turn_start" }));
  const pending = traceLine({ type: "message_end", message: assistant("中文追加事件") });
  const bytes = Buffer.from(pending);
  const split = bytes.indexOf(Buffer.from("中文")) + 1;
  await appendFile(tracePath, bytes.subarray(0, split));
  status = (await readSubagentProgress(f)).agents[0];
  assert.equal(status.turns, 2);
  assert.equal(status.messageCount, 1);
  await appendFile(tracePath, bytes.subarray(split));
  status = (await readSubagentProgress(f)).agents[0];
  assert.equal(status.messageCount, 2);
  assert.equal(status.lastAssistantText, "中文追加事件");
  assert.equal((await readSubagentProgress(f)).agents[0].messageCount, 2);
  await appendFile(tracePath, traceLine({ type: "turn_start" }));
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => readSubagentProgress(f)));
  assert.ok(concurrent.every((snapshot) => snapshot.agents[0].turns === 3));
  await writeFile(tracePath, traceLine({ type: "turn_start" }));
  status = (await readSubagentProgress(f)).agents[0];
  assert.equal(status.turns, 1);
  assert.equal(status.messageCount, 0);
  assert.equal(status.traceSampled, undefined);
});

test("candidate enumeration does not follow a linked deliverables directory", async (t) => {
  const f = await fixture(t);
  const agentRoot = await f.workspace.prepareAgentWorkDir(f.taskId, f.runId, f.agentId);
  const elsewhere = join(f.workspaceRoot, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "not-an-output.md"), "must not be enumerated");
  await symlink(elsewhere, join(agentRoot, "deliverables"));
  assert.deepEqual(await listAgentOutputFiles(f), []);
});

test("ask_main is offered only to an async delegation and blocks until Main answers", async (t) => {
  const f = await fixture(t);
  let seen;
  fakeSession(t, async function () {
    seen = this.agent.state.tools.map((tool) => tool.name);
    return result(this);
  });
  await new CoordinatorRuntime().dispatch({ ...dispatchInput(f, "sync"), questionTimeoutMs: 60_000 });
  assert.ok(
    !seen.includes("ask_main"),
    "a sync call holds Main's turn, so its question could never be answered"
  );

  const asyncF = await fixture(t);
  let answered;
  fakeSession(t, async function () {
    const tool = this.agent.state.tools.find((candidate) => candidate.name === "ask_main");
    assert.ok(tool, "an async call can be answered, so it may ask");
    assert.match(this.agent.state.systemPrompt, /ask_main/);
    const store = new SubagentQuestionStore(asyncF.workspaceRoot);
    // Answer out of band while the tool is blocked, which is what Main does.
    const answering = (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [pending] = await store.list(asyncF.taskId, "pending");
        if (pending) return store.answer(asyncF.taskId, pending.questionId, "configs/eval.py 是权威的");
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("question was never raised");
    })();
    const [outcome] = await Promise.all([
      tool.execute("tool-ask", { question: "哪个评测脚本是权威的？", assumption: "用 scripts/eval.py" }),
      answering
    ]);
    answered = outcome.details;
    return result(this);
  });
  await new CoordinatorRuntime().dispatch({ ...dispatchInput(asyncF, "async"), questionTimeoutMs: 60_000 });
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "configs/eval.py 是权威的");
  const events = (await readFile(join(asyncF.taskRoot, "runs", asyncF.runId, "run_events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "question.raised").length, 1);
  assert.equal(events.filter((event) => event.type === "question.answered").length, 1);
  // The question reached Main's inbox as its own kind.
  const inbox = await new InboxStore(
    join(asyncF.taskRoot, "runs", asyncF.runId, "agents", "main", "inbox-store.json")
  ).list("main");
  assert.equal(inbox.filter((message) => message.kind === "subagent_question").length, 1);
});

test("an unanswered question expires with a usable fallback and never outlives its call", async (t) => {
  const f = await fixture(t);
  let unanswered;
  let refused;
  fakeSession(t, async function () {
    const tool = this.agent.state.tools.find((candidate) => candidate.name === "ask_main");
    unanswered = (
      await tool.execute("tool-ask", { question: "要用哪个数据集？", assumption: "用 data/train.jsonl" })
    ).details;
    refused = (await tool.execute("tool-ask", { question: "再问一个", assumption: "自己决定" })).details;
    return result(this);
  });
  await new CoordinatorRuntime().dispatch({
    ...dispatchInput(f, "async"),
    questionTimeoutMs: 40,
    maxQuestions: 1
  });
  assert.equal(unanswered.status, "unanswered");
  assert.match(
    unanswered.instruction,
    /data\/train\.jsonl/,
    "the fallback must name the assumption the Subagent declared"
  );
  assert.equal(
    refused.status,
    "refused",
    "the per-call quota bounds an Agent that would rather ask than decide"
  );
  // A terminal call must leave nothing pending, or the Task could never complete.
  const store = new SubagentQuestionStore(f.workspaceRoot);
  assert.deepEqual(await store.list(f.taskId, "pending"), []);
  assert.equal((await store.list(f.taskId, "expired")).length, 1);
});

test("a question left open by a failed call is reclaimed at its terminal state", async (t) => {
  const f = await fixture(t);
  let asking;
  fakeSession(t, async function () {
    const tool = this.agent.state.tools.find((candidate) => candidate.name === "ask_main");
    const store = new SubagentQuestionStore(f.workspaceRoot);
    // Raise a question, then fail while it is still pending.
    asking = tool.execute("tool-ask", { question: "继续吗？", assumption: "继续" });
    for (
      let attempt = 0;
      attempt < 200 && (await store.list(f.taskId, "pending")).length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal((await store.list(f.taskId, "pending")).length, 1);
    throw new Error("subagent failed while a question was open");
  });
  const outcome = await new CoordinatorRuntime().dispatch({
    ...dispatchInput(f, "async"),
    questionTimeoutMs: 60_000
  });
  // The synthetic session crashes without awaiting its tool; let that tool
  // observe expiration and finish writing diagnostics before fixture cleanup.
  assert.equal((await asking).details.status, "unanswered");
  assert.equal(outcome.status, "failed");
  assert.deepEqual(
    await new SubagentQuestionStore(f.workspaceRoot).list(f.taskId, "pending"),
    [],
    "a call that can no longer answer must not park the Task"
  );
});

test("a retried attempt does not leave its question answerable by Main", async (t) => {
  const f = await fixture(t);
  const store = new SubagentQuestionStore(f.workspaceRoot);
  let asking;
  fakeSession(t, async function () {
    const tool = this.agent.state.tools.find((candidate) => candidate.name === "ask_main");
    // Raise a question, then die while it is still pending so the call is requeued.
    asking = tool.execute("tool-ask", { question: "继续吗？", assumption: "继续" });
    for (
      let attempt = 0;
      attempt < 200 && (await store.list(f.taskId, "pending")).length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("subagent crashed mid-question");
  });
  // maxAttempts 2 means the first failure schedules a retry rather than settling.
  await new CoordinatorRuntime().dispatch({
    ...dispatchInput(f, "async"),
    maxAttempts: 2,
    questionTimeoutMs: 60_000
  });
  assert.equal((await asking).details.status, "unanswered");
  // The asking session is gone either way, so nothing may still be answerable:
  // Main would be told it unblocked an Agent that no longer exists.
  assert.deepEqual(await store.list(f.taskId, "pending"), []);
  assert.equal((await store.list(f.taskId, "expired")).length, 1);
});

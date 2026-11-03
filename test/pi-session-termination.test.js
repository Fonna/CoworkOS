import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunService } from "../dist/src/runtime/run-service.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { CheckpointStore } from "../dist/src/runtime/scheduler.js";
import { emptyCompaction } from "../dist/src/runtime/agent-checkpoint.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { resolveCapabilities } from "../dist/src/runtime/task-capabilities.js";
import { TraceRecorder } from "../dist/src/storage/trace-recorder.js";
import {
  hasCompletedAssistantResponse,
  PiSession,
  unresolvedToolCallIds
} from "../dist/src/runtime/pi-session.js";

const user = { role: "user", content: "核对隔离测试数据。", timestamp: 1 };
const savedAssistant = (stopReason, content = [{ type: "text", text: "旧响应的部分正文。" }]) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "cowork-glm",
  model: "termination-fixture",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason,
  timestamp: 2,
  ...(["error", "aborted"].includes(stopReason) ? { errorMessage: "隔离测试中的旧中断。" } : {})
});

async function fixture(
  t,
  {
    firstError = false,
    errorCount = firstError ? 1 : 0,
    finishReason = "stop",
    content = "本轮核对已完成。",
    toolOnFirst = false,
    toolFinishReason = "tool_calls",
    firstTool = { name: "write_fixture", arguments: "{}" }
  } = {}
) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (requests.length <= errorCount) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic transient provider failure." } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `termination-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "termination-fixture",
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`
      );
    send({ role: "assistant" });
    if (toolOnFirst && requests.length === 1) {
      send({
        tool_calls: [
          {
            index: 0,
            id: "fixture-write",
            type: "function",
            function: firstTool
          }
        ]
      });
      send({}, toolFinishReason);
    } else {
      send({ content: typeof content === "function" ? content(requests.length) : content });
      send({}, typeof finishReason === "function" ? finishReason(requests.length) : finishReason);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "isolated-local-fixture",
    model: "termination-fixture",
    supportsReasoningEffort: false,
    supportsImages: false,
    thinkingLevel: "off",
    tools: new Map(),
    maxTokens: 256,
    timeoutMs: 5000
  };
}

test("a subagent receives a job spawn failure as a tool error and continues its session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-pi-spawn-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = await fixture(t, {
    toolOnFirst: true,
    firstTool: {
      name: "start_job",
      arguments: JSON.stringify({ command: "echo unused", cwd: "missing" })
    }
  });
  const session = new PiSession({
    ...connection,
    tools: createBuiltinTools({
      rootDirectory: root,
      capabilities: resolveCapabilities({ longRunning: true }, {})
    }),
    maxErrorRetries: 0
  });
  const result = await session.run("Start a background job and report any launch failure.");
  assert.equal(connection.requests.length, 2);
  const failedTool = result.messages.find((message) => message.role === "toolResult");
  assert.equal(failedTool.isError, true);
  assert.match(JSON.stringify(failedTool.content), /Failed to start job job-1.*ENOENT/);
  const modelFeedback = connection.requests[1].messages.find((message) => message.role === "tool");
  assert.match(JSON.stringify(modelFeedback), /Failed to start job job-1.*ENOENT/);
  assert.equal(result.termination, "completed");
});

test(
  "a successful retry after a real HTTP 500 completes while retaining its failed attempt",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, { firstError: true });
    const root = await mkdtemp(join(tmpdir(), "atria-retry-requests-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const trace = new TraceRecorder(join(root, "worker.jsonl"));
    const events = [];
    const session = new PiSession({
      ...connection,
      trace: { recorder: trace, taskId: "task", runId: "run", agentId: "worker" },
      maxErrorRetries: 1,
      onEvent: (event) => events.push(event)
    });
    const result = await session.run("完成隔离测试任务。");
    assert.equal(connection.requests.length, 2);
    assert.match(JSON.stringify(connection.requests[1].messages), /transient provider\/stream error/);
    assert.deepEqual(
      result.messages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
      ["error", "stop"]
    );
    assert.ok(events.some((event) => event.type === "message_end" && event.message.stopReason === "error"));
    assert.equal(hasCompletedAssistantResponse(result.messages), true);
    assert.equal(result.termination, "completed");
    assert.equal(result.error, undefined, "a recovered provider error must not mark the result failed");
    const records = (await readFile(trace.modelRequestPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.filter((record) => record.type === "model_request").length, 2);
    assert.deepEqual(
      records
        .filter((record) => record.type === "model_response_http")
        .map((record) => record.payload.status),
      [500, 200]
    );
    assert.deepEqual(
      records
        .filter((record) => record.type === "model_response")
        .map((record) => record.payload.message.stopReason),
      ["error", "stop"]
    );
  }
);

for (const errorCount of [5, 6])
  test(
    `Subagent default retries ${errorCount === 5 ? "recover on the fifth retry" : "stop after six failed requests"}`,
    { timeout: 10000 },
    async (t) => {
      const connection = await fixture(t, { errorCount });
      const result = await new PiSession(connection).run("完成隔离测试任务。");
      assert.equal(connection.requests.length, 6);
      assert.equal(result.termination, errorCount === 5 ? "completed" : "aborted");
    }
  );

for (const stopReason of ["error", "aborted"])
  test(
    `checkpoint recovery succeeds after a historical ${stopReason} response`,
    { timeout: 10000 },
    async (t) => {
      const connection = await fixture(t);
      const session = new PiSession({
        ...connection,
        maxErrorRetries: 0,
        initialMessages: [user, savedAssistant(stopReason)]
      });
      const result = await session.run("恢复核对。", { resume: true });
      assert.equal(connection.requests.length, 1);
      assert.match(JSON.stringify(connection.requests[0].messages), /Resume the interrupted task/);
      assert.equal(
        result.messages.find((message) => message.role === "assistant" && message.timestamp === 2).stopReason,
        stopReason,
        "recovery must retain earlier diagnostic history"
      );
      assert.equal(result.messages.at(-1).stopReason, "stop");
      assert.equal(hasCompletedAssistantResponse(result.messages), true);
      assert.equal(result.termination, "completed");
    }
  );

test(
  "a latest length-limited response does not complete after a prior successful response",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, { finishReason: "length", content: "本轮仍未写完的正文" });
    const session = new PiSession({
      ...connection,
      maxErrorRetries: 0,
      initialMessages: [user, savedAssistant("stop", [{ type: "text", text: "上一轮已经完成。" }])]
    });
    const result = await session.run("继续核对下一项。");
    assert.equal(connection.requests.length, 1);
    assert.equal(result.messages.at(-1).stopReason, "length");
    assert.equal(hasCompletedAssistantResponse(result.messages), false);
    assert.equal(result.termination, "aborted");
  }
);

test("bounded output continuation retains partial text and completes", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, {
    finishReason: (attempt) => (attempt === 1 ? "length" : "stop"),
    content: (attempt) =>
      attempt === 1 ? "The receipt is present; remaining check" : "Final verification complete."
  });
  const checkpoints = [];
  const result = await new PiSession({
    ...connection,
    maxLengthContinuations: 1,
    onCheckpoint: (checkpoint) => checkpoints.push(structuredClone(checkpoint))
  }).run("Verify the receipt.");
  assert.equal(connection.requests.length, 2);
  assert.match(JSON.stringify(connection.requests[1].messages), /The receipt is present; remaining check/);
  assert.match(JSON.stringify(connection.requests[1].messages), /output-token limit/);
  assert.deepEqual(
    result.messages.filter((message) => message.role === "assistant").map((message) => message.stopReason),
    ["length", "stop"]
  );
  assert.equal(result.termination, "completed");
  assert.equal(result.lastStopReason, "stop");
  assert.deepEqual(result.continuations, { providerErrors: 0, outputLimits: 1 });
  assert.deepEqual(checkpoints.at(-1).messages, result.messages);
});

test("an exhausted output continuation is bounded and stays incomplete", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, { finishReason: "length" });
  const result = await new PiSession({ ...connection, maxLengthContinuations: 2 }).run("Verify.");
  assert.equal(connection.requests.length, 3);
  assert.equal(result.lastStopReason, "length");
  assert.equal(result.termination, "aborted");
  assert.deepEqual(result.continuations, { providerErrors: 0, outputLimits: 2 });
});

test("output continuation never repeats a completed side effect", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, {
    toolOnFirst: true,
    finishReason: (attempt) => (attempt === 2 ? "length" : "stop")
  });
  let writes = 0;
  const result = await new PiSession({
    ...connection,
    tools: new Map([
      [
        "write_fixture",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            writes++;
            return "receipt written";
          }
        }
      ]
    ]),
    maxLengthContinuations: 1
  }).run("Write once and verify.");
  assert.equal(writes, 1);
  assert.equal(connection.requests.length, 3);
  assert.match(JSON.stringify(connection.requests[2].messages), /receipt written/);
  assert.match(JSON.stringify(connection.requests[2].messages), /Do not repeat completed tool calls/);
  assert.equal(result.termination, "completed");
});

test("truncated tool arguments are rejected before output recovery", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, { toolOnFirst: true, toolFinishReason: "length" });
  let writes = 0;
  const result = await new PiSession({
    ...connection,
    tools: new Map([
      [
        "write_fixture",
        {
          parameters: { type: "object", properties: {} },
          execute: async () => {
            writes++;
            return "unused";
          }
        }
      ]
    ]),
    maxLengthContinuations: 1
  }).run("Write with complete arguments.");
  assert.equal(writes, 0);
  assert.equal(connection.requests.length, 2);
  assert.equal(result.messages.find((message) => message.role === "toolResult").isError, true);
  assert.match(JSON.stringify(connection.requests[1].messages), /arguments may be truncated/);
  assert.equal(result.termination, "completed");
});

test("cancellation at a truncated checkpoint prevents another request", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, { finishReason: "length" });
  const controller = new AbortController();
  const result = await new PiSession({
    ...connection,
    signal: controller.signal,
    maxLengthContinuations: 3,
    onCheckpoint: () => controller.abort()
  }).run("Verify.");
  assert.equal(connection.requests.length, 1);
  assert.equal(result.termination, "cancelled");
  assert.deepEqual(result.continuations, { providerErrors: 0, outputLimits: 0 });
});

test("programmatic run validates continuation bounds before inference", async (t) => {
  const connection = await fixture(t);
  for (const maxLengthContinuations of [-1, 0.5, NaN, Infinity, 101]) {
    assert.throws(() => new PiSession({ ...connection, maxLengthContinuations }), /maxLengthContinuations/);
  }
  assert.equal(connection.requests.length, 0);
});

test("a textual stop cannot hide an unresolved checkpoint tool call", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t);
  const pending = savedAssistant("toolUse", [
    { type: "toolCall", id: "unfinished-write", name: "write_file", arguments: { path: "fixture.txt" } }
  ]);
  const session = new PiSession({ ...connection, maxErrorRetries: 0, initialMessages: [user, pending] });
  const result = await session.run("核对恢复状态。", { resume: true });
  assert.equal(connection.requests.length, 1);
  assert.equal(result.messages.at(-1).stopReason, "stop");
  assert.deepEqual(unresolvedToolCallIds(result.messages), ["unfinished-write"]);
  assert.equal(hasCompletedAssistantResponse(result.messages), false);
  assert.equal(result.termination, "aborted");
  assert.equal(result.error, undefined);
});

test("a connection failure preserves the provider error instead of claiming an empty summary", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await new Promise((done) => server.close(done));
  const result = await new PiSession({
    baseUrl,
    apiKey: "isolated-local-fixture",
    tools: new Map(),
    supportsReasoningEffort: false,
    maxErrorRetries: 0,
    timeoutMs: 5000,
    initialMessages: [user, savedAssistant("stop")]
  }).run("核对连接恢复。");
  assert.equal(result.termination, "aborted");
  assert.equal(result.messages.at(-1).stopReason, "error");
  assert.match(result.error, /Connection error/);
  assert.notEqual(result.assistant.stopReason, "error", "visible historical text is not the failure cause");
});

test("an exhausted real provider failure remains aborted", { timeout: 10000 }, async (t) => {
  const connection = await fixture(t, { firstError: true });
  const result = await new PiSession({ ...connection, maxErrorRetries: 0 }).run("完成隔离测试任务。");
  assert.equal(connection.requests.length, 1);
  assert.equal(result.messages.at(-1).stopReason, "error");
  assert.equal(result.termination, "aborted");
  assert.match(result.error, /Synthetic transient provider failure/);
});

test(
  "an already cancelled session preserves recovery state without requesting a model or running a tool",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, { toolOnFirst: true });
    const controller = new AbortController();
    controller.abort();
    let toolRuns = 0;
    let checkpoints = 0;
    const initialMessages = [user, savedAssistant("aborted")];
    const initialSnapshot = structuredClone(initialMessages);
    const session = new PiSession({
      ...connection,
      signal: controller.signal,
      initialMessages,
      initialCompaction: {
        summary: "已确认输入，保留此前的核对记录。",
        summarizedMessageCount: 1,
        compactionCount: 2,
        lastTokensBefore: 12,
        updatedAt: "2026-10-07T00:00:00Z"
      },
      onCheckpoint: () => {
        checkpoints += 1;
      },
      tools: new Map([
        [
          "write_fixture",
          {
            parameters: { type: "object", properties: {} },
            execute: async () => {
              toolRuns += 1;
              return "模拟写入结束。";
            }
          }
        ]
      ])
    });
    const savedMessages = structuredClone(session.agent.state.messages);
    const compaction = session.compactionState;
    const result = await session.run("取消后的指令不得启动。", { resume: true });
    assert.equal(result.termination, "cancelled");
    assert.equal(connection.requests.length, 0);
    assert.equal(toolRuns, 0);
    assert.equal(checkpoints, 0);
    assert.deepEqual(result.messages, savedMessages);
    assert.deepEqual(session.agent.state.messages, savedMessages);
    assert.deepEqual(initialMessages, initialSnapshot);
    assert.deepEqual(result.compaction, compaction);
  }
);

test(
  "cancellation reaches a running tool and its settled checkpoint can resume without replaying that tool",
  { timeout: 10000 },
  async (t) => {
    const connection = await fixture(t, { toolOnFirst: true });
    const controller = new AbortController();
    let started;
    const runningTool = new Promise((resolve) => {
      started = resolve;
    });
    let toolRuns = 0;
    let toolCancelled = false;
    const tools = new Map([
      [
        "write_fixture",
        {
          parameters: { type: "object", properties: {} },
          execute: async (_input, signal) => {
            toolRuns += 1;
            started();
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  toolCancelled = true;
                  reject(new Error("模拟写入已取消。"));
                },
                { once: true }
              );
            });
          }
        }
      ]
    ]);
    const session = new PiSession({ ...connection, tools, signal: controller.signal });
    const running = session.run("执行隔离写入。 ");
    await runningTool;
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.termination, "cancelled");
    assert.equal(toolCancelled, true);
    assert.equal(toolRuns, 1);
    assert.equal(connection.requests.length, 1);
    assert.deepEqual(unresolvedToolCallIds(cancelled.messages), []);
    const saved = structuredClone(cancelled.messages);
    const resumed = await new PiSession({
      ...connection,
      tools,
      initialMessages: cancelled.messages,
      initialCompaction: cancelled.compaction
    }).run("恢复核对。", { resume: true });
    assert.equal(resumed.termination, "completed");
    assert.equal(connection.requests.length, 2);
    assert.equal(toolRuns, 1, "the settled cancelled tool must not be executed again during recovery");
    assert.deepEqual(cancelled.messages, saved, "recovery does not mutate the cancelled checkpoint");
  }
);

test("resuming a completed transcript does not request the model or repeat work", async (t) => {
  const connection = await fixture(t);
  const initialMessages = [user, savedAssistant("stop")];
  const snapshot = structuredClone(initialMessages);
  let checkpoints = 0;
  const session = new PiSession({
    ...connection,
    initialMessages,
    onCheckpoint: () => {
      checkpoints++;
    }
  });
  const restored = structuredClone(session.agent.state.messages);
  const result = await session.run("Resume the saved run", { resume: true });
  assert.equal(result.termination, "completed");
  assert.equal(connection.requests.length, 0);
  assert.equal(checkpoints, 0);
  assert.deepEqual(result.messages, restored);
  assert.deepEqual(initialMessages, snapshot);
  // A new instruction without resume still starts a new turn.
  await session.run("Do additional work");
  assert.equal(connection.requests.length, 1);
});

test("a completed response left in a running Run checkpoint finalizes without requesting a model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-completed-checkpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = await fixture(t);
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task", { goal: "Preserve completed actions" });
  const path = await store.createRun("task", "run");
  const checkpoint = new CheckpointStore(join(path, "checkpoint.json"));
  await checkpoint.save({
    runId: "run",
    sequence: 1,
    savedAt: new Date().toISOString(),
    state: {
      version: 1,
      status: "running",
      prompt: "Preserve completed actions",
      messages: [user, savedAssistant("stop")],
      compaction: emptyCompaction()
    }
  });
  const result = await new RunService(root).runPi({
    ...connection,
    taskId: "task",
    runId: "run",
    prompt: "Resume persistence",
    resume: true,
    tools: () => new Map()
  });
  assert.equal(result.taskStatus, "completed");
  assert.equal(connection.requests.length, 0);
  assert.equal((await checkpoint.load("run")).state.status, "succeeded");
  await assert.rejects(
    new RunService(root).runPi({
      ...connection,
      taskId: "task",
      runId: "run",
      prompt: "Do additional work",
      resume: true,
      tools: () => new Map()
    }),
    /already completed/
  );
  assert.equal(connection.requests.length, 0);
});

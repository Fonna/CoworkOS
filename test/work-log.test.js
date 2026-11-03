import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkLog } from "../web/assets/work-log.js";

const at = (second) => `2026-09-08T07:00:${String(second).padStart(2, "0")}Z`;
const event = (type, second, payload = {}) => ({
  eventId: type,
  type,
  callId: "a",
  runId: "run",
  occurredAt: at(second),
  payload
});
const wrap = (payload, second) => ({ type: "runtime_event", runId: "run", occurredAt: at(second), payload });

test("work log describes named delegation and returned evidence, hiding queue machinery", () => {
  const detail = {
    task: { activeRunId: "run" },
    coordination: {
      calls: [
        {
          callId: "a",
          agentId: "subagent_1",
          name: "青禾",
          task: "核对 README 的启动步骤",
          response: "发现缺少安装依赖步骤。\n[Coordinator] status=succeeded"
        }
      ]
    },
    events: [
      event("call.accepted", 1),
      event("step.queued", 2),
      event("step.leased", 3),
      event("callback.queued", 5),
      event("run.completed", 6),
      event("callback.consumed", 7)
    ]
  };
  const rows = buildWorkLog(detail);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, "已收到Ara的结果");
  assert.equal(rows[0].summary, "发现缺少安装依赖步骤。");
  assert.equal(rows[1].actor, "Ara");
  assert.equal(rows[1].agentKey, "a");
  assert.equal(rows[2].summary, "核对 README 的启动步骤");
  assert.ok(rows.every((row) => !/callback|lease|agent activity/.test(row.title + row.summary)));
});

test("tool start and end update one work item with concrete file and failure details", () => {
  const start = wrap(
    { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "docs/设计.md" } },
    1
  );
  const end = wrap(
    {
      type: "tool_execution_end",
      toolCallId: "read",
      toolName: "read",
      isError: true,
      result: { content: [{ type: "text", text: "File does not exist" }] }
    },
    2
  );
  assert.equal(buildWorkLog({ runtimeEvents: [start] })[0].status, "running");
  const rows = buildWorkLog({ runtimeEvents: [start, end, end] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "读取文件");
  assert.equal(rows[0].summary, "docs/设计.md");
  assert.equal(rows[0].status, "failed");
  assert.match(rows[0].details, /File does not exist/);
});

test("work log deduplicates SSE events and isolates the current run without mislabelling incomplete work", () => {
  const waiting = event("main.run_waiting", 5, { reason: "explicit_finish_required" });
  const detail = {
    task: { activeRunId: "run" },
    events: [waiting],
    runtimeEvents: [
      waiting,
      { ...event("main.run_completed", 6), runId: "old-run" },
      wrap(
        {
          type: "tool_execution_end",
          toolName: "finish_task",
          toolCallId: "finish",
          isError: true,
          result: {
            details: { completed: false },
            content: [{ type: "text", text: "Waiting for callbacks" }]
          }
        },
        4
      )
    ]
  };
  const rows = buildWorkLog(detail);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "waiting");
  assert.equal(rows[0].summary, "旧版本要求额外确认完成");
  assert.equal(rows[1].status, "waiting");
  assert.equal(
    rows.some((row) => row.title === "本次请求已完成"),
    false
  );
});

test("past retries and interrupted tools do not imply live work, and file previews retain useful paths", () => {
  const path = "/projects/demo/task/artifacts/结果.md";
  const rows = buildWorkLog({
    workspaceRoot: "/projects/demo",
    task: { taskId: "task", activeRunId: "run", status: "completed" },
    runtime: { active: false },
    events: [event("run.retry_scheduled", 2, { error: "Temporary failure" })],
    runtimeEvents: [
      wrap({ type: "tool_execution_start", toolCallId: "file", toolName: "read", args: { path } }, 1)
    ]
  });
  assert.equal(rows[0].title, "已安排重试");
  assert.ok(rows.every((row) => row.status !== "running"));
  assert.equal(rows[1].summary, "artifacts/结果.md");
  assert.match(rows[1].details, /\/projects\/demo\/task\/artifacts\/结果.md/);
  assert.equal(rows[1].status, "interrupted");
});

test("command work items show script intent and measured duration without reporting a generated artifact", () => {
  const arguments_ = { command: "python3 agents/main/work/create_harness_ppt.py", timeout: 120 };
  const start = wrap(
    { type: "tool_execution_start", toolCallId: "script", toolName: "bash", args: arguments_ },
    1
  );
  const end = wrap(
    {
      type: "tool_execution_end",
      toolCallId: "script",
      toolName: "bash",
      result: { details: { exitCode: 0, stdout: "", stderr: "" } }
    },
    3
  );
  const [row] = buildWorkLog({ runtimeEvents: [start, end] });
  assert.equal(row.title, "运行 Python 脚本");
  assert.equal(row.summary, "create_harness_ppt.py");
  assert.equal(row.resultSummary, "命令执行完成");
  assert.equal(row.durationMs, 2000);
  assert.equal(row.durationLabel, "2.0 秒");
  assert.match(row.details, /python3 agents\/main\/work\/create_harness_ppt\.py/);
  assert.match(row.details, /"timeout": 120/);
  assert.doesNotMatch(row.summary, /command=|timeout=|生成成功/);
});

test("failed command work items retain actual stderr while refusing an invented timeout diagnosis", () => {
  const stderr =
    "python3: can't open file '/synthetic/agents/main/work/create_harness_ppt.py': [Errno 2] No such file or directory";
  const start = wrap(
    {
      type: "tool_execution_start",
      toolCallId: "script",
      toolName: "bash",
      args: { command: "python3 agents/main/work/create_harness_ppt.py", timeout: 120 }
    },
    1
  );
  const end = wrap(
    {
      type: "tool_execution_end",
      toolCallId: "script",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: stderr + "\nCommand exited with code 2" }] }
    },
    2
  );
  const [row] = buildWorkLog({ runtimeEvents: [start, end] });
  assert.equal(row.status, "failed");
  assert.equal(row.failureReason, "文件或目录不存在");
  assert.match(row.details, /Command exited with code 2/);
  assert.doesNotMatch(row.failureReason, /超时|120/);
});

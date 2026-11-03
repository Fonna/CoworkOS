import assert from "node:assert/strict";
import { test } from "node:test";
import {
  subagentRecoverySummary,
  MAX_SUBAGENT_RECOVERY_CHARS
} from "../dist/src/runtime/subagent-recovery-summary.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};
const assistant = (content, stopReason = "toolUse") => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "isolated-fixture",
  model: "recovery-summary-fixture",
  usage,
  stopReason,
  timestamp: 2
});
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name, details, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: JSON.stringify(details) }],
  details,
  isError,
  timestamp: 3
});
const operation = (id, name, args, details, isError = false) => [
  assistant([call(id, name, args)]),
  result(id, name, details, isError)
];

test("recovery summaries omit empty histories and histories without usable progress", () => {
  assert.equal(subagentRecoverySummary([]), "");
  assert.equal(
    subagentRecoverySummary([
      { role: "user", content: "PRIVATE_USER_REQUIREMENT", timestamp: 1 },
      assistant([{ type: "thinking", thinking: "PRIVATE_REASONING" }], "aborted")
    ]),
    ""
  );
});

test("recovery summaries identify the latest visible statements as partial evidence", () => {
  const summary = subagentRecoverySummary([
    assistant([{ type: "text", text: "OLD_VISIBLE_STATEMENT" }]),
    assistant([
      { type: "thinking", thinking: "PRIVATE_REASONING" },
      { type: "text", text: "FOUND_BOUNDARY_BUG in parser.js; validation is pending." }
    ]),
    assistant([{ type: "text", text: "LATEST_VISIBLE_STATEMENT: next check is a boundary test." }], "aborted")
  ]);
  assert.match(summary, /FOUND_BOUNDARY_BUG/);
  assert.match(summary, /LATEST_VISIBLE_STATEMENT/);
  assert.doesNotMatch(summary, /OLD_VISIBLE_STATEMENT|PRIVATE_REASONING/);
  assert.match(summary, /assistant|statement|unverified/i);
  assert.match(summary, /partial|incomplete|not.{0,30}(?:final|verified|success)/i);
});

test("a reused tool ID cannot apply an earlier result to a later unresolved operation", () => {
  const messages = operation(
    "reused-id",
    "run_command",
    { command: "previous-command" },
    { exitCode: 23, stdout: "OLD_RESULT_MUST_NOT_SETTLE_NEW_CALL", stderr: "" },
    true
  );
  for (let i = 0; i < 4; i += 1) {
    messages.push(
      ...operation(
        `filler-${i}`,
        "read_file",
        { path: `filler-${i}.txt` },
        { path: `filler-${i}.txt`, content: "not needed" }
      )
    );
  }
  messages.push(assistant([call("reused-id", "run_command", { command: "new-unresolved-command" })]));
  const summary = subagentRecoverySummary(messages);
  assert.match(summary, /new-unresolved-command/);
  assert.match(summary, /completion unknown/i);
  assert.doesNotMatch(summary, /OLD_RESULT_MUST_NOT_SETTLE_NEW_CALL|previous-command/);
  assert.doesNotMatch(summary, /(?:exitCode|exit code)["\s:=]*23/i);
});

test("an orphan result cannot prove completion of a subsequent call with the same ID", () => {
  const summary = subagentRecoverySummary([
    result("same-id", "run_command", { exitCode: 0, stdout: "ORPHAN_RESULT", stderr: "" }),
    assistant([call("same-id", "run_command", { command: "pending-side-effect" })])
  ]);
  assert.match(summary, /pending-side-effect/);
  assert.match(summary, /completion unknown/i);
  assert.doesNotMatch(summary, /ORPHAN_RESULT/);
  assert.doesNotMatch(summary, /(?:exitCode|exit code)["\s:=]*0/i);
});

test("an interrupted call with missing arguments still yields a recovery handoff", () => {
  const summary = subagentRecoverySummary([assistant([call("partial-call", "write_file", null)])]);
  assert.match(summary, /write_file/);
  assert.match(summary, /completion unknown/i);
});

test("recovery summaries exclude private reasoning, user input, images and file bodies", () => {
  const messages = [
    { role: "user", content: "PRIVATE_USER_INPUT", timestamp: 1 },
    assistant([
      { type: "thinking", thinking: "PRIVATE_REASONING" },
      { type: "text", text: "Inspected the parser boundary; verification remains pending." }
    ]),
    ...operation(
      "write",
      "write_file",
      { path: "parser.js", content: "PRIVATE_WRITTEN_BODY" },
      { path: "parser.js", bytes: 20, changed: true }
    ),
    ...operation(
      "patch",
      "apply_patch",
      { path: "boundary.js", oldText: "PRIVATE_OLD_PATCH_BODY", newText: "PRIVATE_NEW_PATCH_BODY" },
      { path: "boundary.js", changed: true }
    ),
    ...operation(
      "read",
      "read_file",
      { path: "fixture.json" },
      { path: "fixture.json", content: "PRIVATE_READ_FILE_BODY" }
    ),
    assistant([call("image", "capture_image", { target: "preview" })]),
    {
      role: "toolResult",
      toolCallId: "image",
      toolName: "capture_image",
      content: [{ type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BINARY" }],
      details: { image: "PRIVATE_IMAGE_DETAILS" },
      isError: false,
      timestamp: 3
    }
  ];
  const summary = subagentRecoverySummary(messages);
  assert.match(summary, /parser\.js/);
  assert.match(summary, /boundary\.js/);
  assert.match(summary, /fixture\.json/);
  assert.match(summary, /read_file/);
  assert.doesNotMatch(summary, /PRIVATE_/);
});

test("failed file receipts retain the error without copying file bodies or claiming a confirmed change", () => {
  const summary = subagentRecoverySummary([
    ...operation(
      "denied-read",
      "read_file",
      { path: "denied.json" },
      { path: "denied.json", content: "PRIVATE_FAILED_READ_BODY", error: "permission denied" },
      true
    ),
    ...operation(
      "denied-patch",
      "apply_patch",
      { path: "denied-patch.js", oldText: "PRIVATE_OLD_TEXT", newText: "PRIVATE_NEW_TEXT" },
      {
        path: "denied-patch.js",
        oldText: "PRIVATE_OLD_RECEIPT",
        newText: "PRIVATE_NEW_RECEIPT",
        changed: true,
        error: "patch rejected"
      },
      true
    )
  ]);
  assert.match(summary, /permission denied/);
  assert.match(summary, /patch rejected/);
  assert.doesNotMatch(summary, /PRIVATE_/);
  assert.doesNotMatch(summary, /Recorded file changes/i);
});

test("command evidence preserves structured status and both output tails without claiming test success", () => {
  const summary = subagentRecoverySummary(
    operation(
      "failing-check",
      "run_command",
      { command: "pytest", args: ["tests/test_boundary.py"], cwd: "/isolated/project" },
      {
        exitCode: 1,
        stdout: `STDOUT_HEAD\n${"o".repeat(10000)}\nSTDOUT_TAIL: 1 failed, 3 passed`,
        stderr: `STDERR_HEAD\n${"e".repeat(10000)}\nSTDERR_TAIL: boundary assertion failed`
      },
      true
    )
  );
  assert.match(summary, /run_command/);
  assert.match(summary, /pytest/);
  assert.match(summary, /test_boundary\.py/);
  assert.match(summary, /(?:exitCode|exit code)["\s:=]*1/i);
  assert.match(summary, /STDOUT_HEAD/);
  assert.match(summary, /STDOUT_TAIL: 1 failed, 3 passed/);
  assert.match(summary, /STDERR_HEAD/);
  assert.match(summary, /STDERR_TAIL: boundary assertion failed/);
  assert.match(summary, /error|failed/i);
  assert.doesNotMatch(summary, /tests passed|all tests.{0,20}pass/i);
});

test("content-only JSON command receipts remain structured when an older adapter leaves details empty", () => {
  const receipt = result("legacy-command", "run_command", {
    exitCode: 5,
    stdout: `LEGACY_STDOUT_HEAD\n${"o".repeat(10000)}\nLEGACY_STDOUT_TAIL`,
    stderr: `LEGACY_STDERR_HEAD\n${"e".repeat(10000)}\nLEGACY_STDERR_TAIL`
  });
  receipt.details = {};
  const summary = subagentRecoverySummary([
    assistant([call("legacy-command", "run_command", { command: "legacy-checker" })]),
    receipt
  ]);
  assert.match(summary, /(?:exitCode|exit code)["\s:=]*5/i);
  assert.match(summary, /LEGACY_STDOUT_TAIL/);
  assert.match(summary, /LEGACY_STDERR_TAIL/);
  assert.match(summary, /error|failed/i);
  assert.ok(summary.length <= MAX_SUBAGENT_RECOVERY_CHARS);
});

test("all four recent long commands preserve both output tails within the shared recovery budget", () => {
  const messages = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push(
      ...operation(
        `saved-change-${i}`,
        "write_file",
        { path: `changed-${i}-${"p".repeat(150)}.js`, content: "PRIVATE_WRITTEN_BODY" },
        { path: `changed-${i}-${"p".repeat(150)}.js`, changed: true, bytes: 42 }
      )
    );
  }
  messages.push(
    assistant([{ type: "text", text: `PARTIAL_FINDING_ONE ${"s".repeat(5000)}` }]),
    assistant([{ type: "text", text: `PARTIAL_FINDING_TWO ${"s".repeat(5000)}` }])
  );
  for (let i = 0; i < 4; i += 1) {
    messages.push(
      ...operation(
        `long-command-${i}`,
        "run_command",
        {
          command: `checker-${i} ${"c".repeat(5000)}`,
          args: Array.from({ length: 12 }, (_, n) => `arg-${n}-${"a".repeat(1000)}`),
          cwd: `/isolated/${"d".repeat(1000)}`
        },
        {
          exitCode: 1,
          cancelled: true,
          timedOut: false,
          signal: `SIGTERM-${"g".repeat(1000)}`,
          stdout: `STDOUT_HEAD_${i}\n${"o".repeat(10000)}\nSTDOUT_TAIL_${i}`,
          stderr: `STDERR_HEAD_${i}\n${"e".repeat(10000)}\nSTDERR_TAIL_${i}`
        },
        true
      )
    );
  }
  for (let i = 0; i < 2; i += 1) {
    messages.push(
      assistant([call(`unknown-${i}`, "run_command", { command: `pending-${i}-${"u".repeat(1000)}` })])
    );
  }
  const summary = subagentRecoverySummary(messages);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(summary.includes(`STDOUT_TAIL_${i}`), `stdout tail missing for command ${i}`);
    assert.ok(summary.includes(`STDERR_TAIL_${i}`), `stderr tail missing for command ${i}`);
  }
  assert.match(summary, /completion unknown/i);
  assert.ok(summary.length <= MAX_SUBAGENT_RECOVERY_CHARS);
  assert.doesNotMatch(summary, /PRIVATE_/);
});

test("very large recovery evidence has a hard total bound and visible omission markers", () => {
  const messages = [
    assistant([{ type: "text", text: `FIRST_VISIBLE_HEAD${"a".repeat(40000)}FIRST_VISIBLE_TAIL` }]),
    assistant([{ type: "text", text: `SECOND_VISIBLE_HEAD${"b".repeat(40000)}SECOND_VISIBLE_TAIL` }])
  ];
  for (let i = 0; i < 12; i += 1) {
    messages.push(
      ...operation(
        `huge-${i}`,
        "run_command",
        { command: `checker-${i}`, args: ["c".repeat(40000)] },
        { exitCode: 1, stdout: "d".repeat(40000), stderr: `FAILURE_TAIL_${i}` },
        true
      )
    );
  }
  const summary = subagentRecoverySummary(messages);
  assert.ok(MAX_SUBAGENT_RECOVERY_CHARS > 0 && MAX_SUBAGENT_RECOVERY_CHARS <= 6000);
  assert.ok(summary.length <= MAX_SUBAGENT_RECOVERY_CHARS);
  assert.match(summary, /truncated|omitted/i);
  assert.match(summary, /checker-11/);
});

test("the six latest confirmed file changes survive later read-only operations", () => {
  const messages = [];
  for (let i = 0; i < 8; i += 1) {
    const path = `mutation-${String(i).padStart(2, "0")}.py`;
    messages.push(
      ...operation(
        `mutation-${i}`,
        i % 2 === 0 ? "write_file" : "apply_patch",
        {
          path,
          ...(i % 2 === 0
            ? { content: "PRIVATE_MUTATION_BODY" }
            : { oldText: "PRIVATE_OLD_PATCH", newText: "PRIVATE_NEW_PATCH" })
        },
        { path, changed: true, bytes: 42 }
      )
    );
  }
  for (let i = 0; i < 7; i += 1) {
    const path = `recent-read-${i}.md`;
    messages.push(...operation(`read-${i}`, "read_file", { path }, { path, content: "PRIVATE_READ_BODY" }));
  }
  const summary = subagentRecoverySummary(messages);
  for (let i = 2; i < 8; i += 1) assert.ok(summary.includes(`mutation-${String(i).padStart(2, "0")}.py`));
  assert.doesNotMatch(summary, /mutation-00\.py|mutation-01\.py/);
  assert.match(summary, /recent-read-6\.md/);
  assert.doesNotMatch(summary, /PRIVATE_/);
  assert.ok(summary.length <= MAX_SUBAGENT_RECOVERY_CHARS);
});

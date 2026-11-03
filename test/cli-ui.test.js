import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const uiPath = resolve(".pi/runtime/cli-ui.ts");
const { createCliPresentation, delegationResultText, delegationRenderers } = await jiti.import(uiPath);
const { registerSearchTools } = await jiti.import(resolve(".pi/runtime/tools/file-search.ts"));
const theme = { fg: (_kind, value) => value, bold: (value) => value };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-ui-Pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.1" }));
  return root;
}

test("TUI header uses CoworkOS and keeps diagnostics explicit while headless clients stay untouched", async (t) => {
  const root = await fixture(t);
  const previous = process.env.ATRIA_DEBUG;
  delete process.env.ATRIA_DEBUG;
  t.after(() =>
    previous === undefined ? delete process.env.ATRIA_DEBUG : (process.env.ATRIA_DEBUG = previous)
  );
  const commands = new Map();
  const presentation = createCliPresentation(
    { registerCommand: (name, command) => commands.set(name, command) },
    { harnessRoot: root, projectDirectory: join(root, "my-project") }
  );
  const notifications = [];
  let title, header;
  const ctx = {
    mode: "tui",
    ui: {
      setTitle: (value) => (title = value),
      setHeader: (factory) => (header = factory({}, theme)),
      notify: (value) => notifications.push(value)
    }
  };
  presentation.configure(ctx);
  assert.equal(title, "CoworkOS — my-project");
  const rendered = header.render(140);
  const lines = rendered.join("\n");
  assert.match(lines, /CoworkOS v0\.1\.1/);
  assert.match(lines, /my-project/);
  // The project path is user data and may legitimately contain "Pi". Check
  // branding and diagnostics independently of the path displayed in row two.
  assert.match(rendered[1].trim(), /^项目：/);
  assert.doesNotMatch(
    [rendered[0], ...rendered.slice(2)].join("\n"),
    /Pi|workspace=|Evaluation|active tools/
  );
  const diagnostics = {
    workspaceRoot: join(root, "private-workspace"),
    taskId: "task-fixture",
    mainRunId: "run-fixture",
    modelId: "fixture",
    supervisor: "external",
    tools: ["read", "call_subagent"],
    guessedProtection: true,
    protectedPaths: ["eval/**"]
  };
  assert.equal(presentation.startup(ctx, diagnostics), true);
  assert.deepEqual(notifications, []);
  await commands.get("atria-debug").handler("on", ctx);
  assert.match(notifications[0], /workspace=.*private-workspace/);
  assert.match(notifications[0], /active tools: read, call_subagent/);
  assert.match(notifications[0], /COWORK_EVAL_PATHS/);
  assert.equal(presentation.debug(), true);
  await commands.get("atria-debug").handler("off", ctx);
  assert.equal(presentation.debug(), false);
  for (const mode of ["print", "rpc", "json"]) {
    assert.doesNotThrow(() => presentation.configure({ mode, ui: {} }));
    assert.equal(presentation.startup({ mode, ui: {} }, diagnostics), false);
  }
});

test("delegation display keeps answers and failure reasons while expanding preserves raw diagnostics", () => {
  const original = {
    status: "failed",
    response: "检查没有通过。",
    error: "测试进程退出 1",
    callId: "private-call-id",
    diagnostics: { tracePath: "sessions/trace.jsonl", resultPath: "runs/result.json" },
    outputFiles: ["deliverables/report.md"]
  };
  const result = { content: [{ type: "text", text: JSON.stringify(original) }], details: original };
  const before = JSON.stringify(result);
  const compact = delegationResultText(result, { expanded: false, isPartial: false });
  assert.match(compact, /子任务失败/);
  assert.match(compact, /检查没有通过/);
  assert.match(compact, /测试进程退出 1/);
  assert.match(compact, /产出文件：1 个/);
  assert.doesNotMatch(compact, /private-call-id|sessions\/trace|runs\/result/);
  for (const [expanded, debug] of [
    [true, false],
    [false, true]
  ]) {
    assert.equal(delegationResultText(result, { expanded, isPartial: false }, debug), result.content[0].text);
  }
  assert.equal(JSON.stringify(result), before);
  const component = delegationRenderers(() => false).renderResult(
    result,
    { expanded: false, isPartial: false },
    theme
  );
  assert.match(component.render(100).join("\n"), /测试进程退出 1/);
  assert.match(
    delegationResultText(
      { content: [], details: { accepted: true, name: "Amber", callId: "private-id" } },
      { expanded: false, isPartial: false }
    ),
    /Amber.*子任务已接受/
  );
});

test("real Coordinator suffix is hidden only when it matches structured runtime evidence", async (t) => {
  const root = await fixture(t);
  const taskId = "ui-task",
    runId = "ui-run",
    agentId = "checker";
  await new LocalWorkspaceStore(root).createTask(taskId, { goal: "Verify display metadata" });
  const originalRun = PiSession.prototype.run;
  PiSession.prototype.run = async function () {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "已完成检查。正文提到了 [Coordinator] status=succeeded，保留它。" }],
      stopReason: "stop",
      timestamp: Date.now()
    };
    this.agent.state.messages = [message];
    const output = join(root, taskId, "agents/subagents", agentId, "deliverables");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "report.txt"), "Verified output");
    return {
      assistant: message,
      messages: [message],
      compaction: this.compactionState,
      termination: "completed"
    };
  };
  t.after(() => (PiSession.prototype.run = originalRun));
  const details = await new CoordinatorRuntime().dispatch({
    taskId,
    runId,
    agentId,
    task: "Perform an independent check",
    mode: "sync",
    workspaceRoot: root,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-key",
    maxAttempts: 1,
    skillRoots: [],
    toolFactory: () => new Map()
  });
  assert.match(details.response, /Diagnostics \(Task-relative\)/);
  assert.equal(details.outputFiles.length, 1);
  const result = { content: [{ type: "text", text: JSON.stringify(details) }], details };
  const compact = delegationResultText(result, { expanded: false, isPartial: false });
  assert.match(compact, /正文提到了 \[Coordinator\] status=succeeded，保留它/);
  assert.doesNotMatch(compact, /Diagnostics \(Task-relative\)|Candidate outputs|trace=|result=/);
  assert.match(
    delegationResultText(result, { expanded: true, isPartial: false }),
    /Diagnostics \(Task-relative\)/
  );
  const mismatched = {
    ...details,
    diagnostics: { ...details.diagnostics, tracePath: "different-trace.jsonl" }
  };
  assert.match(
    delegationResultText({ ...result, details: mismatched }, { expanded: false, isPartial: false }),
    /Diagnostics \(Task-relative\)/
  );
});

test("Pi validation errors keep their reason without classifying ordinary answer text as an error", () => {
  const reason = "Tool parameter validation failed: task is required";
  const native = { content: [{ type: "text", text: reason }] };
  const before = JSON.stringify(native);
  const renderers = delegationRenderers(() => false);
  const visible = renderers
    .renderResult(native, { expanded: false, isPartial: false }, theme, { isError: true })
    .render(120)
    .join("\n");
  assert.match(visible, /子任务失败/);
  assert.ok(visible.includes(reason));
  assert.equal(JSON.stringify(native), before);
  assert.ok(
    delegationResultText({ ...native, isError: true }, { expanded: false, isPartial: false }).includes(reason)
  );
  assert.equal(
    delegationResultText({ ...native, isError: true }, { expanded: true, isPartial: false }),
    reason
  );
  const response = "这份文档中的 error=example 只是示例文字，检查已通过。";
  const success = {
    content: [{ type: "text", text: JSON.stringify({ status: "succeeded", response }) }],
    details: { status: "succeeded", response }
  };
  const output = renderers
    .renderResult(success, { expanded: false, isPartial: false }, theme, { isError: false })
    .render(120)
    .join("\n");
  assert.match(output, /子任务完成/);
  assert.ok(output.includes(response));
  assert.doesNotMatch(output, /子任务失败/);
});

test("registered find and grep run offline with actual ignore rules and truthful search limits", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "hello.txt"), "Hello from CoworkOS CLI.\nSecond turn.\n");
  await writeFile(join(root, "ignored.txt"), "Hello hidden\n");
  const tools = new Map();
  registerSearchTools({ registerTool: (tool) => tools.set(tool.name, tool) }, root);
  const context = { cwd: root };
  const found = await tools.get("find").execute("find", { pattern: "*.txt" }, undefined, undefined, context);
  assert.equal(found.content[0].text, "hello.txt");
  const match = await tools
    .get("grep")
    .execute("grep", { pattern: "Hello", glob: "*.txt" }, undefined, undefined, context);
  assert.match(match.content[0].text, /hello\.txt:1: Hello from CoworkOS CLI\./);
  assert.doesNotMatch(match.content[0].text, /ignored/);
  await writeFile(join(root, "second.txt"), "second\n");
  const limited = await tools
    .get("find")
    .execute("limit", { pattern: "*.txt", limit: 1 }, undefined, undefined, context);
  assert.equal(limited.details.resultLimitReached, 1);
  assert.match(limited.content[0].text, /1 results limit reached/);
  await assert.rejects(
    tools.get("grep").execute("invalid", { pattern: "(" }, undefined, undefined, context),
    /Invalid regular expression/
  );
  await writeFile(join(root, "long.txt"), `Hello ${"x".repeat(1200)}\n`);
  const long = await tools
    .get("grep")
    .execute("long", { pattern: "Hello", glob: "long.txt" }, undefined, undefined, context);
  assert.equal(long.details.linesTruncated, true);
  assert.match(long.content[0].text, /1000 chars/);
  assert.equal(long.details.matchLimitReached, undefined);
});

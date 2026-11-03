import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { resolveCapabilities } from "../dist/src/runtime/task-capabilities.js";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-command-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    tools: createBuiltinTools({
      rootDirectory: root,
      commandTimeoutMs: 2_000,
      capabilities: resolveCapabilities(undefined, {}),
      ...options
    })
  };
}

test("default commands finish after large output and return previews plus complete logs", async (t) => {
  const { root, tools } = await fixture(t);
  const output = "COMMAND_HEAD\n" + "middle-data ".repeat(20_000) + "\nCOMMAND_TAIL\n";
  const result = await tools.get("run_command").execute({
    command: process.execPath,
    args: [
      "-e",
      `require('fs').writeSync(1,${JSON.stringify(output)});setTimeout(()=>require('fs').writeFileSync('DONE','done'),100)`
    ]
  });
  assert.equal(result.failed, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(join(root, "DONE"), "utf8"), "done");
  assert.ok(Buffer.byteLength(result.stdout) <= 8_000);
  assert.match(result.stdout, /COMMAND_HEAD/);
  assert.match(result.stdout, /COMMAND_TAIL/);
  assert.match(result.stdout, /truncated|omitted/i);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdoutBytes, Buffer.byteLength(output));
  assert.equal(result.stdoutLogBytes, Buffer.byteLength(output));
  assert.equal(isAbsolute(result.stdoutPath), false);
  assert.equal(await readFile(join(root, result.stdoutPath), "utf8"), output);
  assert.equal(await readFile(join(root, result.stderrPath), "utf8"), "");
  assert.equal(result.logLimitExceeded, undefined);
});

test("failed commands keep both stream tails and durable failure evidence", async (t) => {
  const { root, tools } = await fixture(t);
  const stdout = "OUT_HEAD\n" + "out ".repeat(10_000) + "\nOUT_TAIL";
  const stderr = "ERR_HEAD\n" + "err ".repeat(10_000) + "\n4 failed, 1413 passed\nERR_TAIL";
  const result = await tools.get("run_tests").execute({
    command: process.execPath,
    args: [
      "-e",
      `require('fs').writeSync(1,${JSON.stringify(stdout)});require('fs').writeSync(2,${JSON.stringify(stderr)});process.exit(7)`
    ]
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.failed, true);
  assert.equal(result.isError, true);
  assert.match(result.stdout, /OUT_HEAD/);
  assert.match(result.stdout, /OUT_TAIL/);
  assert.match(result.stderr, /ERR_HEAD/);
  assert.match(result.stderr, /4 failed, 1413 passed/);
  assert.match(result.stderr, /ERR_TAIL/);
  assert.ok(Buffer.byteLength(result.stdout) <= 8_000);
  assert.ok(Buffer.byteLength(result.stderr) <= 8_000);
  assert.equal(await readFile(join(root, result.stdoutPath), "utf8"), stdout);
  assert.equal(await readFile(join(root, result.stderrPath), "utf8"), stderr);
});

test("command log paths remain readable when Task, Agent and project roots differ", async (t) => {
  const { root } = await fixture(t);
  const task = join(root, "task");
  const agent = join(task, "agents", "subagents", "agent-1");
  const project = join(root, "project");
  await mkdir(agent, { recursive: true });
  await mkdir(project);
  await writeFile(join(project, "fixture.cjs"), "console.log('PROJECT_LOG_EVIDENCE');");
  const tools = createBuiltinTools({
    rootDirectory: agent,
    workspaceDirectory: task,
    projectDirectory: project,
    allowProjectWrites: true,
    capabilities: resolveCapabilities({ projectWrite: true, shell: true }, {})
  });
  const result = await tools.get("run_command").execute({ command: process.execPath, args: ["fixture.cjs"] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, project);
  assert.match(result.stdoutPath, /^agents\/subagents\/agent-1\/logs\/commands\//);
  const page = await tools
    .get("browse_workspace")
    .execute({ mode: "read", path: result.stdoutPath, offset: 0 });
  assert.match(page.content, /PROJECT_LOG_EVIDENCE/);
  const direct = await tools.get("read_file").execute({ path: result.stdoutReadPath });
  assert.match(direct.content, /PROJECT_LOG_EVIDENCE/);
});

test("a command hard log cap remains a failure independently of its preview budget", async (t) => {
  const { root, tools } = await fixture(t, { commandMaxLogBytes: 256, commandPreviewBytes: 64 });
  const result = await tools.get("run_command").execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2048));setInterval(()=>{},1000)"]
  });
  assert.equal(result.failed, true);
  assert.equal(result.isError, true);
  assert.equal(result.logLimitExceeded, true);
  assert.equal(result.timedOut, undefined);
  assert.ok(Buffer.byteLength(result.stdout) <= 64);
  assert.ok((await readFile(join(root, result.stdoutPath))).length <= 256);
  assert.equal(result.stdoutLogBytes, 256);
  assert.ok(result.stdoutBytes > result.stdoutLogBytes);
});

test("new command capture budgets reject invalid configuration before executing anything", async (t) => {
  const { root } = await fixture(t);
  for (const option of ["commandMaxLogBytes", "commandPreviewBytes"]) {
    for (const value of [0, -1, 0.5, NaN, Infinity]) {
      assert.throws(
        () => createBuiltinTools({ rootDirectory: root, [option]: value }),
        /positive|integer|budget/i
      );
    }
  }
});

test("synthetic command errors obey the preview byte budget without losing their diagnostic", async (t) => {
  const { tools } = await fixture(t, { commandPreviewBytes: 1 });
  const result = await tools.get("run_command").execute({
    command: process.execPath,
    args: ["-e", "process.exit(3)"]
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.failed, true);
  assert.ok(Buffer.byteLength(result.stderr) <= 1);
  assert.match(result.error, /Command failed/);
  assert.equal(result.stderrBytes, 0);
});

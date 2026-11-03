import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CoordinatorRuntime } from "../dist/src/runtime/coordinator-runtime.js";
import { createBuiltinTools } from "../dist/src/tools/builtin.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

test(
  "explicit Subagent cancellation reaches its real command tree while the coordinator remains usable",
  {
    skip: process.platform === "win32",
    timeout: 15000
  },
  async (t) => {
    const inherited = process.env;
    process.env = Object.fromEntries(
      Object.entries(inherited).filter(
        ([name]) => !/^(?:COWORK_|PI_|SERPER_|(?:HTTP|HTTPS|ALL|NO)_PROXY$)/i.test(name)
      )
    );
    const root = await mkdtemp(join(tmpdir(), "atria-subagent-command-cancel-"));
    const coordinator = new CoordinatorRuntime();
    const worker = `const fs=require('node:fs');process.on('SIGTERM',()=>{});
    fs.writeFileSync('worker.pid',String(process.pid));
    const tick=()=>fs.writeFileSync('ticks.txt',String(Date.now()));tick();setInterval(tick,10);`;
    const wrapper = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});
    process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const model = await modelProtocolFixture("openai-completions", async (body) => {
      if (JSON.stringify(body.messages).includes("SHORT_NEXT_DELEGATION"))
        return { text: "next delegation completed" };
      return { name: "run_command", arguments: { command: process.execPath, args: ["-e", wrapper] } };
    });
    let running, pid;
    const identity = { workspaceRoot: root, taskId: "task", runId: "main-run", callId: "cancel-target" };
    t.after(async () => {
      await coordinator.cancelSubagent(identity).catch(() => {});
      await running?.catch(() => {});
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await model.close();
      await rm(root, { recursive: true, force: true });
      process.env = inherited;
    });
    const connection = {
      api: "openai-completions",
      baseUrl: model.baseUrl,
      apiKey: "isolated-local-fixture",
      model: "protocol-fixture",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      supportsImages: false,
      maxAttempts: 1,
      maxErrorRetries: 0,
      maxTurns: 2,
      timeoutMs: 10000,
      skillRoots: [],
      questionTimeoutMs: 0
    };
    running = coordinator.dispatch({
      ...identity,
      ...connection,
      agentId: "worker-a",
      task: "run the fixture worker",
      mode: "async",
      toolFactory: (workingDirectory) =>
        createBuiltinTools({ rootDirectory: workingDirectory, commandTimeoutMs: 0 })
    });
    const work = join(root, "task", "agents", "subagents", "worker-a");
    for (let i = 0; i < 300 && !pid; i++) {
      try {
        pid = Number(await readFile(join(work, "worker.pid"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(10);
      }
    }
    assert.ok(pid, "the real Pi tool must start the worker before cancellation");
    const cancelled = await coordinator.cancelSubagent(identity);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await running).status, "cancelled");
    await delay(50);
    const ticks = await readFile(join(work, "ticks.txt"), "utf8");
    await delay(150);
    assert.equal(
      await readFile(join(work, "ticks.txt"), "utf8"),
      ticks,
      "the cancelled worker must stop writing"
    );
    const next = await coordinator.dispatch({
      ...identity,
      ...connection,
      callId: "next-call",
      agentId: "worker-b",
      task: "SHORT_NEXT_DELEGATION",
      mode: "sync",
      toolFactory: () => new Map()
    });
    assert.equal(next.status, "succeeded");
    assert.match(next.response, /next delegation completed/);
  }
);

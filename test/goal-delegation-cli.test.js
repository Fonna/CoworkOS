import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { protocolStream } from "./model-protocol-fixture.mjs";

test(
  "a later CLI user request can create an independent collector on the same Run",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-goal-cli-"));
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const timer = {
      template: "timer",
      task: "Independent meeting reminder",
      cadenceSeconds: 60,
      scope: "session",
      config: { startAt: new Date(Date.now() + 3600000).toISOString() }
    };
    const replies = [
      { name: "enable_tools", arguments: { groups: ["monitors"] } },
      {
        name: "manage_goal",
        arguments: {
          action: "create",
          scope: "background",
          brief: { title: "Training", objective: "Follow training until completion" }
        }
      },
      { name: "create_watcher", arguments: timer },
      { text: "The training goal is registered." },
      { name: "create_watcher", arguments: timer },
      { text: "The independent reminder is registered." }
    ];
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the actual Pi provider request before responding.
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(protocolStream("openai-completions", replies[requests++] ?? { text: "Done." }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(COWORK_|PI_|ATRIA_|SERPER_|OPENAI_|ANTHROPIC_)/.test(name)
      )
    );
    Object.assign(env, {
      ATRIA_HOME: join(root, "user"),
      COWORK_HARNESS_ROOT: resolve("."),
      COWORK_CONFIG: join(root, "config.json"),
      COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
      COWORK_MODEL: "fixture",
      COWORK_MODEL_API: "openai-completions",
      COWORK_API_KEY: "isolated-fixture",
      COWORK_TASK_ID: "cli-chat",
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      COWORK_WEB_TOOLS: "0",
      PI_OFFLINE: "1"
    });
    const child = spawn(process.execPath, [resolve("scripts/atria.mjs"), "--mode", "rpc"], {
      cwd: project,
      env,
      stdio: "pipe"
    });
    const closed = once(child, "close");
    t.after(async () => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      await closed;
      clearTimeout(force);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const rows = [];
    let pending = "",
      stderr = "",
      parseError;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines.filter(Boolean)) {
        try {
          rows.push(JSON.parse(line));
        } catch (error) {
          parseError = error;
        }
      }
    });
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 20000;
      while (!(await predicate())) {
        assert.equal(parseError, undefined, "CLI RPC stdout must stay JSONL");
        if (Date.now() > deadline || child.exitCode !== null)
          assert.fail(`Timed out waiting for ${label}: ${stderr}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    };
    const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
    const task = async () =>
      JSON.parse(await readFile(join(root, "user", "workspace", "cli-chat", "task.json"), "utf8"));
    const results = () => rows.filter((row) => row.type === "tool_execution_end");
    send({ id: "ready", type: "get_state" });
    await wait(() => rows.some((row) => row.id === "ready" && row.success), "CLI readiness");
    send({ id: "first", type: "prompt", message: "Register a background goal to follow training." });
    await wait(async () => {
      try {
        return requests >= 4 && (await task()).status === "completed";
      } catch {
        return false;
      }
    }, "first request completion");
    const firstTask = await task();
    assert.equal(results().find((row) => row.toolName === "manage_goal").isError, false);
    const fallback = results().find((row) => row.toolName === "create_watcher");
    assert.equal(fallback.isError, true);
    assert.match(fallback.result.content[0].text, /交接/);
    send({
      id: "second",
      type: "prompt",
      message: "Separate request: set a meeting reminder in one hour in this session."
    });
    await wait(
      () => results().filter((row) => row.toolName === "create_watcher").length === 2,
      "new collector"
    );
    const independent = results()
      .filter((row) => row.toolName === "create_watcher")
      .at(-1);
    assert.equal(independent.isError, false, JSON.stringify(independent.result));
    assert.equal(independent.result.details.activated, true);
    assert.equal((await task()).activeRunId, firstTask.activeRunId);
  }
);

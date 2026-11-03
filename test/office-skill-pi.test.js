import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test(
  "real Main loads Office script paths and executes the backend check from a different project",
  { timeout: 45_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-office-skill-"));
    const project = join(root, "project"),
      workspace = join(root, "workspace");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("office-task", { goal: "检查 Office 文档后端" });
    await store.createRun("office-task", "office-run");
    let requests = 0,
      child,
      output = "";
    const failures = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      const step = ++requests;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `office-${step}`, object: "chat.completion.chunk", created: 1, model: "office-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      const call = (name, args) => {
        send({
          tool_calls: [
            {
              index: 0,
              id: `office-call-${step}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        });
        send({}, "tool_calls");
      };
      send({ role: "assistant" });
      try {
        if (step === 1) {
          assert.ok(request.tools.some((tool) => tool.function.name === "load_skill"));
          assert.ok(
            JSON.stringify(request.messages).includes(resolve(".pi/skills/office-documents/SKILL.md"))
          );
          call("load_skill", { name: "office-documents" });
        } else if (step === 2) {
          const result = request.messages.findLast((message) => message.role === "tool");
          const text =
            typeof result.content === "string"
              ? result.content
              : result.content.map((part) => part.text || "").join("");
          const loaded = JSON.parse(text);
          const script = loaded.scripts["check_backend.mjs"];
          assert.equal(script, resolve(".pi/skills/office-documents/scripts/check_backend.mjs"));
          assert.equal(loaded.directory, resolve(".pi/skills/office-documents"));
          call("bash", {
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
            timeout: 30
          });
        } else {
          assert.equal(step, 3);
          const result = request.messages.findLast((message) => message.role === "tool");
          const body = JSON.stringify(result.content);
          assert.match(body, /backends/);
          assert.match(body, /officecli/);
          assert.doesNotMatch(body, /MODULE_NOT_FOUND|Cannot find module|Command exited with code/);
          send({ content: "Office 后端检查完成。" });
          send({}, "stop");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "Local Office integration failed." });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(root, { recursive: true, force: true });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    child = spawn(
      process.execPath,
      [
        "scripts/start-pi.mjs",
        "--print",
        "--mode",
        "json",
        "--session-id",
        "office-run",
        "--session-dir",
        join(root, "sessions"),
        "加载 office-documents 并检查本地后端。"
      ],
      {
        cwd: resolve("."),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          COWORK_CONFIG: join(root, "config.json"),
          COWORK_WORKSPACE: workspace,
          COWORK_PROJECT_DIR: project,
          COWORK_TASK_ID: "office-task",
          COWORK_RUN_ID: "office-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "office-fixture",
          COWORK_DASHBOARD_URL: "",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    const record = (chunk) => {
      output = (output + chunk).slice(-10000);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.equal(requests, 3, output);
  }
);

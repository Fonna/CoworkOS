import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

// A real Pi session against a local model-protocol fixture. Unlike the fake
// extension API, this checks the provider-visible tools after a mid-turn bind.
test(
  "real Pi discovers built-in applications, creates CAD and immediately exposes its tools",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-cad-bootstrap-"));
    const workspace = join(root, "workspace"),
      project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("bootstrap-task", { goal: "从对话创建 CAD" });
    await store.createRun("bootstrap-task", "bootstrap-run");
    const failures = [],
      calls = [];
    const executionEnds = [];
    let requestCount = 0,
      child,
      output = "";
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      requestCount += 1;
      const step = requestCount - 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "bootstrap", object: "chat.completion.chunk", created: 1, model: "bootstrap-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        const names = request.tools.map((tool) => tool.function.name);
        let name, args;
        if (requestCount === 1) {
          assert.ok(names.includes("enable_tools"));
          assert.ok(!names.includes("create_resource"));
          assert.ok(names.includes("call_subagent"));
          name = "enable_tools";
          args = { groups: ["applications"] };
        } else if (step === 1) {
          assert.ok(names.includes("list_applications"));
          name = "list_applications";
          args = {};
        } else if (step === 2) {
          const catalog = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
          assert.deepEqual(
            catalog.applications.map((application) => application.appType),
            ["text-editor", "pptist", "cad", "blender"]
          );
          assert.ok(!names.includes("cad_read_model"));
          const schema = request.tools.find((tool) => tool.function.name === "create_resource").function
            .parameters;
          assert.ok(schema.properties.initialContent.anyOf.some((branch) => branch.type === "object"));
          name = "create_resource";
          args = {
            kind: "model/atria-cad+json",
            title: "对话火箭.cad.json",
            initialContent: { version: 1, units: "mm", parts: [] }
          };
        } else {
          const result = JSON.parse(request.messages.findLast((message) => message.role === "tool").content);
          if (step !== 4) {
            assert.notEqual(result.ok, false);
            assert.ok(!result.error, JSON.stringify(result));
          }
          assert.ok(
            names.includes("cad_read_model"),
            "new tools must be visible immediately after creation, without an extra turn"
          );
          assert.ok(names.includes("cad_edit_parts"));
          if (step === 3) {
            assert.equal(result.bound, true);
            assert.deepEqual(result.nextAction, { tool: "cad_read_model", arguments: {} });
            assert.ok(result.availableTools.includes("cad_read_model"));
            // Intentionally skip the first read: the structured precondition
            // error must be marked failed in the real Pi event/transcript.
            name = "cad_edit_parts";
            args = { upsert: [{ id: "bad", shape: "sphere", radius: 99 }] };
          } else if (step === 4) {
            assert.equal(result.ok, false);
            assert.equal(result.code, "operation_precondition_failed");
            assert.deepEqual(result.nextAction, { tool: "cad_read_model", arguments: {} });
            name = "cad_read_model";
            args = {};
          } else if (step === 5) {
            assert.deepEqual(result.result.model.parts, []);
            name = "cad_edit_parts";
            args = {
              upsert: [
                { id: "body", name: "箭体", shape: "cylinder", radius: 20, height: 100 },
                { id: "nose", name: "头部", shape: "sphere", radius: 20, position: [0, 0, 50] }
              ]
            };
          } else if (step === 6) {
            name = "cad_read_model";
            args = {};
          } else {
            assert.equal(step, 7);
            assert.equal(result.result.model.parts.length, 2);
            send({ content: "已创建并读回核对火箭模型。" });
            send({}, "stop");
          }
        }
        if (name) {
          calls.push(name);
          send({
            tool_calls: [
              {
                index: 0,
                id: `bootstrap-${requestCount}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          });
          send({}, "tool_calls");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "接入回归失败。" });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
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
        "bootstrap-run",
        "--session-dir",
        join(root, "sessions"),
        "帮我画一个火箭CAD吧"
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
          COWORK_TASK_ID: "bootstrap-task",
          COWORK_RUN_ID: "bootstrap-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "bootstrap-fixture",
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
      output = (output + chunk).slice(-10_000);
    };
    child.stdout.on("data", record);
    let pendingLine = "";
    child.stdout.on("data", (chunk) => {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "tool_execution_end") executionEnds.push(event);
        } catch {
          /* startup diagnostics are not JSON events */
        }
      }
    });
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.deepEqual(calls, [
      "enable_tools",
      "list_applications",
      "create_resource",
      "cad_edit_parts",
      "cad_read_model",
      "cad_edit_parts",
      "cad_read_model"
    ]);
    const edits = executionEnds.filter((event) => event.toolName === "cad_edit_parts");
    assert.equal(edits.length, 2);
    assert.equal(edits[0].isError, true, "real Pi must label a rejected edit as failed");
    assert.equal(edits[0].result.details.code, "operation_precondition_failed");
    assert.equal(edits[1].isError, false);
    const service = new ApplicationService(workspace);
    const resources = await service.listResources("bootstrap-task");
    assert.equal(resources.length, 1);
    const saved = await service.readResource("bootstrap-task", resources[0].resourceId);
    assert.equal(saved.resource.revision, 1);
    assert.deepEqual(
      saved.snapshot.content.parts.map((part) => part.id),
      ["body", "nose"]
    );
  }
);

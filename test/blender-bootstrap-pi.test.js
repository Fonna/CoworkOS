import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { blenderStatus } from "../dist/src/software/blender/engine.js";
import { BlenderProjectProvider } from "../dist/src/software/blender/project-provider.js";

test(
  "real Pi creates Blender, enforces fresh reads, receives renders, preserves manual edits and exports real game assets",
  { skip: !(await blenderStatus()).available, timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-blender-pi-")),
      workspace = join(root, "workspace"),
      project = join(root, "project");
    await mkdir(project);
    await writeFile(join(root, "config.json"), "{}");
    const store = new LocalWorkspaceStore(workspace);
    await store.createTask("blender-task", { goal: "创建低多边形机器人" });
    await store.createRun("blender-task", "blender-run");
    const source = await readFile("test/fixtures/blender-robot.py", "utf8"),
      failures = [],
      calls = [];
    const service = new ApplicationService(workspace);
    let count = 0,
      child,
      output = "",
      blenderId;
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      count++;
      const step = count - 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "blender", object: "chat.completion.chunk", created: 1, model: "blender-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        );
      send({ role: "assistant" });
      try {
        const names = body.tools.map((tool) => tool.function.name);
        const message = body.messages.findLast((message) => message.role === "tool");
        const previous = message && JSON.parse(message.content);
        let name,
          args = {};
        if (count === 1) {
          assert.ok(names.includes("enable_tools"));
          assert.ok(!names.includes("create_resource"));
          name = "enable_tools";
          args = { groups: ["applications"] };
        } else if (step === 1) {
          assert.ok(!names.includes("blender_read_scene"));
          name = "create_resource";
          args = { kind: "project/atria-blender+json", title: "机器人" };
        } else {
          if (step < 12) assert.ok(names.includes("blender_read_scene"));
          if (step !== 4 && step !== 8) assert.notEqual(previous.ok, false, JSON.stringify(previous));
          if (step === 2) {
            blenderId = previous.resource.resourceId;
            assert.deepEqual(previous.nextAction, { tool: "blender_read_scene", arguments: {} });
            name = "blender_get_api_reference";
            args = { module: "bpy", member: "app" };
          } else if (step === 3) {
            name = "blender_run_python";
            args = { source };
          } else if (step === 4) {
            assert.equal(previous.code, "operation_precondition_failed");
            name = "blender_read_scene";
          } else if (step === 5) {
            assert.equal(previous.result.document.snapshot, null);
            name = "blender_run_python";
            args = { source, parameters: { width: 2.8 } };
          } else if (step === 6) {
            assert.equal(previous.result.scene.objects.length, 12);
            assert.equal(previous.visualFeedback.delivered, false);
            const arm = previous.result.scene.objects.find((o) => o.name === "ArmLeft");
            await service.executeResourceCommand({
              taskId: "blender-task",
              resourceId: blenderId,
              command: "blender_apply_operations",
              params: { edits: [{ id: arm.id, position: [-3, 0, 2.85] }] },
              baseRevision: previous.applied[0].revision,
              operationId: "human-arm",
              actor: { type: "user", id: "local" }
            });
            name = "blender_query";
            args = { source: "def main(p): return bpy.data.objects['ArmLeft'].location.x" };
          } else if (step === 7) {
            assert.equal(previous.result.value, -3);
            name = "blender_run_python";
            args = { parameters: { width: 3.2 } };
          } else if (step === 8) {
            assert.equal(previous.code, "revision_conflict");
            name = "blender_read_scene";
          } else if (step === 9) {
            assert.deepEqual(previous.result.scene.objects.find((o) => o.name === "ArmLeft").position, [
              -3,
              0,
              previous.result.scene.objects.find((o) => o.name === "ArmLeft").position[2]
            ]);
            name = "blender_run_python";
            args = { parameters: { width: 3.2 } };
          } else if (step === 10) {
            assert.equal(previous.result.scene.objects.length, 12);
            assert.equal(previous.result.scene.objects.find((o) => o.name === "ArmLeft").position[0], -3);
            name = "export_resource";
            args = { resourceId: blenderId, format: "glb" };
          } else if (step === 11) {
            name = "create_resource";
            args = { kind: "text/plain", title: "说明" };
          } else {
            assert.equal(step, 12);
            assert.ok(!names.includes("blender_run_python"));
            send({ content: "机器人和 GLB 已完成，人工修改已保留。" });
            send({}, "stop");
          }
        }
        if (name) {
          calls.push(name);
          send({
            tool_calls: [
              {
                index: 0,
                id: `blender-${count}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          });
          send({}, "tool_calls");
        }
      } catch (error) {
        failures.push(error.message);
        send({ content: "接入验收失败" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      if (child?.pid) {
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
        "blender-run",
        "--session-dir",
        join(root, "sessions"),
        "创建低多边形机器人"
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
          COWORK_TASK_ID: "blender-task",
          COWORK_RUN_ID: "blender-run",
          COWORK_TABS_INDEX: join(root, "tabs.json"),
          COWORK_API_BASE: `http://127.0.0.1:${server.address().port}/v1`,
          COWORK_API_KEY: "local-fixture",
          COWORK_MODEL: "blender-fixture",
          COWORK_DASHBOARD_URL: "",
          COWORK_DISABLE_WATCH_SUPERVISOR: "1",
          COWORK_REASONING_EFFORT: "off",
          COWORK_SUPPORTS_REASONING_EFFORT: "0",
          COWORK_SUPPORTS_IMAGES: "0",
          PI_CODING_AGENT_DIR: join(root, "pi"),
          PI_OFFLINE: "1"
        }
      }
    );
    const record = (chunk) => {
      output = (output + chunk).slice(-8000);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, output);
    assert.deepEqual(failures, [], output);
    assert.deepEqual(calls, [
      "enable_tools",
      "create_resource",
      "blender_get_api_reference",
      "blender_run_python",
      "blender_read_scene",
      "blender_run_python",
      "blender_query",
      "blender_run_python",
      "blender_read_scene",
      "blender_run_python",
      "export_resource",
      "create_resource"
    ]);
    const owner = await service.serviceForResource("blender-task", blenderId);
    const read = await service.readResource("blender-task", blenderId),
      report = await new BlenderProjectProvider(owner.resourceWorkspaceRoot).inspect(read.snapshot.content);
    assert.equal(report.objects.length, 12);
    assert.equal(report.objects.find((o) => o.name === "ArmLeft").position[0], -3);
    const { listTaskArtifacts, resolveTaskArtifact } =
      await import("../dist/src/workspace/artifact-store.js");
    const artifacts = await listTaskArtifacts({ workspaceRoot: workspace, taskId: "blender-task" });
    const glb = artifacts.find((a) => a.relativePath.endsWith(".glb"));
    assert.ok(glb);
    const artifact = await resolveTaskArtifact({
      workspaceRoot: workspace,
      taskId: "blender-task",
      relativePath: glb.relativePath
    });
    assert.equal((await readFile(artifact.absolutePath)).toString("ascii", 0, 4), "glTF");
  }
);

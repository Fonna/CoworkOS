import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { BlenderProjectProvider } from "../dist/src/software/blender/project-provider.js";
import { blenderStatus } from "../dist/src/software/blender/engine.js";
import { listTaskArtifacts, resolveTaskArtifact } from "../dist/src/workspace/artifact-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { startDashboard } from "./dashboard-fixture.mjs";

test(
  "real Main exports a legacy Blender snapshot from its source root while another project TXT stays loaded",
  { timeout: 90_000 },
  async (t) => {
    for (const name of Object.keys(process.env))
      if (
        /^(?:ATRIA_|COWORK_|PI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|SERPER_)/.test(
          name
        ) ||
        /_API_KEY$/.test(name) ||
        name === "NODE_OPTIONS"
      )
        delete process.env[name];
    // Select only the repository's native fixture runtime. Never discover a
    // user's installed Blender runtime or start their interactive profile.
    const executable = resolve(".tools/blender-runtime/Blender.app/Contents/MacOS/Blender");
    if (process.platform !== "darwin") return t.skip("native Blender isolation requires macOS");
    try {
      await access(executable, constants.X_OK);
    } catch {
      return t.skip("the repository Blender fixture runtime is unavailable");
    }
    process.env.COWORK_BLENDER_EXECUTABLE = executable;
    assert.equal((await blenderStatus()).available, true);

    const taskId = "mixed-project-export";
    const failures = [];
    let blenderId;
    let exportRequested = false;
    let exported;
    const model = await modelProtocolFixture("openai-completions", (request, requests) => {
      try {
        const names = request.tools.map((tool) => tool.function.name);
        assert.ok(names.includes("read_document"), "TXT remains the active application throughout export");
        assert.equal(names.includes("blender_read_scene"), false, "generic export does not rebind Blender");
        if (!exportRequested) {
          if (!names.includes("export_resource")) {
            assert.equal(requests.length, 1, "generic tools become available after one explicit enable");
            assert.ok(names.includes("enable_tools"));
            return { name: "enable_tools", arguments: { groups: ["applications"] } };
          }
          exportRequested = true;
          return { name: "export_resource", arguments: { resourceId: blenderId, format: "blend" } };
        }
        const toolMessage = request.messages.findLast((message) => message.role === "tool");
        assert.ok(toolMessage);
        exported = JSON.parse(toolMessage.content);
        assert.equal(exported.ok, true, JSON.stringify(exported));
        assert.equal(exported.artifact.sourceResource.resourceId, blenderId);
        assert.equal(exported.artifact.taskId, taskId);
        return { text: "旧工作区 Blender 工程已导出，当前 TXT 保持加载。" };
      } catch (error) {
        failures.push(error.stack ?? error.message);
        return { text: "跨工作区导出回归失败。" };
      }
    });
    t.after(() => model.close());
    const dashboard = await startDashboard({
      modelEndpoint: model.baseUrl,
      model: "protocol-fixture",
      defaultProject: false
    });
    t.after(() => dashboard.stop());
    const projectDirectory = join(dashboard.root, "txt-project");
    await mkdir(projectDirectory);
    const api = async (path, body, status = 200) => {
      const response = await fetch(`${dashboard.base}${path}`, {
        ...(body === undefined
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000)
      });
      const payload = await response.json();
      assert.equal(response.status, status, `${path}: ${JSON.stringify(payload)}`);
      return payload;
    };
    const { project } = await api("/api/projects", { projectName: "当前 TXT 项目", projectDirectory }, 201);
    const task = await api(
      "/api/tasks",
      { taskId, goal: "保留 TXT 上下文，导出此前 Blender 工程", projectId: project.projectId },
      201
    );
    assert.equal(task.storageRoot, dashboard.workspaceRoot);
    assert.equal(task.projectDirectory, projectDirectory);
    assert.notEqual(task.storageRoot, task.projectDirectory);

    // The legacy reference has no source-root field: its actual native
    // snapshot belongs to Task storage B, independently of active project A.
    const source = new ApplicationService(dashboard.workspaceRoot);
    const actor = { type: "user", id: "local" };
    const blender = await source.createResource({
      taskId,
      kind: "project/atria-blender+json",
      title: "旧工作区工程",
      actor
    });
    blenderId = blender.resource.resourceId;
    await source.executeResourceCommand({
      taskId,
      resourceId: blenderId,
      command: "blender_run_python",
      params: {
        source:
          "import bpy\nbpy.ops.mesh.primitive_cube_add(size=2)\nbpy.context.object.name = 'SourceRootCube'\n",
        resetScene: true
      },
      operationId: "native-source-snapshot",
      baseRevision: 0,
      actor
    });
    const saved = await source.readResource(taskId, blenderId);
    assert.ok(saved.snapshot.content.snapshot);
    const snapshot = await new BlenderProjectProvider(dashboard.workspaceRoot).bytes(
      saved.snapshot.content,
      "scene.blend"
    );
    const expectedHash = createHash("sha256").update(snapshot).digest("hex");
    const opened = await api(
      "/api/workbench/open-application",
      { appType: "text-editor", workspaceRoot: projectDirectory },
      201
    );
    const txt = await api(
      `/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`,
      { kind: "text/plain", title: "当前项目.txt", initialContent: "保持这份文档。\n" },
      201
    );
    await api("/api/workbench/load-instance", { taskId, appInstanceId: opened.appInstance.appInstanceId });
    const mapping = JSON.parse(
      await readFile(join(dashboard.workspaceRoot, taskId, "applications", "mapping.json"), "utf8")
    );
    assert.equal(mapping.resources.find((entry) => entry.resourceId === blenderId).workspaceRoot, undefined);
    const active = (await api(`/api/tasks/${taskId}/active-app-context`)).context.resource;
    assert.equal(active.resourceId, txt.resource.resourceId);
    assert.equal(active.title, "当前项目.txt");
    assert.equal(active.kind, "text/plain");
    const run = await api(
      `/api/tasks/${taskId}/run`,
      { prompt: "启用通用应用工具，只导出旧工作区 Blender 工程，不切换当前 TXT。" },
      202
    );
    let detail;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      detail = await api(`/api/tasks/${taskId}`);
      if (!detail.runtime.active && ["completed", "failed", "cancelled"].includes(detail.task.status)) break;
      await delay(40);
    }
    assert.equal(detail.task.status, "completed", JSON.stringify(detail.task));
    assert.deepEqual(failures, []);
    assert.ok(exported, "the real Pi reports the generic tool's published artifact");
    const artifacts = await listTaskArtifacts({ workspaceRoot: dashboard.workspaceRoot, taskId });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].artifactId, exported.artifact.artifactId);
    assert.equal(artifacts[0].runId, run.runId);
    assert.equal(artifacts[0].sha256, expectedHash);
    const artifact = await resolveTaskArtifact({
      workspaceRoot: dashboard.workspaceRoot,
      taskId,
      relativePath: artifacts[0].relativePath
    });
    assert.equal(await realpath(exported.path), artifact.absolutePath);
    assert.deepEqual(await readFile(artifact.absolutePath), snapshot);
    const after = (await api(`/api/tasks/${taskId}/active-app-context`)).context.resource;
    assert.equal(after.resourceId, txt.resource.resourceId);
    assert.equal(after.title, "当前项目.txt");
    assert.equal(after.kind, "text/plain");
    assert.equal((await source.readResource(taskId, blenderId)).resource.revision, saved.resource.revision);
    await assert.rejects(
      access(join(projectDirectory, "applications/blender/projects", saved.snapshot.content.projectId)),
      {
        code: "ENOENT"
      }
    );
    const exportEvent = detail.runtimeEvents
      .map((event) => event.payload)
      .find((event) => event.type === "tool_execution_end" && event.toolName === "export_resource");
    assert.equal(exportEvent?.isError, false);
  }
);

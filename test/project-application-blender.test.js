import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { applicationServiceForTask } from "../dist/src/applications/task-service.js";
import { ApplicationRegistry } from "../dist/src/applications/registry.js";
import { dummyCounterAdapter } from "../dist/src/applications/adapters/dummy-counter-adapter.js";
import {
  applicationCapabilityProvider,
  resourceGrants,
  acceptResourceCandidate
} from "../dist/src/applications/agent-capabilities.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { DurableScheduler } from "../dist/src/runtime/scheduler.js";
import { blenderStatus } from "../dist/src/software/blender/engine.js";
import { BlenderProjectProvider } from "../dist/src/software/blender/project-provider.js";
import { BLENDER_KIND } from "../dist/src/software/blender/model.js";

const actor = { type: "user", id: "local" };
// Probe and execute the same repository fixture runtime, without falling back
// to an inherited executable override or the user's Blender installation.
const executable = fileURLToPath(
  new URL("../.tools/blender-runtime/Blender.app/Contents/MacOS/Blender", import.meta.url)
);
process.env.COWORK_BLENDER_EXECUTABLE = executable;
const available =
  process.platform === "darwin" &&
  (await access(executable, constants.X_OK).then(
    () => true,
    () => false
  ));
if (available) {
  const status = await blenderStatus();
  assert.equal(status.available, true);
  assert.equal(status.executable, await realpath(executable));
}
async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-mixed-blender-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = join(root, "task-storage"),
    source = join(root, "blender-source"),
    active = join(root, "txt-active");
  await Promise.all([storage, source, active].map((path) => mkdir(path)));
  const store = new LocalWorkspaceStore(storage);
  await store.createTask("mixed", {
    goal: "Keep original Blender snapshot source",
    projectDirectory: active
  });
  await store.createRun("mixed", "run");
  return { storage, source, active, store };
}

test(
  "mixed-root Blender exports and delegated native candidates use the original verified snapshot workspace",
  {
    skip: available ? false : "native macOS repository Blender fixture runtime is unavailable",
    timeout: 90_000
  },
  async (t) => {
    const f = await roots(t);
    const sourceService = new ApplicationService(f.source, undefined, f.storage);
    const resource = (
      await sourceService.createResource({ taskId: "mixed", kind: BLENDER_KIND, title: "原始工程", actor })
    ).resource;
    await sourceService.executeResourceCommand({
      taskId: "mixed",
      resourceId: resource.resourceId,
      command: "blender_run_python",
      params: {
        source:
          "import bpy\nbpy.ops.mesh.primitive_cube_add(size=2)\nbpy.context.object.name = 'OriginalRootCube'\n",
        resetScene: true
      },
      operationId: "initial-native-snapshot",
      baseRevision: 0,
      actor
    });
    const before = await sourceService.readResource("mixed", resource.resourceId);
    assert.ok(before.snapshot.content.snapshot);
    const provider = new BlenderProjectProvider(f.source);
    const blend = await provider.bytes(before.snapshot.content, "scene.blend");
    const glb = await provider.bytes(before.snapshot.content, "preview.glb");
    const activeService = new ApplicationService(f.active, undefined, f.storage);
    const text = (
      await activeService.createResource({
        taskId: "mixed",
        kind: "text/plain",
        title: "当前TXT",
        initialContent: "当前项目\n",
        actor
      })
    ).resource;
    await activeService.bindResource("mixed", text.resourceId);
    const mixed = await applicationServiceForTask(f.storage, "mixed");
    assert.deepEqual(
      (await mixed.renderForDownload({ taskId: "mixed", resourceId: resource.resourceId, format: "blend" }))
        .body,
      blend
    );
    assert.deepEqual(
      (await mixed.renderForDownload({ taskId: "mixed", resourceId: resource.resourceId, format: "glb" }))
        .body,
      glb
    );
    const grants = await resourceGrants(mixed, "mixed", [
      { resourceId: resource.resourceId, access: "candidate" }
    ]);
    const context = {
      taskId: "mixed",
      runId: "run",
      callId: "candidate",
      agentId: "editor",
      workspaceRoot: f.storage,
      workingDirectory: await f.store.prepareAgentWorkDir("mixed", "run", "editor"),
      supportsImages: false
    };
    await new DurableScheduler(join(f.storage, "mixed/runs/run/queue.json")).enqueue({
      stepId: context.callId,
      taskId: "mixed",
      runId: "run",
      agentId: context.agentId,
      importance: 1,
      payload: { capabilityGrants: grants }
    });
    const capabilities = await applicationCapabilityProvider(mixed, resolve("."))(grants, context);
    const read = await capabilities.tools.get("blender_read_scene").execute({});
    assert.notEqual(read.isError, true, JSON.stringify(read.details));
    assert.ok(read.details.result.scene.objects.some((object) => object.name === "OriginalRootCube"));
    const edit = await capabilities.tools.get("blender_run_python").execute({
      source: "import bpy\nbpy.data.objects['OriginalRootCube'].location.x = 4\n",
      saveSource: false
    });
    assert.notEqual(edit.isError, true, JSON.stringify(edit.details));
    assert.equal((await mixed.readResource("mixed", resource.resourceId)).resource.revision, 1);
    const accepted = await acceptResourceCandidate(mixed, {
      workspaceRoot: f.storage,
      taskId: "mixed",
      candidatePath: edit.details.candidate.candidatePath,
      actor: { type: "agent", id: "main" }
    });
    assert.equal(accepted.revision, 2);
    const after = await mixed.readResource("mixed", resource.resourceId);
    assert.equal(
      (await provider.inspect(after.snapshot.content)).objects.find(
        (object) => object.name === "OriginalRootCube"
      ).position[0],
      4
    );
    assert.equal(
      (await mixed.activeContext({ taskId: "mixed", agentId: "main" })).resource.resourceId,
      text.resourceId
    );
    await assert.rejects(
      access(join(f.active, "applications/blender/projects", before.snapshot.content.projectId)),
      { code: "ENOENT" }
    );
    await assert.rejects(access(join(f.source, "mixed")), { code: "ENOENT" });
    assert.ok(
      (await readFile(join(f.storage, "mixed/applications/mapping.json"), "utf8")).includes(f.source)
    );
  }
);

test("resource-specific services preserve an explicitly supplied custom registry across mapped roots", async (t) => {
  const f = await roots(t);
  const registry = new ApplicationRegistry().register(dummyCounterAdapter);
  const source = new ApplicationService(f.source, registry, f.storage);
  const created = await source.createResource({
    taskId: "mixed",
    appType: dummyCounterAdapter.definition.appType,
    kind: dummyCounterAdapter.definition.resourceKinds[0],
    title: "Custom adapter",
    actor
  });
  const active = new ApplicationService(f.active, registry, f.storage);
  const scoped = await active.serviceForResource("mixed", created.resource.resourceId);
  assert.equal(scoped.registry, registry);
  assert.equal(
    (await active.readResource("mixed", created.resource.resourceId)).resource.resourceId,
    created.resource.resourceId
  );
  assert.deepEqual(
    (await active.listResources("mixed")).map((item) => item.resourceId),
    [created.resource.resourceId]
  );
});

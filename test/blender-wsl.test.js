import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { BLENDER_KIND } from "../dist/src/software/blender/model.js";
import { blenderStatus, runBlender } from "../dist/src/software/blender/engine.js";
import { createComponentService } from "../dist/src/software/components/service.js";

const native = process.platform === "win32" && process.env.COWORK_BLENDER_WSL_TEST === "1";
const options = { skip: native ? false : "requires explicit Windows WSL2 Blender fixture", timeout: 120_000 };
if (native) {
  process.env.COWORK_BLENDER_WSL_DISTRO = "Ubuntu-24.04";
  process.env.COWORK_BLENDER_WSL_EXECUTABLE = "/opt/coworkos/blender-4.5.11-linux-x64/blender";
}

test("Windows WSL reports the isolated Blender runtime in application components", options, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "cowork-wsl-components-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await blenderStatus()).available, true);
  const components = createComponentService({ home });
  t.after(() => components.stop());
  const state = await components.status("blender");
  assert.equal(state.available, true);
  assert.match(state.version, /^4\.5\.11/);
});

test("Windows WSL builds a real 5 cm cube and exports verified blend, GLB and PNG", options, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-wsl-scene-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const actor = { type: "user", id: "local" };
  const { resource } = await service.createResource({
    taskId: "cube",
    kind: BLENDER_KIND,
    title: "5cm cube",
    actor
  });
  const result = await service.executeResourceCommand({
    taskId: "cube",
    resourceId: resource.resourceId,
    command: "blender_run_python",
    params: {
      source: "import bpy\nbpy.ops.mesh.primitive_cube_add(size=0.05)\nbpy.context.object.name='Cube5cm'",
      resetScene: true
    },
    baseRevision: 0,
    operationId: "cube-native",
    actor
  });
  assert.equal(result.resource.revision, 1);
  const cube = result.result.scene.objects.find((object) => object.name === "Cube5cm");
  assert.ok(cube);
  for (const size of cube.dimensions) assert.ok(Math.abs(size - 0.05) < 1e-6);
  for (const format of ["blend", "glb", "png"]) {
    const file = await service.renderForDownload({
      taskId: "cube",
      resourceId: resource.resourceId,
      format,
      options: format === "png" ? { resolution: 64, samples: 1 } : undefined
    });
    const bytes = Buffer.from(file.body);
    assert.ok(bytes.length > 100);
    if (format === "glb") assert.equal(bytes.toString("ascii", 0, 4), "glTF");
    if (format === "png") assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a");
  }
});

test(
  "Windows WSL denies host files, network and subprocesses without inheriting model credentials",
  options,
  async () => {
    const consume = async (_directory, result) => result.value;
    process.env.COWORK_WSL_ISOLATION_SENTINEL = "must-not-reach-model";
    try {
      assert.equal(
        await runBlender(
          { operation: "query", source: "import os\nresult = os.getenv('COWORK_WSL_ISOLATION_SENTINEL')" },
          20_000,
          consume
        ),
        null
      );
      for (const source of [
        "result = open('/etc/passwd').read()",
        "result = open('/mnt/c/Windows/win.ini').read()",
        "import socket\nsocket.create_connection(('127.0.0.1',3980))",
        "import subprocess\nsubprocess.run(['/runtime/blender','--version'],check=True)",
        "open('/runtime/unauthorized-write','w').write('no')"
      ]) {
        await assert.rejects(runBlender({ operation: "query", source }, 20_000, consume));
      }
    } finally {
      delete process.env.COWORK_WSL_ISOLATION_SENTINEL;
    }
  }
);

test("Windows WSL timeouts and cancellation drain the job and allow a subsequent run", options, async () => {
  let consumed = false;
  const consume = async () => {
    consumed = true;
  };
  await assert.rejects(
    runBlender({ operation: "query", source: "while True: pass" }, 1000, consume),
    /timed out|超时/
  );
  const controller = new AbortController();
  const pending = runBlender(
    { operation: "query", source: "while True: pass" },
    30_000,
    consume,
    controller.signal
  );
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await assert.rejects(pending, /取消|abort/i);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(consumed, false);
  assert.equal(
    await runBlender(
      { operation: "query", source: "result=42" },
      20_000,
      async (_directory, result) => result.value
    ),
    42
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import {
  BLENDER_KIND,
  emptyDocument,
  document,
  edits,
  parameters,
  renderOptions,
  timeout
} from "../dist/src/software/blender/model.js";
import { BLENDER_COMPUTE_LIMITS } from "../dist/src/software/blender/compute-limits.js";
import { blenderStatus } from "../dist/src/software/blender/engine.js";
import { BlenderProjectProvider } from "../dist/src/software/blender/project-provider.js";
import { startDashboard } from "./dashboard-fixture.mjs";

const actor = { type: "user", id: "local" };
const available = (await blenderStatus()).available;
const source = `import bpy
def main(p):
    obj = bpy.data.objects.get('Body')
    if obj is None:
        bpy.ops.mesh.primitive_cube_add(size=2)
        obj = bpy.context.object
        obj.name = 'Body'
    obj.dimensions = (p.get('width', 2), 2, 2)
    print('body_width', obj.dimensions.x)
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-blender-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({ taskId: "task", kind: BLENDER_KIND, title: "场景", actor });
  const id = created.resource.resourceId;
  const read = () => service.readResource("task", id);
  const command = async (name, params, options = {}) =>
    service.executeResourceCommand({
      taskId: "task",
      resourceId: id,
      command: name,
      params,
      baseRevision: (await read()).resource.revision,
      operationId: crypto.randomUUID(),
      actor,
      ...options
    });
  const provider = new BlenderProjectProvider(root);
  return { root, service, id, read, command, provider };
}
test("Blender registers, starts empty, binds domain tools and keeps drafts without native execution", async (t) => {
  const { service, id, read, command } = await fixture(t);
  await service.bindResource("task", id);
  const bound = await service.boundCapabilities({ taskId: "task", agentId: "main" });
  assert.deepEqual(
    bound.tools.map((tool) => tool.name),
    [
      "blender_read_scene",
      "blender_run_python",
      "blender_apply_operations",
      "blender_preview",
      "blender_render",
      "blender_get_api_reference",
      "blender_query"
    ]
  );
  for (const name of ["blender_run_python", "blender_apply_operations", "blender_render", "blender_query"])
    assert.equal(
      bound.tools.find((tool) => tool.name === name).parameters.properties.timeoutSeconds.maximum,
      600
    );
  const metadata = await command("blender_read_scene", {});
  assert.deepEqual(metadata.result.limits.compute, BLENDER_COMPUTE_LIMITS);
  assert.equal(metadata.result.limits.timeoutSeconds, 600);
  const preview = await service.previewResource({
    taskId: "task",
    resourceId: id,
    content: (await read()).snapshot.content
  });
  assert.deepEqual(preview.computeLimits, BLENDER_COMPUTE_LIMITS);
  const before = await read();
  assert.equal(before.snapshot.content.snapshot, null);
  await service.applyOperation({
    taskId: "task",
    resourceId: id,
    appType: "blender",
    operationId: "draft",
    operationType: "blender.document.edit",
    baseRevision: 0,
    payload: { source: "invalid python !", parameters: { width: 7 } },
    actor
  });
  assert.equal((await read()).snapshot.content.source, "invalid python !");
  await service.undo({ taskId: "task", resourceId: id, actor });
  assert.equal((await read()).snapshot.content.source, "");
  const txt = await service.createResource({ taskId: "task", kind: "text/plain", title: "notes", actor });
  await service.bindResource("task", txt.resource.resourceId);
  assert.ok(
    !(await service.boundCapabilities({ taskId: "task", agentId: "main" })).tools.some((tool) =>
      tool.name.startsWith("blender_")
    )
  );
});
test("Blender rejects forged identities, invalid edits, unsupported native formats and unreferenced access", async (t) => {
  const { service, id, read, provider } = await fixture(t);
  const doc = (await read()).snapshot.content;
  assert.throws(() => document({ ...doc, projectId: "../secret" }));
  assert.throws(() => document({ ...doc, version: 2 }));
  for (const values of [
    [{ id: "bad", position: [1, 2, 3] }],
    [{ id: "a".repeat(32), scale: [1, 0, 1] }],
    [{ id: "a".repeat(32), metallic: Infinity }],
    [{ id: "a".repeat(32), shell: "anything" }]
  ])
    assert.throws(() => edits(values));
  await assert.rejects(service.readResource("other", id), (e) => e.code === "resource_not_found");
  await assert.rejects(
    service.applyOperation({
      taskId: "task",
      resourceId: id,
      appType: "blender",
      operationId: "forged",
      operationType: "blender.snapshot.commit",
      baseRevision: 0,
      payload: { document: { ...doc, projectId: emptyDocument().projectId, snapshot: "a".repeat(32) } },
      actor
    }),
    (e) => e.code === "invalid_operation"
  );
  await assert.rejects(provider.read({ kind: "project", root: "/etc", entryPoints: [] }));
  await assert.rejects(
    provider.read({ kind: "utf8-file", path: "/etc/passwd" }),
    (e) => e.code === "unsupported_resource"
  );
  await assert.rejects(
    service.readResourceAttachment({ taskId: "task", resourceId: id, name: "../secret", revision: 0 })
  );
  assert.equal((await read()).resource.revision, 0);
});
test(
  "native Blender creates actual blend/GLB/PNG, preserves human edits and parameters, exports and restores history",
  { skip: !available, timeout: 120000 },
  async (t) => {
    const { service, id, root, command, read, provider } = await fixture(t);
    const first = await command("blender_run_python", { source, parameters: { width: 3 } });
    assert.equal(first.resource.revision, 1);
    assert.equal(first.result.scene.objects[0].dimensions[0], 3);
    assert.match(first.result.scene.diagnostics, /body_width/);
    const object = first.result.scene.objects[0];
    const human = await command("blender_apply_operations", {
      edits: [{ id: object.id, position: [4, 1, 0], color: [0.2, 0.4, 0.8, 1], metallic: 0.3 }]
    });
    assert.deepEqual(human.result.scene.objects[0].position, [4, 1, 0]);
    const next = await command("blender_run_python", { parameters: { width: 5 } });
    assert.equal(next.result.scene.objects.length, 1);
    assert.equal(next.result.scene.objects[0].id, object.id);
    assert.deepEqual(next.result.scene.objects[0].position, [4, 1, 0]);
    assert.equal(next.result.scene.objects[0].dimensions[0], 5);
    assert.ok(Math.abs(next.result.scene.objects[0].metallic - 0.3) < 0.00001);
    assert.equal((await read()).snapshot.content.parameters.width, 5);
    const exports = await Promise.all(
      ["blend", "glb", "png"].map((format) =>
        service.renderForDownload({
          taskId: "task",
          resourceId: id,
          format,
          options: format === "png" ? { resolution: 64, samples: 1 } : undefined
        })
      )
    );
    assert.ok(exports[0].body.length > 1000);
    assert.equal(Buffer.from(exports[1].body).toString("ascii", 0, 4), "glTF");
    assert.equal(Buffer.from(exports[2].body).toString("hex", 0, 8), "89504e470d0a1a0a");
    await service.undo({ taskId: "task", resourceId: id, actor });
    const restored = (await read()).snapshot.content;
    assert.equal(restored.snapshot, human.snapshot.content.snapshot);
    assert.equal(restored.parameters.width, 3);
    const restarted = new ApplicationService(root);
    assert.equal((await restarted.readResource("task", id)).snapshot.content.snapshot, restored.snapshot);
    assert.deepEqual((await provider.inspect(restored)).objects[0].position, [4, 1, 0]);
    const imported = await service.importNativeResource({
      taskId: "task",
      resourceId: id,
      body: exports[0].body,
      baseRevision: (await read()).resource.revision,
      operationId: "import",
      actor
    });
    assert.equal((await provider.inspect(imported.snapshot.content)).objects[0].dimensions[0], 5);
  }
);
test(
  "native linked meshes keep independent materials and quaternion rotations remain editable",
  { skip: !available, timeout: 60000 },
  async (t) => {
    const { command } = await fixture(t);
    const created = await command("blender_run_python", {
      source: `import bpy, math
from mathutils import Quaternion
bpy.ops.mesh.primitive_cube_add()
a = bpy.context.object
a.name = 'Original'
material = bpy.data.materials.new('Shared')
material.diffuse_color = (0.1, 0.2, 0.3, 1)
a.data.materials.append(material)
a.rotation_mode = 'QUATERNION'
a.rotation_quaternion = Quaternion((0, 0, 1), math.pi / 2)
b = a.copy()
b.name = 'Linked'
b.location.x = 3
bpy.context.collection.objects.link(b)
`
    });
    const original = created.result.scene.objects.find((o) => o.name === "Original");
    assert.ok(Math.abs(original.rotation[2] - 90) < 0.0001);
    const modified = await command("blender_apply_operations", {
      edits: [{ id: original.id, color: [0.9, 0.1, 0.2, 1], rotation: original.rotation }]
    });
    const a = modified.result.scene.objects.find((o) => o.name === "Original");
    const b = modified.result.scene.objects.find((o) => o.name === "Linked");
    assert.ok(Math.abs(a.color[0] - 0.9) < 0.0001);
    assert.ok(Math.abs(b.color[0] - 0.1) < 0.0001);
    assert.ok(Math.abs(a.rotation[2] - 90) < 0.0001);
  }
);
test(
  "failed Python, empty candidates, missing objects, denied file/network/subprocess access never commit",
  { skip: !available, timeout: 120000 },
  async (t) => {
    const { read, command } = await fixture(t);
    await command("blender_run_python", { source });
    const before = await read();
    for (const code of [
      "raise RuntimeError('candidate failed')",
      "import bpy\nfor o in list(bpy.data.objects): bpy.data.objects.remove(o,do_unlink=True)",
      "open('/etc/passwd').read()",
      "import socket\nsocket.create_connection(('127.0.0.1',3880))",
      "import subprocess\nsubprocess.run(['/bin/sh','-c','true'],check=True)"
    ]) {
      await assert.rejects(
        command("blender_run_python", { source: code, timeoutSeconds: 10 }),
        (e) => e.code === "invalid_operation"
      );
      assert.equal((await read()).snapshot.content.snapshot, before.snapshot.content.snapshot);
    }
    await assert.rejects(
      command("blender_apply_operations", { edits: [{ id: "a".repeat(32), position: [1, 2, 3] }] })
    );
    assert.equal((await read()).resource.revision, before.resource.revision);
  }
);
test(
  "cancellation and timeout terminate actual Blender and a later edit still succeeds",
  { skip: !available, timeout: 60000 },
  async (t) => {
    const { read, command } = await fixture(t);
    const before = await read();
    const controller = new AbortController();
    const pending = command(
      "blender_run_python",
      { source: "while True: pass", timeoutSeconds: 30 },
      { signal: controller.signal }
    );
    const timer = setTimeout(() => controller.abort(), 1500);
    await assert.rejects(pending);
    clearTimeout(timer);
    await assert.rejects(
      command("blender_run_python", { source: "while True: pass", timeoutSeconds: 1 }),
      /超时/
    );
    assert.equal((await read()).resource.revision, before.resource.revision);
    const recovery = await command("blender_run_python", { source });
    assert.equal(recovery.result.scene.objects.length, 1);
  }
);
test(
  "human edits during candidate calculation reject stale commit and idempotent retry does not rerun Python",
  { skip: !available, timeout: 90000 },
  async (t) => {
    const { read, service, id, command } = await fixture(t);
    await command("blender_run_python", { source });
    const before = await read(),
      tools = service.registry.require("blender").agentTools();
    const tool = tools.find((tool) => tool.name === "blender_run_python");
    const candidate = await tool.execute({
      content: before.snapshot.content,
      resource: before.resource,
      params: { parameters: { width: 7 } }
    });
    await service.applyOperation({
      taskId: "task",
      resourceId: id,
      appType: "blender",
      operationId: "manual",
      baseRevision: before.resource.revision,
      operationType: "blender.document.edit",
      payload: { parameters: { manual: true } },
      actor
    });
    await assert.rejects(
      service.applyOperation({
        taskId: "task",
        resourceId: id,
        appType: "blender",
        operationId: "stale",
        baseRevision: before.resource.revision,
        ...candidate.operations[0],
        actor
      }),
      (e) => e.code === "revision_conflict"
    );
    assert.equal((await read()).snapshot.content.parameters.manual, true);
    const result = await command(
      "blender_run_python",
      { parameters: { width: 4 } },
      { operationId: "retry" }
    );
    const retry = await command(
      "blender_run_python",
      { source: "raise RuntimeError('must not execute')" },
      { operationId: "retry", baseRevision: before.resource.revision }
    );
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.resource.revision, result.resource.revision);
  }
);
test(
  "snapshot tampering and symlinked project directories are refused",
  { skip: !available, timeout: 60000 },
  async (t) => {
    const { root, read, command, provider } = await fixture(t);
    await command("blender_run_python", { source });
    const doc = (await read()).snapshot.content,
      path = join(
        root,
        "applications/blender/projects",
        doc.projectId,
        "snapshots",
        doc.snapshot,
        "preview.glb"
      );
    const bytes = await readFile(path);
    await chmod(path, 0o644);
    await writeFile(path, Buffer.from("tampered"));
    await assert.rejects(provider.bytes(doc, "preview.glb"), /外部修改/);
    await writeFile(path, bytes);
    const receiptPath = join(path, "../snapshot.json");
    const receiptBytes = await readFile(receiptPath);
    const receipt = JSON.parse(receiptBytes);
    receipt.scene.objects[0].name = "forged report";
    await chmod(receiptPath, 0o644);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(provider.inspect(doc), /快照|损坏|修改/);
    await writeFile(receiptPath, receiptBytes);
    const other = await mkdtemp(join(tmpdir(), "atria-blender-symlink-"));
    t.after(() => rm(other, { recursive: true, force: true }));
    const newDoc = { ...emptyDocument(), source };
    await symlink(other, join(root, "applications/blender/projects", newDoc.projectId));
    await assert.rejects(provider.prepare(newDoc, "blender.python", {}), /符号链接/);
  }
);
test(
  "HTTP commands and binary attachments enforce task references, revisions and actual native bytes",
  { skip: !available, timeout: 90000 },
  async (t) => {
    const dashboard = await startDashboard();
    t.after(() => dashboard.stop());
    const post = (body) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const created = await fetch(
      `${dashboard.base}/api/workbench/open-application`,
      post({ appType: "blender" })
    ).then((r) => r.json());
    const task = created.taskId ?? "workspace",
      instance = created.appInstance ?? created.instance;
    const made = await fetch(
      `${dashboard.base}/api/tasks/${task}/app-instances/${instance.appInstanceId}/resources`,
      post({ kind: BLENDER_KIND, title: "HTTP 场景" })
    ).then((r) => r.json());
    const base = `${dashboard.base}/api/tasks/${task}/resources/${made.resource.resourceId}`;
    const response = await fetch(
      `${base}/commands`,
      post({ command: "blender_run_python", params: { source }, baseRevision: 0, operationId: "http-run" })
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    const glb = await fetch(`${base}/attachments/preview.glb?revision=${result.resource.revision}`);
    assert.equal(glb.headers.get("content-type"), "model/gltf-binary");
    assert.equal(Buffer.from(await glb.arrayBuffer()).toString("ascii", 0, 4), "glTF");
    assert.equal((await fetch(`${base}/attachments/preview.glb?revision=0`)).status, 409);
    const sourceDownload = await fetch(`${base}/download?format=blend`);
    assert.equal(sourceDownload.status, 200);
    const blob = await sourceDownload.arrayBuffer();
    const imported = await fetch(
      `${base}/import-native?revision=${result.resource.revision}&operationId=http-import`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob }
    );
    assert.equal(imported.status, 200, await imported.clone().text());
    // Opening a local file from an empty app commits nothing until import succeeds.
    const empty = await fetch(
      `${dashboard.base}/api/workbench/open-application`,
      post({ appType: "blender" })
    ).then((r) => r.json());
    const emptyTask = empty.taskId;
    const importUrl = `${dashboard.base}/api/tasks/${emptyTask}/app-instances/${empty.appInstance.appInstanceId}/resources?kind=${encodeURIComponent(BLENDER_KIND)}&title=Imported`;
    const before = await fetch(`${dashboard.base}/api/tasks/${emptyTask}/resources`).then((r) => r.json());
    const invalid = await fetch(importUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "invalid blend"
    });
    assert.equal(invalid.ok, false);
    const after = await fetch(`${dashboard.base}/api/tasks/${emptyTask}/resources`).then((r) => r.json());
    assert.equal(after.resources.length, before.resources.length);
    const opened = await fetch(importUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: blob
    });
    assert.equal(opened.status, 201, await opened.clone().text());
    const importedResource = await opened.json();
    assert.equal(importedResource.appInstance.appInstanceId, empty.appInstance.appInstanceId);
    const importedRead = await fetch(
      `${dashboard.base}/api/tasks/${emptyTask}/resources/${importedResource.resource.resourceId}`
    ).then((r) => r.json());
    assert.ok(importedRead.snapshot.content.snapshot);
    const preview = await fetch(
      `${dashboard.base}/api/tasks/${emptyTask}/resources/${importedResource.resource.resourceId}/attachments/preview.glb?revision=0`
    );
    assert.equal(preview.status, 200);
    assert.equal(Buffer.from(await preview.arrayBuffer()).toString("ascii", 0, 4), "glTF");
  }
);

test(
  "complex native data stays accessible through paged reads, isolated queries, patch scripts and camera/frame renders",
  { skip: !available, timeout: 120000 },
  async (t) => {
    const { command, read, service, id, provider } = await fixture(t);
    const complexSource = `import bpy
from mathutils import Vector
def main(p):
    bpy.ops.mesh.primitive_cube_add()
    body = bpy.context.object
    body.name = 'Body'
    material = bpy.data.materials.new('Procedural wood')
    material.use_nodes = True
    noise = material.node_tree.nodes.new('ShaderNodeTexNoise')
    material.node_tree.links.new(noise.outputs['Fac'], material.node_tree.nodes['Principled BSDF'].inputs['Roughness'])
    body.data.materials.append(material)
    group = bpy.data.node_groups.new('Procedural geometry', 'GeometryNodeTree')
    group.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    group.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    incoming = group.nodes.new('NodeGroupInput')
    outgoing = group.nodes.new('NodeGroupOutput')
    group.links.new(incoming.outputs['Geometry'], outgoing.inputs['Geometry'])
    body.modifiers.new('Geometry nodes', 'NODES').node_group = group
    collection = bpy.data.collections.new('Furniture')
    bpy.context.scene.collection.children.link(collection)
    for i in range(p['layout']['count']):
        obj = bpy.data.objects.new('Furniture %03d' % i, body.data)
        obj.location = (i % 15 * 3, 8 + i // 15 * 3, 0)
        collection.objects.link(obj)
    for frame, x in ((1, 0), (10, 1)):
        body.location.x = x
        body.keyframe_insert(data_path='location', frame=frame)
    for name, pos in (('Front', (0, -8, 3)), ('Side', (8, 0, 3))):
        data = bpy.data.cameras.new(name)
        camera = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(camera)
        camera.location = pos
        camera.rotation_euler = (-Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
    scene = bpy.context.scene
    scene.camera = bpy.data.objects['Front']
    scene.frame_set(1)
    scene.world = bpy.data.worlds.new('Environment')
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.5
`;
    const created = await command("blender_run_python", {
      source: complexSource,
      parameters: { layout: { count: 105, palette: ["oak", null, 0.4] } }
    });
    assert.equal(created.result.scene.objects.length, 100);
    assert.equal(created.result.scene.objectCount, 108);
    assert.equal((await provider.inspect(created.snapshot.content)).objects.length, 108);
    assert.equal((await command("blender_preview", {})).result.scene.nextOffset, 100);
    const before = await read();
    const defaultPage = await command("blender_read_scene", {});
    assert.equal(defaultPage.result.interfaceVersion, 2);
    assert.equal(defaultPage.result.scene.objects.length, 100);
    assert.equal(defaultPage.result.scene.nextOffset, 100);
    const firstPage = await command("blender_read_scene", {
      name: "Furniture",
      limit: 40,
      includeSource: false
    });
    assert.equal(firstPage.result.scene.objectCount, 108);
    assert.equal(firstPage.result.scene.matchedCount, 105);
    assert.equal(firstPage.result.scene.nextOffset, 40);
    assert.equal(firstPage.result.scene.objects.length, 40);
    assert.ok(!("source" in firstPage.result.document));
    const lastPage = await command("blender_read_scene", { name: "Furniture", offset: 80, limit: 40 });
    assert.equal(lastPage.result.scene.objects.length, 25);
    assert.equal(lastPage.result.scene.nextOffset, null);
    const body = (await command("blender_read_scene", { name: "Body" })).result.scene.objects[0];
    assert.equal(
      (await command("blender_read_scene", { ids: [body.id] })).result.scene.objects[0].name,
      "Body"
    );
    const detail = await command("blender_query", {
      source: `def main(p):
    obj = bpy.data.objects['Body']
    obj.location.z = 100
    print('query discarded')
    return {'nodeType': obj.modifiers[0].node_group.bl_idname, 'nodes': [n.bl_idname for n in obj.active_material.node_tree.nodes], 'collection': len(bpy.data.collections['Furniture'].objects), 'layout': p['layout']}
`
    });
    assert.equal(detail.result.value.nodeType, "GeometryNodeTree");
    assert.ok(detail.result.value.nodes.includes("ShaderNodeTexNoise"));
    assert.equal(detail.result.value.collection, 105);
    assert.deepEqual(detail.result.value.layout, { count: 105, palette: ["oak", null, 0.4] });
    assert.match(detail.result.diagnostics, /query discarded/);
    assert.equal((await read()).resource.revision, before.resource.revision);
    assert.equal(
      (await provider.inspect(before.snapshot.content)).objects.find((o) => o.name === "Body").position[2],
      0
    );
    for (const source of [
      "result = float('nan')",
      "result = bpy.data.objects['Body']",
      "result = 'x' * 64001"
    ])
      await assert.rejects(command("blender_query", { source }));
    const patched = await command("blender_run_python", {
      source: "bpy.data.objects['Body']['reviewed'] = True",
      saveSource: false
    });
    assert.equal(patched.snapshot.content.source, complexSource);
    assert.deepEqual(patched.snapshot.content.parameters, before.snapshot.content.parameters);
    assert.equal(
      (await command("blender_query", { source: "result = bpy.data.objects['Body']['reviewed']" })).result
        .value,
      true
    );
    const stable = await read();
    const cameras = (await command("blender_read_scene", { type: "CAMERA" })).result.scene.objects;
    const front = cameras.find((o) => o.name === "Front");
    const png1 = await command("blender_render", {
      camera: front.id,
      frame: 1,
      width: 96,
      height: 64,
      samples: 1,
      denoise: false
    });
    const png10 = await command("blender_render", {
      camera: "Front",
      frame: 10,
      width: 96,
      height: 64,
      samples: 1,
      denoise: false
    });
    const side10 = await command("blender_render", {
      camera: "Side",
      frame: 10,
      width: 96,
      height: 64,
      samples: 1,
      denoise: false
    });
    const bytes1 = Buffer.from(png1.images[0].data, "base64"),
      bytes10 = Buffer.from(png10.images[0].data, "base64");
    assert.equal(bytes1.readUInt32BE(16), 96);
    assert.equal(bytes1.readUInt32BE(20), 64);
    assert.notDeepEqual(bytes1, bytes10);
    assert.notDeepEqual(bytes10, Buffer.from(side10.images[0].data, "base64"));
    const state = await command("blender_query", {
      source:
        "result = [bpy.context.scene.camera.name, bpy.context.scene.frame_current, bpy.data.objects['Body'].location.x]"
    });
    assert.deepEqual(state.result.value, ["Front", 1, 0]);
    await assert.rejects(
      command("blender_render", { camera: body.id, width: 64, height: 64, samples: 1 }),
      /相机/
    );
    assert.equal((await read()).resource.revision, stable.resource.revision);
    const download = await service.renderForDownload({
      taskId: "task",
      resourceId: id,
      format: "png",
      options: { camera: front.id, frame: 10, width: 80, height: 64, samples: 1 }
    });
    assert.equal(Buffer.from(download.body).readUInt32BE(16), 80);
  }
);

test("Blender JSON parameters and render requests reject ambiguous or unbounded input", () => {
  const nested = { rooms: [{ dimensions: [3.5, 4, 2.8], enabled: true, asset: null }] };
  assert.deepEqual(document({ ...emptyDocument(), parameters: nested }).parameters, nested);
  assert.throws(() => parameters({ value: Infinity }));
  assert.throws(() => parameters({ value: new Date() }));
  assert.throws(() => parameters({ value: "x".repeat(64001) }));
  let value = 1;
  for (let i = 0; i < 10; i++) value = [value];
  assert.throws(() => parameters({ value }));
  for (const input of [
    { width: 80 },
    { height: 64 },
    { resolution: 64, width: 64, height: 64 },
    { frame: 1.5 },
    { camera: "" },
    { denoise: "true" },
    { samples: 129 }
  ])
    assert.throws(() => renderOptions(input));
});

test(
  "native Blender accepts budget boundaries with shared meshes and rejects overflow without changing the saved project",
  { skip: !available, timeout: 120000 },
  async (t) => {
    const { command, read } = await fixture(t);
    const generate = (count, sphere = false) => `import bpy
${sphere ? "bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=7, radius=1)" : "bpy.ops.mesh.primitive_cube_add(size=.5)"}
a = bpy.context.object
for polygon in a.data.polygons: polygon.use_smooth = True
for i in range(1, ${count}):
    obj = a.copy()
    obj.data = a.data
    obj.location = (i % 40 * 3, i // 40 * 3, 0)
    bpy.context.collection.objects.link(obj)
`;
    const thousand = await command("blender_run_python", { source: generate(1000), resetScene: true });
    assert.equal(thousand.result.scene.objectCount, 1000);
    assert.equal(thousand.result.scene.objects.length, 100);
    assert.equal(thousand.result.scene.triangles, 12000);
    const beforeObjects = await read();
    await assert.rejects(
      command("blender_run_python", { source: generate(1001), resetScene: true }),
      /对象超过 1000/
    );
    assert.equal((await read()).resource.revision, beforeObjects.resource.revision);
    assert.deepEqual((await read()).snapshot.content, beforeObjects.snapshot.content);
    const detailed = await command("blender_run_python", { source: generate(24, true), resetScene: true });
    assert.equal(detailed.result.scene.objectCount, 24);
    assert.equal(detailed.result.scene.triangles, 1966080);
    const beforeTriangles = await read();
    await assert.rejects(
      command("blender_run_python", { source: generate(25, true), resetScene: true }),
      /三角面超过 200 万/
    );
    assert.equal((await read()).resource.revision, beforeTriangles.resource.revision);
    assert.deepEqual((await read()).snapshot.content, beforeTriangles.snapshot.content);
  }
);

test("Blender deadlines accept a ten-minute native job and reject invalid limits without saving", () => {
  assert.equal(timeout(undefined), 180000);
  assert.equal(timeout(undefined, BLENDER_COMPUTE_LIMITS.renderTimeoutSeconds), 300000);
  assert.equal(timeout(undefined, BLENDER_COMPUTE_LIMITS.queryTimeoutSeconds), 60000);
  assert.equal(timeout(600), 600000);
  for (const value of [0, -1, 601, 1.5, Infinity, NaN, "600"])
    assert.throws(
      () => timeout(value),
      (error) => error.code === "invalid_operation" && error.details.sourceSaved === false
    );
});

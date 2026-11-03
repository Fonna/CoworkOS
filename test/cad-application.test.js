import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
import { CAD_KIND, defaultPart, normalizeModel, applyCadOperation } from "../dist/src/software/cad/model.js";
import { MAX_PARTS } from "../dist/src/software/cad/model.js";
import { createPlacedPart, duplicatePart, partBounds } from "../dist/src/software/cad/interaction.js";
import { buildGeometry, inspectGeometry, geometryMesh } from "../dist/src/software/cad/geometry.js";
import { CadDocumentSession } from "../web/assets/cad/document-session.js";
const actor = { type: "user", id: "local" };
const box = () => defaultPart("box", "body");
const model = (parts = [box()]) => ({ version: 1, units: "mm", parts });
const storage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
};
test("CAD creation accepts structured or serialized JSON without relaxing model validation", () => {
  const initial = model();
  assert.deepEqual(
    cadRuntimeAdapter.createContent({ kind: CAD_KIND, title: "模型.cad.json", initialContent: initial }),
    initial
  );
  assert.deepEqual(
    cadRuntimeAdapter.createContent({
      kind: CAD_KIND,
      title: "模型.cad.json",
      initialContent: JSON.stringify(initial)
    }),
    initial
  );
  for (const initialContent of ["not JSON", JSON.stringify({ version: 1, units: "mm", features: [] })])
    assert.throws(
      () => cadRuntimeAdapter.createContent({ kind: CAD_KIND, title: "模型.cad.json", initialContent }),
      (error) => error.code === "invalid_operation"
    );
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({
    taskId: "task-a",
    kind: CAD_KIND,
    title: "模型.cad.json",
    initialContent: model(),
    actor
  });
  const resourceId = created.resource.resourceId;
  const api = {
    readResource: (taskId, id) => service.readResource(taskId, id),
    applyOperation: (taskId, id, body) => service.applyOperation({ taskId, resourceId: id, ...body, actor }),
    undo: (taskId, id) => service.undo({ taskId, resourceId: id, actor })
  };
  return { root, service, resourceId, api };
}
test("CAD refresh acknowledges recovered reads and preserves a draft when the next revision arrives", async (t) => {
  const { service, api, resourceId } = await fixture(t);
  const session = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await session.load();
  await service.applyOperation({
    taskId: "task-a",
    resourceId,
    appType: "cad",
    actor,
    operationId: "stage-one",
    operationType: "cad.upsert",
    baseRevision: 0,
    payload: { part: { ...box(), size: [60, 30, 20] } }
  });
  const read = api.readResource;
  api.readResource = async () => {
    throw new Error("offline");
  };
  assert.equal(await session.refresh(), false);
  assert.equal(session.revision, 0);
  assert.match(session.error, /读取失败/);
  api.readResource = read;
  assert.equal(await session.refresh(), true);
  assert.equal(session.revision, 1);
  assert.equal(session.error, "");
  session.edit(model([{ ...box(), size: [70, 30, 20] }]));
  await service.applyOperation({
    taskId: "task-a",
    resourceId,
    appType: "cad",
    actor,
    operationId: "stage-two",
    operationType: "cad.upsert",
    baseRevision: 1,
    payload: { part: { ...box(), size: [80, 30, 20] } }
  });
  assert.equal(await session.refresh(), true);
  assert.equal(session.model.parts[0].size[0], 70);
  assert.match(session.error, /草稿已保留/);
});

test("a clean CAD session retries the original-file checkpoint and reports a failed write", async (t) => {
  const { api, resourceId } = await fixture(t);
  const session = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await session.load();
  session.resource.sourceFile = { path: "/Documents/model.cad.json", savedRevision: -1 };
  api.saveSourceFile = async () => {
    throw new Error("disk unavailable");
  };
  assert.equal(await session.save(), false);
  assert.match(session.error, /disk unavailable/);
  api.saveSourceFile = async (_task, _id, revision) => ({
    resource: { ...session.resource, sourceFile: { ...session.resource.sourceFile, savedRevision: revision } }
  });
  assert.equal(await session.save(), true);
  assert.equal(session.resource.sourceFile.savedRevision, session.revision);
  assert.equal(session.error, "");
});
test("CAD validates versions, dimensions, identifiers, unknown fields and finite values", () => {
  for (const invalid of [
    { ...model(), version: 2 },
    { ...model(), units: "inch" },
    model([{ ...box(), size: [0, 2, 3] }]),
    model([{ ...box(), radius: NaN }]),
    model([{ ...box(), position: [0, Infinity, 0] }]),
    model([{ ...box(), shape: "eval" }]),
    model([{ ...box(), mode: "cut" }]),
    model([box(), box()]),
    { ...model(), source: "throw new Error()" },
    model(Array.from({ length: MAX_PARTS + 1 }, (_, i) => ({ ...box(), id: `p${i}` })))
  ])
    assert.throws(() => normalizeModel(invalid));
  assert.throws(() => applyCadOperation(model(), "cad.upsert", { part: { ...box(), id: "../x" } }));
});
test("real JSCAD solids produce expected dimensions, volume, rotation and subtraction", () => {
  const cube = buildGeometry(model());
  assert.deepEqual(inspectGeometry(cube).dimensions, [40, 30, 20]);
  assert.ok(Math.abs(inspectGeometry(cube).volume - 24000) < 0.001);
  const rotated = buildGeometry(model([{ ...box(), rotation: [0, 0, 90] }]));
  assert.ok(Math.abs(inspectGeometry(rotated).dimensions[0] - 30) < 0.001);
  const hole = { ...defaultPart("cylinder", "hole"), mode: "cut", radius: 5, height: 30 };
  const cut = buildGeometry(model([box(), hole]));
  assert.ok(Math.abs(inspectGeometry(cut).volume - (24000 - Math.PI * 25 * 20)) < 20);
  const positions = geometryMesh(cut);
  assert.ok(positions.length > 100 && positions.every(Number.isFinite));
  assert.deepEqual(inspectGeometry(buildGeometry(model([]))).dimensions, [0, 0, 0]);
});
test("CAD uses the existing resource store for persistence, sharing, CAS, idempotency, undo and selection", async (t) => {
  const { root, service, resourceId } = await fixture(t);
  await service.referenceIntoTask({ taskId: "task-b", fromTaskId: "task-a", resourceId });
  const edit = {
    taskId: "task-b",
    resourceId,
    appType: "cad",
    operationId: "edit",
    operationType: "cad.upsert",
    baseRevision: 0,
    payload: { part: { ...box(), size: [60, 30, 20] } },
    actor
  };
  await service.applyOperation(edit);
  const duplicate = await service.applyOperation(edit);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(
    (await new ApplicationService(root).readResource("task-a", resourceId)).snapshot.content.parts[0].size[0],
    60
  );
  await assert.rejects(
    service.applyOperation({ ...edit, operationId: "stale" }),
    (error) => error.code === "revision_conflict"
  );
  const selection = await service.saveSelection({
    taskId: "task-a",
    resourceId,
    schema: "cad.feature/v1",
    data: { id: "body" },
    actor
  });
  assert.match(selection.summary, /body/);
  const cleared = await service.saveSelection({
    taskId: "task-a",
    resourceId,
    schema: "cad.feature/v1",
    data: {},
    actor
  });
  assert.equal(cleared.summary, "未选中模型部件");
  const afterClear = await service.readResource("task-b", resourceId);
  assert.deepEqual(afterClear.selection.data, {});
  assert.equal(afterClear.resource.revision, 1, "clearing selection does not edit the design");
  const exported = await service.renderForDownload({ taskId: "task-a", resourceId, format: "json" });
  assert.equal(JSON.parse(exported.body).parts[0].size[0], 60);
  await service.undo({ taskId: "task-b", resourceId, actor });
  assert.equal((await service.readResource("task-a", resourceId)).snapshot.content.parts[0].size[0], 40);
});
test("bound CAD tools read and emit validated operations that the same store accepts", async (t) => {
  const { service, resourceId } = await fixture(t);
  const read = await service.readResource("task-a", resourceId);
  const tools = cadRuntimeAdapter.agentTools();
  const readTool = tools.find((tool) => tool.name === "cad_read_model");
  assert.equal(
    (await readTool.execute({ params: {}, content: read.snapshot.content, resource: read.resource })).result
      .model.units,
    "mm"
  );
  const tool = tools.find((tool) => tool.name === "cad_upsert_part");
  const result = await tool.execute({
    params: { part: { ...box(), size: [80, 30, 20] } },
    content: read.snapshot.content,
    resource: read.resource
  });
  await service.applyOperation({
    taskId: "task-a",
    resourceId,
    operationId: "agent",
    appType: "cad",
    baseRevision: read.resource.revision,
    ...result.operations[0],
    actor: { type: "agent", id: "main" }
  });
  assert.equal((await service.readResource("task-a", resourceId)).snapshot.content.parts[0].size[0], 80);
  await assert.rejects(
    tool.execute({
      params: { part: { ...box(), size: [-1, 3, 4] } },
      content: read.snapshot.content,
      resource: read.resource
    })
  );
});
test("CAD batch edits commit one revision and undo together; invalid batches change nothing", async (t) => {
  const { service, resourceId } = await fixture(t);
  const edit = (payload, operationId, baseRevision = 0) =>
    service.applyOperation({
      taskId: "task-a",
      resourceId,
      appType: "cad",
      operationId,
      operationType: "cad.edit",
      baseRevision,
      payload,
      actor
    });
  await assert.rejects(
    edit(
      {
        upsert: [
          { id: "hole", shape: "cylinder", mode: "cut" },
          { id: "bad", shape: "box", size: [-1, 2, 3] }
        ]
      },
      "bad"
    )
  );
  const unchanged = await service.readResource("task-a", resourceId);
  assert.equal(unchanged.resource.revision, 0);
  assert.deepEqual(unchanged.snapshot.content, model());
  await edit(
    {
      remove: ["body"],
      upsert: [
        { id: "plate", shape: "box", size: [80, 30, 8] },
        { id: "hole", shape: "cylinder", mode: "cut", radius: 4, height: 10 }
      ]
    },
    "batch"
  );
  const saved = await service.readResource("task-a", resourceId);
  assert.equal(saved.resource.revision, 1);
  assert.deepEqual(
    saved.snapshot.content.parts.map((p) => p.id),
    ["plate", "hole"]
  );
  await assert.rejects(
    edit({ upsert: [{ id: "plate", shape: "box" }] }, "stale"),
    (error) => error.code === "revision_conflict"
  );
  await service.undo({ taskId: "task-a", resourceId, actor });
  assert.deepEqual((await service.readResource("task-a", resourceId)).snapshot.content, model());
});
test("CAD batch edits preserve untouched features and order, rejecting ambiguous IDs and limits", () => {
  const original = model([box(), defaultPart("cylinder", "post")]);
  const next = applyCadOperation(original, "cad.edit", {
    upsert: [
      { id: "post", shape: "cylinder", radius: 3 },
      { id: "top", shape: "sphere", radius: 5 }
    ]
  });
  assert.deepEqual(
    next.parts.map((p) => p.id),
    ["body", "post", "top"]
  );
  assert.deepEqual(next.parts[0], original.parts[0]);
  assert.equal(original.parts[1].radius, 10, "input snapshot must remain unchanged");
  for (const payload of [
    {},
    { remove: ["unknown"] },
    { upsert: [box(), box()] },
    { upsert: [box()], remove: ["body"] },
    { remove: ["body", "body"] },
    { remove: ["body", "post"], upsert: [{ id: "hole", shape: "cylinder", mode: "cut" }] },
    { upsert: Array.from({ length: MAX_PARTS }, (_, i) => ({ id: `new${i}`, shape: "box" })) },
    { upsert: [], extra: true }
  ])
    assert.throws(() => applyCadOperation(original, "cad.edit", payload));
});
test("interactive additions stay visible beside rotated, translated and 32-feature models", () => {
  const rocket = model(
    Array.from({ length: 32 }, (_, i) => ({
      ...box(),
      id: `p${i}`,
      position: [150, 20, 100],
      rotation: [15, 30, 45]
    }))
  );
  const sphere = createPlacedPart(rocket, "sphere", "newBall", "p0");
  assert.ok(partBounds(sphere).min[0] > partBounds(rocket.parts[0]).max[0]);
  assert.deepEqual(sphere.position.slice(1), [20, 100]);
  assert.equal(normalizeModel({ ...rocket, parts: [...rocket.parts, sphere] }).parts.length, 33);
  const copy = duplicatePart(rocket, "p0", "copy");
  assert.deepEqual(copy.rotation, [15, 30, 45]);
  assert.deepEqual(copy.size, box().size);
  assert.ok(partBounds(copy).min[0] > partBounds(rocket.parts[0]).max[0]);
  assert.deepEqual(createPlacedPart(model([]), "sphere", "first").position, [0, 0, 0]);
  const edge = model([{ ...box(), position: [1990, 0, 0] }]);
  assert.ok(createPlacedPart(edge, "sphere", "next").position[0] < 1990);
});
test("cancelled interactive drafts restore both saved state and pre-existing unsaved edits", async (t) => {
  const { api, resourceId } = await fixture(t);
  const session = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await session.load();
  const saved = session.captureDraft();
  session.edit(model([{ ...box(), position: [15, 10, 5] }]));
  session.restoreDraft(saved);
  assert.equal(session.dirty, false);
  assert.deepEqual(session.model, model());
  session.edit(model([{ ...box(), size: [55, 30, 20] }]));
  const draft = session.captureDraft();
  session.edit(model([{ ...box(), size: [55, 30, 20], rotation: [0, 0, 45] }]));
  session.restoreDraft(draft);
  assert.equal(session.dirty, true);
  assert.equal(session.model.parts[0].size[0], 55);
  assert.deepEqual(session.model.parts[0].rotation, [0, 0, 0]);
  await session.save();
  assert.throws(() => session.restoreDraft(saved), /保存状态已变化/);
});
test("failed CAD saves persist drafts and retry the same operation after a lost acknowledgement", async (t) => {
  const { api, resourceId } = await fixture(t);
  const cache = storage();
  let first = true;
  const ids = [];
  const flaky = {
    ...api,
    async applyOperation(task, id, body) {
      ids.push(body.operationId);
      const result = await api.applyOperation(task, id, body);
      if (first) {
        first = false;
        throw new Error("response lost");
      }
      return result;
    }
  };
  const session = new CadDocumentSession({ api: flaky, taskId: "task-a", resourceId, storage: cache });
  await session.load();
  session.edit(model([{ ...box(), size: [65, 30, 20] }]));
  assert.equal(await session.save(), false);
  const restarted = new CadDocumentSession({ api: flaky, taskId: "task-a", resourceId, storage: cache });
  await restarted.load();
  assert.equal(restarted.dirty, true);
  assert.equal(await restarted.save(), true);
  assert.equal(ids[0], ids[1]);
  assert.equal(restarted.revision, 1);
});
test("concurrent CAD edits preserve the draft on conflict, and failed reload cannot erase it", async (t) => {
  const { api, resourceId } = await fixture(t);
  const a = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  const b = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await Promise.all([a.load(), b.load()]);
  a.edit(model([{ ...box(), size: [50, 30, 20] }]));
  b.edit(model([{ ...box(), size: [70, 30, 20] }]));
  assert.equal(await a.save(), true);
  assert.equal(await b.save(), false);
  assert.equal(b.model.parts[0].size[0], 70);
  assert.equal(b.dirty, true);
  b.api = {
    ...api,
    readResource: async () => {
      throw new Error("offline");
    }
  };
  await assert.rejects(b.reload());
  assert.equal(b.model.parts[0].size[0], 70);
  b.api = api;
  await b.reload();
  assert.equal(b.model.parts[0].size[0], 50);
});
test("a delayed CAD poll cannot roll back a newer successful save", async (t) => {
  const { api, resourceId } = await fixture(t);
  const session = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await session.load();
  const stale = await api.readResource("task-a", resourceId);
  let finish;
  session.api = {
    ...api,
    readResource: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  };
  const refreshing = session.refresh();
  session.api = api;
  session.edit(model([{ ...box(), size: [77, 30, 20] }]));
  assert.equal(await session.save(), true);
  finish(stale);
  await refreshing;
  assert.equal(session.revision, 1);
  assert.equal(session.model.parts[0].size[0], 77);
});

test("a poll already in flight cannot replace a CAD gesture's starting revision", async (t) => {
  const { api, resourceId } = await fixture(t);
  const session = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await session.load();
  let finish;
  session.api = {
    ...api,
    readResource: () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  };
  const refreshing = session.refresh();
  session.pauseRefresh();
  const draft = session.captureDraft();
  const collaborator = new CadDocumentSession({ api, taskId: "task-a", resourceId, storage: storage() });
  await collaborator.load();
  collaborator.edit(model([{ ...box(), size: [80, 30, 20] }]));
  assert.equal(await collaborator.save(), true);
  session.api = api;
  await session.refresh();
  assert.equal(session.revision, draft.revision);
  session.restoreDraft(draft);
  session.resumeRefresh();
  finish(await api.readResource("task-a", resourceId));
  await refreshing;
  assert.equal(session.revision, draft.revision);
  await session.refresh();
  assert.equal(session.revision, collaborator.revision);
  assert.equal(session.model.parts[0].size[0], 80);
});

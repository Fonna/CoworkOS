import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProgram } from "../dist/src/software/cad/program-engine.js";
import { CAD_PROGRAM_KIND, CADQUERY_PROGRAM_KIND, emptyProgram } from "../dist/src/software/cad/program.js";
import { programFromModel } from "../dist/src/software/cad/program-migration.js";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
import { defaultPart, CAD_KIND } from "../dist/src/software/cad/model.js";
import { buildGeometry, inspectGeometry } from "../dist/src/software/cad/geometry.js";
import { CadDocumentSession } from "../web/assets/cad/document-session.js";
import { normalizeProgram } from "../dist/src/software/cad/program.js";
const actor = { type: "user", id: "local" };
test("clearing a source CAD selection persists an empty selection without changing the design", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  for (const kind of [CAD_PROGRAM_KIND, CADQUERY_PROGRAM_KIND]) {
    const created = await service.createResource({ taskId: "task-a", kind, title: "选区.cad.json", actor });
    const request = {
      taskId: "task-a",
      resourceId: created.resource.resourceId,
      schema: "cad.program-solid/v1",
      actor
    };
    await service.saveSelection({ ...request, data: { id: "solid_0" } });
    await service.saveSelection({ ...request, data: {} });
    const read = await service.readResource("task-a", request.resourceId);
    assert.deepEqual(read.selection.data, {});
    assert.equal(read.selection.summary, "未选中模型部件");
    assert.equal(read.resource.revision, 0);
    for (const data of [{ id: "missing" }, { other: true }, null, []])
      await assert.rejects(
        service.saveSelection({ ...request, data }),
        (error) => error.code === "invalid_operation"
      );
  }
});
test("new JSCAD documents start empty instead of displaying a cylinder sample", () => {
  const created = cadRuntimeAdapter.createContent({ kind: CAD_PROGRAM_KIND });
  assert.deepEqual(created.parameters, {});
  assert.equal(evaluateProgram(created).features.length, 0);
});
const program = (source, parameters = {}) => ({
  version: 2,
  engine: "jscad",
  units: "mm",
  source,
  parameters
});
const rocket = await readFile("test/fixtures/cad-rocket.jscad", "utf8");
test("full kernel builds actual revolved profiles, extruded fins, hollow body and tapered boosters", () => {
  const shape = evaluateProgram(program(rocket), { exportStl: true });
  assert.equal(shape.features.length, 14);
  assert.ok(shape.features.some((f) => f.name === "旋转轮廓整流罩"));
  assert.ok(shape.dimensions[2] > 180);
  assert.ok(shape.positions.every(Number.isFinite));
  assert.equal(shape.definitions.length, 4);
  const bytes = Uint8Array.from(shape.stl);
  const n = new DataView(bytes.buffer).getUint32(80, true);
  assert.equal(bytes.length, 84 + 50 * n);
  assert.ok(n > 4000, "STL contains the full curved model");
});
test("program loops can return more than the old 64-feature schema allowed", () => {
  const shape = evaluateProgram(
    program(
      "const {cuboid}=require('@jscad/modeling').primitives;const {translate}=require('@jscad/modeling').transforms;module.exports.main=()=>Array.from({length:80},(_,i)=>translate([i*3,0,0],cuboid({size:[1,1,1]})));"
    )
  );
  assert.equal(shape.features.length, 80);
  assert.equal(shape.dimensions[0], 238);
});
test("full-quality JSCAD meshes exceed the old part and aggregate budgets and export every triangle", () => {
  const shape = evaluateProgram(
    program(`const {torus}=require('@jscad/modeling').primitives;
const {translate}=require('@jscad/modeling').transforms;
module.exports.main=()=>{
  const ring=torus({innerRadius:5,outerRadius:20,innerSegments:256,outerSegments:256});
  return [ring,translate([60,0,0],ring)];
};`),
    { exportStl: true }
  );
  assert.equal(shape.features.length, 2);
  assert.equal(shape.features[0].positions.length / 9, 131072);
  assert.equal(shape.features[1].positions.length / 9, 131072);
  assert.equal(shape.positions.length / 9, 262144);
  const bytes = Uint8Array.from(shape.stl);
  const triangles = new DataView(bytes.buffer).getUint32(80, true);
  assert.equal(triangles, shape.positions.length / 9);
  assert.equal(bytes.length, 84 + 50 * triangles);
  assert.ok(bytes.length > 12_000_000);
  assert.ok(shape.positions.every(Number.isFinite));
});
test("source errors, parameter bounds and unavailable host capabilities fail without escaping the interpreter", () => {
  for (const source of [
    "require('node:fs'); module.exports.main=()=>[];",
    "fetch('http://localhost'); module.exports.main=()=>[];",
    "process.exit();",
    "const x = ;",
    "module.exports.main=()=>Promise.resolve([]);",
    "module.exports.main=()=>({positions:[1,2,3]});"
  ]) {
    assert.throws(() => evaluateProgram(program(source)), /CAD 编译失败/);
  }
  assert.throws(() => evaluateProgram(program(rocket, { radius: 1 })), /超出范围/);
  assert.throws(() => evaluateProgram(program(rocket, { resolution: 23.4 })), /整数/);
  assert.equal(evaluateProgram(emptyProgram()).dimensions[2], 60);
});
test("an infinite loop is interrupted and does not poison the next independent runtime", () => {
  assert.throws(
    () => evaluateProgram(program("module.exports.main=()=>{while(true){}}"), { timeoutMs: 80 }),
    /超时/
  );
  assert.equal(evaluateProgram(emptyProgram()).features.length, 1);
});
test("forged guest result cannot allocate an unbounded host mesh", () => {
  const source = `JSON.stringify=()=>'{"positions":1000000000000,"features":[],"dimensions":[1,1,1],"volume":1,"definitions":[],"parameters":{}}';module.exports.main=()=>[];`;
  assert.throws(() => evaluateProgram(program(source)), /网格/);
});
async function fixture(t, kind = CAD_PROGRAM_KIND, initialContent = emptyProgram()) {
  const root = await mkdtemp(join(tmpdir(), "atria-source-cad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({
    taskId: "a",
    kind,
    title: "设计.cad.json",
    initialContent,
    actor
  });
  const resourceId = created.resource.resourceId;
  const edit = (operationId, baseRevision, operationType, payload) =>
    service.applyOperation({
      taskId: "a",
      resourceId,
      appType: "cad",
      operationId,
      baseRevision,
      operationType,
      payload,
      actor
    });
  return { service, resourceId, edit };
}
test("source and manual parameters share CAS, document validation, retries, history and undo", async (t) => {
  const { service, resourceId, edit } = await fixture(t);
  await edit("source", 0, "cad.program.replace", { program: program(rocket) });
  await edit("human", 1, "cad.program.parameters", { parameters: { radius: 23 } });
  const before = await service.readResource("a", resourceId);
  const write = cadRuntimeAdapter.agentTools().find((t) => t.name === "cad_write_program");
  const result = await write.execute({
    params: { source: rocket + "\n// agent refinement" },
    content: before.snapshot.content,
    resource: before.resource
  });
  await edit("agent", 2, result.operations[0].operationType, result.operations[0].payload);
  assert.equal((await service.readResource("a", resourceId)).snapshot.content.parameters.radius, 23);
  await assert.rejects(
    edit("invalid", 3, "cad.program.replace", { program: { ...program(rocket), engine: "unknown" } }),
    /engine/
  );
  assert.equal((await service.readResource("a", resourceId)).resource.revision, 3);
  await assert.rejects(
    edit("stale", 1, "cad.program.parameters", { parameters: { radius: 10 } }),
    (e) => e.code === "revision_conflict"
  );
  assert.equal(
    (await edit("agent", 2, result.operations[0].operationType, result.operations[0].payload)).deduplicated,
    true
  );
  await service.undo({ taskId: "a", resourceId, actor });
  const after = await service.readResource("a", resourceId);
  assert.equal(after.snapshot.content.source, rocket);
  assert.equal(after.snapshot.content.parameters.radius, 23);
});
test("legacy upgrade preserves geometry and IDs in source, uses the same resource and reverses to the old document", async (t) => {
  const old = {
    version: 1,
    units: "mm",
    parts: [
      defaultPart("box", "manual_part"),
      { ...defaultPart("cylinder", "hole"), mode: "cut", height: 40, radius: 3 }
    ]
  };
  const converted = programFromModel(old),
    shape = evaluateProgram(converted),
    original = inspectGeometry(buildGeometry(old));
  assert.deepEqual(shape.dimensions, original.dimensions);
  assert.ok(Math.abs(shape.volume - original.volume) < 0.01);
  assert.match(converted.source, /manual_part/);
  const { service, resourceId, edit } = await fixture(t, CAD_KIND, old);
  await edit("upgrade", 0, "cad.program.replace", { program: converted });
  assert.equal((await service.readResource("a", resourceId)).snapshot.content.version, 2);
  await service.undo({ taskId: "a", resourceId, actor });
  assert.deepEqual((await service.readResource("a", resourceId)).snapshot.content, old);
});
test("source export retains effective human parameter values and is executable as native JSCAD", async (t) => {
  const { service, resourceId, edit } = await fixture(t);
  await edit("params", 0, "cad.program.parameters", { parameters: { radius: 25, height: 75 } });
  const file = await service.renderForDownload({ taskId: "a", resourceId, format: "jscad" });
  assert.ok(file.fileName.endsWith(".jscad"));
  assert.equal(typeof file.body, "string");
  const shape = evaluateProgram(program(file.body));
  assert.deepEqual(shape.dimensions, [50, 50, 75]);
});
test("even an empty invalid source draft survives reload and a failed save", async (t) => {
  const { service, resourceId } = await fixture(t);
  const data = new Map();
  const storage = {
    getItem: (k) => data.get(k),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k)
  };
  const api = {
    readResource: (taskId, id) => service.readResource(taskId, id),
    applyOperation: (taskId, id, body) => service.applyOperation({ taskId, resourceId: id, ...body, actor })
  };
  const create = () =>
    new CadDocumentSession({
      api,
      taskId: "a",
      resourceId,
      storage,
      normalize: normalizeProgram,
      operationType: "cad.program.replace",
      payloadKey: "program"
    });
  const session = create();
  await session.load();
  session.edit({ ...session.model, source: "" });
  assert.equal(await session.save(), false);
  const restored = create();
  await restored.load();
  assert.equal(restored.model.source, "");
  assert.equal(restored.dirty, true);
  assert.equal((await service.readResource("a", resourceId)).snapshot.content.source, emptyProgram().source);
});

test("API discovery exposes the installed full kernel and rejects unknown modules", async () => {
  const tool = cadRuntimeAdapter.agentTools().find((tool) => tool.name === "cad_get_api_reference");
  const { result } = await tool.execute({ params: { module: "extrusions" } });
  assert.ok(result.modules.extrusions.includes("extrudeRotate"));
  assert.ok(result.modules.extrusions.includes("extrudeFromSlices"));
  assert.ok(result.installedApi.some((item) => item.declarations.includes("ExtrudeRotateOptions")));
  const rotation = await tool.execute({ params: { module: "transforms", member: "rotateX" } });
  assert.match(rotation.result.installedApi[0].declarations, /rotateX.*angle: number/);
  await assert.rejects(tool.execute({ params: { module: "transforms", member: "unknown" } }), /member/);
  await assert.rejects(tool.execute({ params: { module: "not_a_module" } }), /未知 JSCAD/);
});

test("migration supports legacy IDs with hyphens without colliding with underscore IDs", () => {
  const model = {
    version: 1,
    units: "mm",
    parts: [defaultPart("box", "a-b"), { ...defaultPart("box", "a_b"), position: [60, 0, 0] }]
  };
  const converted = programFromModel(model);
  const original = evaluateProgram(converted);
  assert.equal(new Set(original.definitions.map((d) => d.name)).size, original.definitions.length);
  const edited = evaluateProgram({ ...converted, parameters: { part0_size0: 50 } });
  assert.deepEqual(edited.dimensions, [105, 30, 20]);
  assert.match(converted.source, /a-b/);
});

test("empty optional initial content creates blank CAD while malformed nonempty content still fails", () => {
  for (const initialContent of ["", "  "]) {
    const source = cadRuntimeAdapter.createContent({ kind: CAD_PROGRAM_KIND, initialContent });
    assert.equal(evaluateProgram(source).features.length, 0);
    assert.deepEqual(cadRuntimeAdapter.createContent({ kind: CAD_KIND, initialContent }).parts, []);
  }
  assert.throws(
    () => cadRuntimeAdapter.createContent({ kind: CAD_PROGRAM_KIND, initialContent: "{" }),
    /JSON/
  );
});

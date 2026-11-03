import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { previewProgram } from "../dist/src/software/cad/program-preview.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
import {
  CAD_PROGRAM_KIND,
  CADQUERY_PROGRAM_KIND,
  emptyProgram,
  emptyCadQueryProgram
} from "../dist/src/software/cad/program.js";
const actor = { type: "user", id: "local" };
const run = cadRuntimeAdapter.agentTools().find((tool) => tool.name === "cad_run_program");
const source = `const {cuboid}=require('@jscad/modeling').primitives;
module.exports.getParameterDefinitions=()=>[{name:'width',type:'float',initial:60},{name:'height',type:'float',initial:20}];
module.exports.main=p=>cuboid({size:[p.width,40,p.height]});`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-cad-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new ApplicationService(root);
  const created = await service.createResource({
    taskId: "task",
    kind: CAD_PROGRAM_KIND,
    title: "设计.cad.json",
    initialContent: { ...emptyProgram(), source, parameters: { width: 100 } },
    actor
  });
  const id = created.resource.resourceId;
  const read = () => service.readResource("task", id);
  const apply = (snapshot, op) =>
    service.applyOperation({
      taskId: "task",
      resourceId: id,
      appType: "cad",
      operationId: crypto.randomUUID(),
      baseRevision: snapshot.resource.revision,
      actor,
      ...op
    });
  return { service, id, read, apply };
}
test("run validates and commits one operation, merging explicit changes with manual parameters", async (t) => {
  const { read, apply, service, id } = await fixture(t);
  const before = await read();
  const result = await run.execute({
    content: before.snapshot.content,
    resource: before.resource,
    params: { source: source + "\n// refinement", parameters: { height: 30 } }
  });
  assert.equal(result.result.status, "ready");
  assert.deepEqual(result.result.dimensions, [100, 40, 30]);
  assert.equal(result.images.length, 1);
  assert.equal(result.operations.length, 1);
  await apply(before, result.operations[0]);
  const after = await read();
  assert.equal(after.resource.revision, 1);
  assert.deepEqual(after.snapshot.content.parameters, { width: 100, height: 30 });
  await service.undo({ taskId: "task", resourceId: id, actor });
  assert.equal((await read()).snapshot.content.source, source);
  assert.equal((await read()).snapshot.content.parameters.width, 100);
});
test("failed, empty, cancelled and invalid candidates never replace the saved design", async (t) => {
  const { read } = await fixture(t);
  const before = await read();
  for (const params of [
    { source: "const syntax = ;" },
    { source: "module.exports.main=()=>[]" },
    { engine: "cadquery" },
    { timeoutSeconds: 0 },
    { parameters: { width: NaN } }
  ]) {
    await assert.rejects(
      run.execute({ content: before.snapshot.content, resource: before.resource, params }),
      (e) => e.code === "invalid_operation" && e.details.sourceSaved === false
    );
    assert.deepEqual((await read()).snapshot.content, before.snapshot.content);
    assert.equal((await read()).resource.revision, 0);
  }
  await assert.rejects(
    run.execute({
      content: before.snapshot.content,
      resource: before.resource,
      params: {},
      signal: AbortSignal.abort()
    })
  );
  assert.equal((await read()).resource.revision, 0);
});
test("candidate feedback distinguishes unchanged metrics from a real cut without blocking refactoring", async (t) => {
  const { read, apply } = await fixture(t);
  const before = await read();
  assert.equal((await previewProgram(before.snapshot.content)).status, "ready");
  const refactor = await run.execute({
    content: before.snapshot.content,
    resource: before.resource,
    params: { source: source + "\n// equivalent source" }
  });
  assert.equal(refactor.result.changeSummary.metricsChanged, false);
  assert.match(refactor.result.warnings[0], /指标未变化/);
  assert.equal(refactor.operations.length, 1);
  await apply(before, refactor.operations[0]);
  const current = await read();
  const cut = await run.execute({
    content: current.snapshot.content,
    resource: current.resource,
    params: {
      source:
        source +
        "\nconst {subtract}=require('@jscad/modeling').booleans; const {cylinder}=require('@jscad/modeling').primitives; module.exports.main=p=>subtract(cuboid({size:[p.width,40,p.height]}),cylinder({radius:4,height:40,segments:32}));"
    }
  });
  assert.equal(cut.result.changeSummary.metricsChanged, true);
  assert.ok(cut.result.changeSummary.volumeDelta < -900);
  assert.equal(cut.result.assessment.completeness, "not_declared");
  assert.match(cut.result.warnings[0], /未声明部件验收清单/);
  assert.equal(cut.result.parameters.width, 100);
});
test("a human edit during candidate computation wins CAS; stale validation cannot overwrite it", async (t) => {
  const { read, apply } = await fixture(t);
  const before = await read();
  const pending = run.execute({
    content: before.snapshot.content,
    resource: before.resource,
    params: { parameters: { height: 30 } }
  });
  await apply(before, { operationType: "cad.program.parameters", payload: { parameters: { width: 120 } } });
  const result = await pending;
  await assert.rejects(apply(before, result.operations[0]), (e) => e.code === "revision_conflict");
  const after = await read();
  assert.equal(after.snapshot.content.parameters.width, 120);
  assert.equal(after.snapshot.content.parameters.height, undefined);
});
test("bound tools match the document format, and CAD is absent from TXT and unbound context", async (t) => {
  const { service } = await fixture(t);
  const native = await service.createResource({
    taskId: "task",
    kind: CADQUERY_PROGRAM_KIND,
    title: "精确.cad.json",
    actor
  });
  await service.bindResource("task", native.resource.resourceId);
  const bound = await service.boundCapabilities({ taskId: "task", agentId: "main" });
  const names = bound.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["cad_get_api_reference", "cad_preview", "cad_read_model", "cad_run_program"]);
  const context = await service.activeContext({ taskId: "task", agentId: "main" });
  assert.deepEqual([...context.availableToolNames].sort(), names);
  assert.ok(
    cadRuntimeAdapter.agentTools({ content: emptyProgram() }).some((t) => t.name === "cad_write_program")
  );
  assert.equal(
    cadRuntimeAdapter.agentTools({ content: emptyProgram() }).some((t) => t.name === "cad_upsert_part"),
    false
  );
  const txt = await service.createResource({
    taskId: "task",
    kind: "text/plain",
    title: "说明.txt",
    initialContent: "文字",
    actor
  });
  await service.bindResource("task", txt.resource.resourceId);
  const text = await service.boundCapabilities({ taskId: "task", agentId: "main" });
  assert.equal(
    text.tools.some((tool) => tool.name.startsWith("cad_")),
    false
  );
  assert.deepEqual(text.skillRoots, []);
  assert.equal(await service.boundCapabilities({ taskId: "unrelated", agentId: "main" }), undefined);
});
const native = process.platform === "darwin" ? test : test.skip;
native("native timeout does not block independent TXT edits and recovery", async (t) => {
  const { service, read } = await fixture(t);
  const saved = await read();
  const nativeProgram = { ...emptyCadQueryProgram(), source: "def main(p):\n    while True: pass" };
  const failed = run.execute({
    content: nativeProgram,
    resource: saved.resource,
    params: { timeoutSeconds: 1 }
  });
  const txt = await service.createResource({
    taskId: "text",
    kind: "text/plain",
    title: "independent.txt",
    initialContent: "before",
    actor
  });
  await service.applyOperation({
    taskId: "text",
    resourceId: txt.resource.resourceId,
    appType: "text-editor",
    operationId: "text-edit",
    baseRevision: 0,
    operationType: "text.replace",
    payload: { from: 0, to: 6, text: "after" },
    actor
  });
  assert.equal((await service.readResource("text", txt.resource.resourceId)).snapshot.content, "after");
  await assert.rejects(failed, (e) => e.details.sourceSaved === false && /超时/.test(e.message));
  const recovered = await run.execute({
    content: emptyCadQueryProgram(),
    resource: saved.resource,
    params: { timeoutSeconds: 60 }
  });
  assert.equal(recovered.result.brep.valid, true);
  assert.equal((await read()).resource.revision, 0);
});

test("TXT can start and edit without loading modeling engines or API catalogs", async () => {
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import {registerHooks} from 'node:module';
    import {mkdtemp,rm} from 'node:fs/promises';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    registerHooks({resolve(name,ctx,next){if(/@jscad|quickjs|three|api-reference.generated/.test(name))throw new Error('TXT loaded modeling dependency: '+name);return next(name,ctx)}});
    const {ApplicationService}=await import('./dist/src/applications/application-service.js');
    const root=await mkdtemp(join(tmpdir(),'atria-txt-isolation-'));
    try{
      const s=new ApplicationService(root),actor={type:'user',id:'local'};
      const {resource}=await s.createResource({taskId:'t',kind:'text/plain',title:'txt',initialContent:'a',actor});
      await s.applyOperation({taskId:'t',resourceId:resource.resourceId,appType:'text-editor',operationId:'edit',baseRevision:0,operationType:'text.replace',payload:{from:0,to:1,text:'b'},actor});
      if((await s.readResource('t',resource.resourceId)).snapshot.content!=='b')throw new Error('TXT edit failed');
    }finally{await rm(root,{recursive:true,force:true})}
  `
  ]);
});

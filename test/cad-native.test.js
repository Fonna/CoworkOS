import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
import { CADQUERY_PROGRAM_KIND, emptyCadQueryProgram } from "../dist/src/software/cad/program.js";
import {
  cadQueryPython,
  exportCadQuery,
  cadQueryReference
} from "../dist/src/software/cad/cadquery-engine.js";
import { previewProgram, inspectProgram } from "../dist/src/software/cad/program-preview.js";
const native = process.platform === "darwin" ? test : test.skip;
const exec = promisify(execFile);
const actor = { type: "user", id: "local" };
const rocket = await readFile("test/fixtures/cad-rocket.py", "utf8");
const curvedCompoundSource = `import cadquery as cq
def main(p):
    shape = cq.Compound.makeCompound([cq.Solid.makeTorus(20,5).translate((60*i,0,0)) for i in range(4)])
    print('default_part_triangles=' + str(len(shape.tessellate(0.1,0.1)[1])))
    return shape
`;
const curvedAssemblySource = `import cadquery as cq
def main(p):
    root = cq.Assembly(name='rotor',loc=cq.Location(cq.Vector(10,20,30)))
    group = cq.Assembly(name='rings',loc=cq.Location(cq.Vector(0,0,10)),color=cq.Color(1,0,0,1))
    count = 0
    for i in range(7):
        shape = cq.Solid.makeTorus(20,5)
        count += len(shape.tessellate(0.1,0.1)[1])
        group.add(shape,name='ring_'+str(i),loc=cq.Location(cq.Vector(i*60,0,0)),color=cq.Color(0,0,1,0.5) if i%2 else None)
    print('default_total_triangles=' + str(count))
    root.add(group)
    return root
`;
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "atria-native-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function roundtrip(t, bytes) {
  const file = join(await directory(t), "design.step");
  await writeFile(file, bytes);
  assert.match(bytes.toString(), /^ISO-10303-21;/);
  const { stdout } = await exec(
    cadQueryPython(),
    [
      "-I",
      "-B",
      "-c",
      'import cadquery as cq, json, sys; s=cq.importers.importStep(sys.argv[1]).val(); b=s.BoundingBox(); print(json.dumps({"valid":s.isValid(),"solids":len(s.Solids()),"volume":sum(v.Volume() for v in s.Solids()),"dimensions":[b.xlen,b.ylen,b.zlen]}))',
      file
    ],
    { timeout: 120000 }
  );
  return JSON.parse(stdout);
}
function assertFullQualityMesh(preview) {
  assert.equal(preview.status, "ready", preview.error);
  const { geometry, report } = preview;
  assert.deepEqual(report.tessellation, {
    linearTolerance: 0.1,
    angularTolerance: 0.1,
    adjusted: false
  });
  assert.deepEqual(geometry.tessellation, report.tessellation);
  assert.ok(report.triangles > 0 && report.triangles <= 1_000_000);
  assert.equal(geometry.positions.length, report.triangles * 9);
  assert.ok(report.objects.every((object) => object.triangles > 0 && object.triangles <= 1_000_000));
  assert.equal(Buffer.from(preview.png, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
}
function assertColor(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-12, `color[${i}]: ${actual[i]} vs ${expected[i]}`);
}
native(
  "native full-quality compound mesh exceeds the old part budget without changing exact solids",
  async (t) => {
    const program = { ...emptyCadQueryProgram(), source: curvedCompoundSource };
    const preview = await previewProgram(program, 60000);
    assertFullQualityMesh(preview);
    const expected = Number(preview.report.diagnostics.match(/default_part_triangles=(\d+)/)?.[1]);
    assert.ok(expected > 100000);
    assert.equal(preview.report.triangles, expected);
    assert.equal(preview.report.objects.length, 1);
    assert.equal(preview.report.brep.solids, 4);
    assert.ok(Math.abs(preview.report.volume - 4000 * Math.PI ** 2) < 1e-5);
    const imported = await roundtrip(t, await exportCadQuery(program, "step", 60000));
    assert.equal(imported.valid, true);
    assert.equal(imported.solids, 4);
    assert.ok(Math.abs(imported.volume - preview.report.volume) < 1e-4);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(imported.dimensions[i] - preview.report.dimensions[i]) < 1e-4);
  }
);
native(
  "native full-quality assembly previews commit every part and preserve STEP, appearance and cached metadata",
  async (t) => {
    const service = new ApplicationService(await directory(t));
    const created = await service.createResource({
      taskId: "adaptive-task",
      kind: CADQUERY_PROGRAM_KIND,
      title: "curved-assembly.cad.json",
      actor
    });
    const id = created.resource.resourceId;
    let read = await service.readResource("adaptive-task", id);
    const run = cadRuntimeAdapter.agentTools().find((tool) => tool.name === "cad_run_program");
    const submitted = await run.execute({
      content: read.snapshot.content,
      resource: read.resource,
      params: { source: curvedAssemblySource, timeoutSeconds: 60 }
    });
    assert.equal(submitted.result.status, "ready");
    assert.equal(submitted.result.tessellation.adjusted, false);
    assert.ok(!submitted.result.warnings.some((warning) => /调整预览精度/i.test(warning)));
    assert.equal(submitted.operations.length, 1);
    assert.equal(submitted.images.length, 1);
    assert.equal(submitted.images[0].mimeType, "image/png");
    assert.equal(
      Buffer.from(submitted.images[0].data, "base64").subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a"
    );
    for (const operation of submitted.operations) {
      await service.applyOperation({
        taskId: "adaptive-task",
        resourceId: id,
        appType: "cad",
        operationId: crypto.randomUUID(),
        baseRevision: read.resource.revision,
        actor,
        ...operation
      });
      read = await service.readResource("adaptive-task", id);
    }
    assert.equal(read.resource.revision, 1);
    assert.equal(read.snapshot.content.source, curvedAssemblySource);
    assert.equal(read.snapshot.content.tessellation, undefined);
    const program = read.snapshot.content;
    const preview = await previewProgram(program, 1);
    assertFullQualityMesh(preview);
    const expected = Number(preview.report.diagnostics.match(/default_total_triangles=(\d+)/)?.[1]);
    assert.ok(expected > 200000);
    assert.equal(preview.report.triangles, expected);
    assert.ok(Buffer.byteLength(JSON.stringify(preview.geometry)) > 45_000_000);
    assert.deepEqual(preview.report.tessellation, submitted.result.tessellation);
    assert.equal(preview.report.brep.solids, 7);
    assert.equal(preview.geometry.features.length, 7);
    assert.equal(preview.report.assembly.length, 9);
    assert.ok(Math.abs(preview.report.volume - 7000 * Math.PI ** 2) < 1e-5);
    assert.deepEqual(
      preview.report.objects.map((object) => object.path),
      Array.from({ length: 7 }, (_, i) => `/rotor/rings/ring_${i}`)
    );
    for (let i = 0; i < 7; i++) {
      const object = preview.report.objects[i];
      assert.equal(object.name, `rotor/rings/ring_${i}`);
      assertColor(object.color, i % 2 ? [0, 0, 1, 0.5] : [1, 0, 0, 1]);
      assert.deepEqual(preview.geometry.features[i].color, object.color);
      assert.equal(object.brep.valid, true);
      assert.equal(object.brep.solids, 1);
      const expected = [
        [60 * i - 15, -5, 35],
        [60 * i + 35, 45, 45]
      ];
      for (let side = 0; side < 2; side++)
        for (let axis = 0; axis < 3; axis++)
          assert.ok(Math.abs(object.bounds[side][axis] - expected[side][axis]) < 1e-4);
    }
    const expectedTessellation = { ...preview.report.tessellation };
    const expectedPosition = preview.geometry.positions[0];
    preview.report.tessellation.angularTolerance = 100;
    preview.geometry.tessellation.adjusted = true;
    preview.geometry.positions[0] = 10000;
    preview.report.objects[0].name = "caller mutation";
    const reused = await previewProgram(program, 1);
    assert.deepEqual(reused.report.tessellation, expectedTessellation);
    assert.deepEqual(reused.geometry.tessellation, expectedTessellation);
    assert.deepEqual(inspectProgram(program).report.tessellation, expectedTessellation);
    assert.equal(reused.geometry.positions[0], expectedPosition);
    assert.equal(reused.report.objects[0].name, "rotor/rings/ring_0");
    const step = await exportCadQuery(program, "step", 60000);
    const imported = await roundtrip(t, step);
    assert.equal(imported.valid, true);
    assert.equal(imported.solids, 7);
    assert.ok(Math.abs(imported.volume - reused.report.volume) < 1e-4);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(imported.dimensions[i] - reused.report.dimensions[i]) < 1e-4);
    const stepFile = join(await directory(t), "assembly.step");
    await writeFile(stepFile, step);
    const { stdout } = await exec(
      cadQueryPython(),
      [
        "-I",
        "-B",
        "-c",
        "import cadquery as cq, json, sys; a=cq.Assembly.importStep(sys.argv[1]); print(json.dumps([{'name':n,'position':l.toTuple()[0],'color':list(c.toTuple()) if c else None,'solids':len(s.Solids())} for s,n,l,c in a]))",
        stepFile
      ],
      { timeout: 60000 }
    );
    const members = JSON.parse(stdout);
    assert.equal(members.length, 7);
    for (let i = 0; i < 7; i++) {
      const member = members.find((part) => part.name.endsWith(`/rings/ring_${i}`));
      assert.ok(member, JSON.stringify(members.map((part) => part.name)));
      assert.equal(member.solids, 1);
      for (let axis = 0; axis < 3; axis++)
        assert.ok(Math.abs(member.position[axis] - [60 * i + 10, 20, 40][axis]) < 1e-4);
      // STEP retains RGB; transparency support is exporter dependent.
      assertColor(member.color.slice(0, 3), i % 2 ? [0, 0, 1] : [1, 0, 0]);
    }
  }
);
native(
  "native full-quality mesh never submits hard budgets, design assertions or open geometry",
  async (t) => {
    const service = new ApplicationService(await directory(t));
    const original = {
      ...emptyCadQueryProgram(),
      source: "import cadquery as cq\ndef main(p):\n    return cq.Workplane('XY').box(2,3,4)\n"
    };
    const created = await service.createResource({
      taskId: "reject-task",
      kind: CADQUERY_PROGRAM_KIND,
      title: "retained-design.cad.json",
      initialContent: original,
      actor
    });
    const read = await service.readResource("reject-task", created.resource.resourceId);
    const run = cadRuntimeAdapter.agentTools().find((tool) => tool.name === "cad_run_program");
    const candidates = [
      {
        source: `import cadquery as cq
def fixed_mesh(self,*args,**kwargs):
    return [cq.Vector(0,0,0),cq.Vector(1,0,0),cq.Vector(0,1,0)], [(0,1,2)]*1000001
def main(p):
    cq.Shape.tessellate = fixed_mesh
    return cq.Solid.makeTorus(20,5)
`,
        error: /显示网格.*预算/
      },
      {
        source: `import cadquery as cq
def fixed_mesh(self,*args,**kwargs):
    return [cq.Vector(0,0,0),cq.Vector(1,0,0),cq.Vector(0,1,0)], [(0,1,2)]*600001
def main(p):
    cq.Shape.tessellate = fixed_mesh
    return [cq.Workplane('XY').box(2,3,4),cq.Workplane('XY').box(5,6,7)]
`,
        error: /显示网格.*预算/
      },
      {
        source:
          "import cadquery as cq\ndef main(p):\n    assert False, 'required design constraint failed'\n    return cq.Solid.makeTorus(20,5)\n",
        error: /required design constraint failed/
      },
      {
        source: "import cadquery as cq\ndef main(p):\n    return cq.Workplane('XY').circle(5)\n",
        error: /封闭实体/
      }
    ];
    for (const candidate of candidates) {
      await assert.rejects(
        run.execute({
          content: read.snapshot.content,
          resource: read.resource,
          params: { source: candidate.source, timeoutSeconds: 60 }
        }),
        (error) => error.details.sourceSaved === false && candidate.error.test(error.message)
      );
      const retained = await service.readResource("reject-task", created.resource.resourceId);
      assert.equal(retained.resource.revision, 0);
      assert.deepEqual(retained.snapshot.content, read.snapshot.content);
    }
  }
);
native(
  "native spline rocket has valid solids, human parameters, images and a precise STEP roundtrip",
  async (t) => {
    const program = { ...emptyCadQueryProgram(), source: rocket, parameters: { radius: 26 } };
    const preview = await previewProgram(program, 60000);
    assert.equal(preview.status, "ready", preview.error);
    assert.equal(preview.report.brep.valid, true);
    assert.equal(preview.report.brep.solids, 11);
    assert.ok(preview.report.brep.faces > 60);
    assert.equal(preview.report.parameters.radius, 26);
    assert.ok(preview.report.objects.some((o) => o.name === "曲面整流罩"));
    assert.equal(Buffer.from(preview.png, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const saved = await roundtrip(t, await exportCadQuery(program, "step", 60000));
    assert.equal(saved.valid, true);
    assert.equal(saved.solids, 11);
    assert.ok(Math.abs(saved.volume - preview.report.volume) < 1e-4);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(saved.dimensions[i] - preview.report.dimensions[i]) < 1e-4);
    const stl = await exportCadQuery(program, "stl", 60000);
    assert.ok(stl.length > 84);
  }
);
native(
  "new native documents have no sample geometry and empty candidates cannot complete a design",
  async (t) => {
    const service = new ApplicationService(await directory(t));
    const created = await service.createResource({
      taskId: "task",
      kind: CADQUERY_PROGRAM_KIND,
      title: "火箭.cad.json",
      actor
    });
    const read = await service.readResource("task", created.resource.resourceId);
    const preview = await previewProgram(read.snapshot.content);
    assert.equal(preview.status, "ready", preview.error);
    assert.equal(preview.geometry.features.length, 0);
    assert.equal(preview.report.objects.length, 0);
    assert.equal(preview.report.brep, undefined);
    assert.deepEqual(preview.report.parameters, {});
    await assert.rejects(exportCadQuery(read.snapshot.content, "step", 20000), /空模型不能导出/);
    const run = cadRuntimeAdapter.agentTools().find((tool) => tool.name === "cad_run_program");
    await assert.rejects(
      run.execute({
        content: read.snapshot.content,
        resource: read.resource,
        params: { source: "def main(p):\n    return []\n" }
      }),
      /空模型/
    );
    assert.equal((await service.readResource("task", created.resource.resourceId)).resource.revision, 0);
  }
);
native("native API help comes from installed signatures and documentation", async () => {
  const result = await cadQueryReference("Workplane", "loft");
  assert.equal(result.version, "2.6.1");
  assert.match(result.installedApi.loft.signature, /ruled/);
  assert.match(result.installedApi.loft.documentation, /loft/i);
  await assert.rejects(cadQueryReference("Workplane", "__dict__"), /未知/);
  const planes = await cadQueryReference("Plane", "named");
  assert.deepEqual(planes.coordinateFrames.XZ, { x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] });
  assert.deepEqual(planes.coordinateFrames.ZX.normal, [0, 1, 0]);
});
native(
  "native design assertions catch a boolean no-op and return bounded diagnostics without saving it",
  async (t) => {
    const service = new ApplicationService(await directory(t));
    const source = "import cadquery as cq\ndef main(p):\n    return cq.Workplane('XY').box(60,40,10).val()\n";
    const created = await service.createResource({
      taskId: "task",
      kind: CADQUERY_PROGRAM_KIND,
      title: "断言验收.cad.json",
      initialContent: { ...emptyCadQueryProgram(), source },
      actor
    });
    const read = await service.readResource("task", created.resource.resourceId);
    assert.equal((await previewProgram(read.snapshot.content)).status, "ready");
    const run = cadRuntimeAdapter.agentTools().find((t) => t.name === "cad_run_program");
    const candidate = (offset) =>
      "import cadquery as cq\ndef main(p):\n    body=cq.Workplane('XY').box(60,40,10).val()\n    before=body.Volume()\n    cutter=cq.Solid.makeCylinder(4,20,cq.Vector(" +
      offset +
      ",0,-10))\n    body=body.cut(cutter)\n    removed=before-body.Volume()\n    print('removed volume:',removed)\n    assert removed>1e-4, '切割没有生效'\n    return body\n";
    await assert.rejects(
      run.execute({
        content: read.snapshot.content,
        resource: read.resource,
        params: { source: candidate(1000) }
      }),
      (e) =>
        e.details.sourceSaved === false &&
        /切割没有生效/.test(e.message) &&
        /removed volume: 0/.test(e.message)
    );
    assert.equal((await service.readResource("task", created.resource.resourceId)).resource.revision, 0);
    const valid = await run.execute({
      content: read.snapshot.content,
      resource: read.resource,
      params: { source: candidate(0).replace("    return body", "    print('x'*5000)\n    return body") }
    });
    assert.match(valid.result.diagnostics, /removed volume:/);
    assert.ok(valid.result.diagnostics.length <= 4096);
    assert.ok(valid.result.changeSummary.volumeDelta < -500);
    assert.ok(valid.result.changeSummary.faceCountDelta > 0);
  }
);
native(
  "failed Python can be saved/read/exported/undone in the same resource; AI preserves manual overrides",
  async (t) => {
    const service = new ApplicationService(await directory(t));
    const created = await service.createResource({
      taskId: "task",
      kind: CADQUERY_PROGRAM_KIND,
      title: "模型.cad.json",
      initialContent: emptyCadQueryProgram(),
      actor
    });
    const id = created.resource.resourceId;
    const tools = cadRuntimeAdapter.agentTools();
    const tool = (name) => tools.find((t) => t.name === name);
    let read = await service.readResource("task", id);
    assert.equal(read.snapshot.content.engine, "cadquery");
    const update = async (name, params) => {
      const result = await tool(name).execute({
        content: read.snapshot.content,
        resource: read.resource,
        params
      });
      for (const op of result.operations ?? []) {
        await service.applyOperation({
          taskId: "task",
          resourceId: id,
          appType: "cad",
          operationId: crypto.randomUUID(),
          baseRevision: read.resource.revision,
          actor,
          ...op
        });
        read = await service.readResource("task", id);
      }
    };
    await update("cad_set_parameters", { parameters: { width: 76 } });
    await update("cad_write_program", { source: read.snapshot.content.source + "\n# AI refinement\n" });
    assert.equal(read.snapshot.content.parameters.width, 76);
    assert.equal(read.snapshot.content.engine, "cadquery");
    const valid = read.snapshot.content;
    await update("cad_write_program", {
      source: "def main(p):\n    raise ValueError('saved invalid design')"
    });
    const returned = await tool("cad_read_model").execute({
      content: read.snapshot.content,
      resource: read.resource,
      params: {}
    });
    assert.match(returned.result.model.source, /saved invalid/);
    assert.equal(returned.result.preview.status, "not_checked");
    const exported = await service.renderForDownload({ taskId: "task", resourceId: id, format: "python" });
    assert.match(exported.body, /saved invalid/);
    await assert.rejects(
      tool("cad_preview").execute({ content: read.snapshot.content, resource: read.resource, params: {} }),
      (e) => e.details.sourceSaved && /第 2 行/.test(e.message)
    );
    assert.equal((await service.readResource("task", id)).resource.revision, 3);
    await service.applyOperation({
      taskId: "task",
      resourceId: id,
      appType: "cad",
      operationId: crypto.randomUUID(),
      baseRevision: 3,
      actor,
      operationType: "cad.document.restore",
      payload: { document: valid }
    });
    const geometry = await service.previewResource({ taskId: "task", resourceId: id, content: valid });
    assert.equal(geometry.dimensions[0], 76);
    assert.equal((await service.readResource("task", id)).resource.revision, 4);
  }
);
native("OS isolation denies private files, network, host commands and inherited credentials", async (t) => {
  const root = await directory(t);
  const privateFile = join(root, "private.txt");
  await writeFile(privateFile, "private-data");
  const program = {
    ...emptyCadQueryProgram(),
    source: `import cadquery as cq
import os, socket, subprocess
def main(p):
    assert 'COWORK_API_KEY' not in os.environ
    blocked = 0
    for action in [lambda: open(${JSON.stringify(privateFile)}).read(), lambda: socket.create_connection(('127.0.0.1', 9), 1), lambda: subprocess.run(['/bin/sh', '-c', 'echo host-command'], check=True)]:
        try:
            action()
        except PermissionError:
            blocked += 1
    assert blocked == 3, 'isolation failed: %s' % blocked
    return cq.Workplane('XY').box(2,3,4)
`
  };
  const previous = process.env.COWORK_API_KEY;
  process.env.COWORK_API_KEY = "test-credential-never-inherit";
  try {
    const result = await previewProgram(program, 60000);
    assert.equal(result.status, "ready", result.error);
  } finally {
    if (previous === undefined) delete process.env.COWORK_API_KEY;
    else process.env.COWORK_API_KEY = previous;
  }
  assert.equal(await readFile(privateFile, "utf8"), "private-data");
});
native(
  "cancellation and wall deadlines stop native jobs without losing source or poisoning diagnostics",
  async () => {
    const program = { ...emptyCadQueryProgram(), source: "def main(p):\n    while True: pass" };
    const controller = new AbortController();
    const started = Date.now();
    const pending = previewProgram(program, 60000, controller.signal);
    setTimeout(() => controller.abort(), 300);
    const cancelled = await pending;
    assert.equal(cancelled.status, "failed");
    assert.match(cancelled.error, /取消/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(inspectProgram(program).status, "not_checked");
    const timed = await previewProgram(program, 700);
    assert.equal(timed.status, "failed");
    assert.match(timed.error, /超时/);
    const restored = await previewProgram(emptyCadQueryProgram(), 60000);
    assert.equal(restored.status, "ready", restored.error);
  }
);
native("STEP export remains available when display tessellation fails", async (t) => {
  const program = {
    ...emptyCadQueryProgram(),
    source: `import cadquery as cq
def no_display_mesh(*args, **kwargs):
    raise ValueError('display budget exceeded')
def main(p):
    shape = cq.Workplane('XY').circle(10).extrude(25).val()
    shape.tessellate = no_display_mesh
    return shape
`
  };
  const preview = await previewProgram(program, 60000);
  assert.equal(preview.status, "failed");
  assert.match(preview.error, /display budget/);
  const imported = await roundtrip(t, await exportCadQuery(program, "step", 60000));
  assert.equal(imported.valid, true);
  assert.equal(imported.solids, 1);
  assert.ok(Math.abs(imported.volume - Math.PI * 100 * 25) < 1e-5);
});

native("native assemblies retain member names and composed placements", async () => {
  const program = {
    ...emptyCadQueryProgram(),
    source: `import cadquery as cq
def main(p):
    child = cq.Assembly(name="section",loc=cq.Location(cq.Vector(0,0,30)))
    child.add(cq.Workplane("XY").box(4,6,8),name="frame",loc=cq.Location(cq.Vector(10,0,0)))
    assembly = cq.Assembly(name="rocket")
    assembly.add(child)
    assembly.add(cq.Workplane("XY").box(2,2,2),name="origin")
    return assembly
`
  };
  const preview = await previewProgram(program, 60000);
  assert.equal(preview.status, "ready", preview.error);
  assert.equal(preview.report.brep.solids, 2);
  const frame = preview.report.objects.find((o) => o.name === "rocket/section/frame");
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 3; j++)
      assert.ok(
        Math.abs(
          frame.bounds[i][j] -
            [
              [8, -3, 26],
              [12, 3, 34]
            ][i][j]
        ) < 1e-5
      );
});

native("reopening a validated native assembly reuses its mesh without leaking caller mutations", async () => {
  const program = {
    version: 2,
    engine: "cadquery",
    units: "mm",
    parameters: { width: 7 },
    source: `import cadquery as cq

def main(p):
    return cq.Assembly(name="cached_engine").add(cq.Workplane("XY").box(p["width"],3,4),name="shaft")
`
  };
  const first = await previewProgram(program);
  assert.equal(first.status, "ready", first.error);
  const original = first.geometry.positions[0];
  first.geometry.positions[0] = 10000;
  first.report.objects[0].name = "caller mutation";
  const reused = await previewProgram(program, 1);
  assert.equal(reused.status, "ready", reused.error);
  assert.equal(reused.geometry.positions[0], original);
  assert.notEqual(reused.report.objects[0].name, "caller mutation");
  const changed = await previewProgram({ ...program, parameters: { width: 9 } });
  assert.equal(changed.status, "ready", changed.error);
  assert.equal(changed.geometry.dimensions[0], 9);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(previewProgram(program, 1, controller.signal), /abort/i);
});

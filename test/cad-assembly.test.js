import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  identity,
  validateAssembly,
  validateMotion,
  validateView,
  geometryAtView,
  motionMatrices,
  worldMatrices,
  transformPoint,
  explosionOffsets
} from "../dist/src/software/cad/assembly.js";
import { validateGeometry } from "../dist/src/software/cad/program-geometry.js";
import { previewProgram, inspectProgram } from "../dist/src/software/cad/program-preview.js";
import { meshBounds } from "../dist/src/software/cad/program-render.js";
import { emptyCadQueryProgram } from "../dist/src/software/cad/program.js";
import { cadQueryPython, exportCadQuery } from "../dist/src/software/cad/cadquery-engine.js";
import { programTools } from "../dist/src/applications/adapters/cad-program-tools.js";
import { cadRuntimeAdapter } from "../dist/src/applications/adapters/cad-runtime-adapter.js";
const native = process.platform === "darwin" ? test : test.skip;
const source = await readFile("test/fixtures/cad-inline-four.py", "utf8");
const program = { ...emptyCadQueryProgram(), source };
const nodes = [
  { path: "/engine", name: "engine", transform: identity() },
  { path: "/engine/crank", name: "crank", parent: "/engine", transform: identity() }
];
const motion = {
  duration: 2,
  tracks: [
    {
      path: "/engine/crank",
      type: "rotation",
      axis: [0, 0, 1],
      pivot: [10, 0, 0],
      times: [0, 2],
      values: [0, 720]
    }
  ]
};
const near = (a, b, epsilon = 1e-6) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${a} differs from ${b}`));

test("assembly boundary rejects dangling parents, cycles, scale, mirror and nonfinite data", () => {
  assert.deepEqual(validateAssembly(nodes), nodes);
  for (const broken of [
    [nodes[1], nodes[0]],
    [...nodes, nodes[0]],
    [{ ...nodes[0], parent: "/engine" }],
    [{ ...nodes[0], transform: identity().map((n, i) => (i === 0 ? 2 : n)) }],
    [{ ...nodes[0], transform: identity().map((n, i) => (i === 0 ? -1 : n)) }],
    [{ ...nodes[0], transform: identity().map((n, i) => (i === 12 ? NaN : n)) }]
  ])
    assert.throws(() => validateAssembly(broken));
  const long = Array.from({ length: 33 }, (_, i) => ({
    path: `/n${i}`,
    name: `n${i}`,
    transform: identity(),
    ...(i ? { parent: `/n${i - 1}` } : {})
  }));
  assert.throws(() => validateAssembly(long), /层级/);
});
test("motion validation is bounded and rejects malformed/ambiguous tracks", () => {
  const valid = validateMotion(motion, nodes);
  assert.equal(valid.tracks[0].axis[2], 1);
  const t = motion.tracks[0];
  for (const broken of [
    { ...motion, duration: Infinity },
    { ...motion, tracks: [] },
    { ...motion, tracks: [{ ...t, path: "/missing" }] },
    { ...motion, tracks: [t, t] },
    { ...motion, tracks: [{ ...t, axis: [0, 0, 0] }] },
    { ...motion, tracks: [{ ...t, times: [0, 0] }] },
    { ...motion, tracks: [{ ...t, times: [1, 2] }] },
    { ...motion, tracks: [{ ...t, values: [0] }] },
    { ...motion, tracks: [{ ...t, values: [0, Infinity] }] },
    {
      ...motion,
      tracks: [
        {
          ...t,
          type: "translation",
          values: [
            [0, 0, 0],
            [0, 1]
          ]
        }
      ]
    },
    { ...motion, tracks: [{ ...t, times: Array(1025).fill(0), values: Array(1025).fill(0) }] }
  ])
    assert.throws(() => validateMotion(broken, nodes));
});
test("continuous rotations, non-origin pivots and parent placements compose in the same frame", () => {
  const parent = identity();
  parent[12] = 100;
  const tree = [{ ...nodes[0], transform: parent }, nodes[1]];
  // 1/8 of a two-turn cycle is 90 degrees, not a shortest-path quaternion turn.
  const pose = worldMatrices(tree, motionMatrices(validateMotion(motion, tree), 0.25));
  near(transformPoint(pose.get("/engine/crank"), [12, 0, 0]), [110, 2, 0]);
  const end = worldMatrices(tree, motionMatrices(validateMotion(motion, tree), 2));
  near(transformPoint(end.get("/engine/crank"), [12, 0, 0]), [112, 0, 0]);
});
test("derived views clip real triangles, isolate subassemblies and never mutate rest geometry", () => {
  const geometry = validateGeometry({
    positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
    features: [
      {
        id: "solid_0",
        name: "test",
        path: "/engine/crank",
        positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
        bounds: [
          [-1, 0, 0],
          [1, 1, 0]
        ]
      }
    ],
    dimensions: [2, 1, 0],
    volume: 0,
    definitions: [],
    parameters: {},
    assembly: nodes,
    motion
  });
  const copy = structuredClone(geometry);
  const view = validateView({ paths: ["/engine"], section: { axis: "x", offset: 0 } }, geometry);
  const displayed = geometryAtView(geometry, view);
  assert.ok(displayed.positions.length > 0);
  for (let i = 0; i < displayed.positions.length; i += 3) assert.ok(displayed.positions[i] <= 1e-9);
  assert.deepEqual(geometry, copy);
  const sections = validateView(
    {
      sections: [
        { axis: "x", offset: 0 },
        { axis: "y", offset: 0.4, inverted: true }
      ]
    },
    geometry
  );
  const cut = geometryAtView(geometry, sections);
  assert.ok(cut.positions.length > 0);
  for (let i = 0; i < cut.positions.length; i += 3) {
    assert.ok(cut.positions[i] <= 1e-9);
    assert.ok(cut.positions[i + 1] >= 0.4 - 1e-9);
  }
  assert.equal(
    geometryAtView(geometry, validateView({ hiddenPaths: ["/engine"] }, geometry)).positions.length,
    0
  );
  for (const invalid of [
    { hiddenPaths: ["/missing"] },
    { explodeMode: "free" },
    {
      sections: [
        { axis: "x", offset: 0 },
        { axis: "x", offset: 1 }
      ]
    },
    { section: { axis: "x", offset: 0 }, sections: [{ axis: "z", offset: 0 }] },
    { sections: [{ axis: "y", offset: 0, inverted: "yes" }] },
    { sections: [{ axis: "y", offset: 0, unknown: true }] }
  ])
    assert.throws(() => validateView(invalid, geometry));
  assert.throws(() => validateView({ paths: ["/missing"] }, geometry), /路径/);
  assert.throws(() => validateView({ timeSeconds: 3 }, geometry), /时间/);
  assert.throws(() => validateView({ timeSeconds: 1 }, { ...geometry, motion: undefined }), /时间/);
  assert.throws(() => validateView({ section: { axis: "w", offset: 0 } }, geometry), /剖切/);
  assert.throws(
    () => validateGeometry({ ...geometry, features: [{ ...geometry.features[0], path: "/missing" }] }),
    /不存在/
  );
});

test("subassembly explosion keeps sibling parts together with no source mutation", () => {
  const features = [0, 1, 2].map((n) => ({
    id: `solid_${n}`,
    name: `part_${n}`,
    path: n === 2 ? "/engine/block/part" : `/engine/crank/part_${n}`,
    bounds: [
      [n * 10, 0, 0],
      [n * 10 + 2, 2, 2]
    ],
    positions: []
  }));
  const tree = [
    ...nodes,
    { path: "/engine/block", name: "block", parent: "/engine", transform: identity() },
    ...features.map((f) => ({
      path: f.path,
      name: f.name,
      parent: f.path.slice(0, f.path.lastIndexOf("/")),
      transform: identity()
    }))
  ];
  const geometry = { features, assembly: tree, dimensions: [22, 2, 2] };
  const offsets = explosionOffsets(geometry, "groups");
  near(offsets.get("solid_0"), offsets.get("solid_1"));
  assert.notDeepEqual(offsets.get("solid_0"), offsets.get("solid_2"));
  assert.notDeepEqual(explosionOffsets(geometry).get("solid_0"), explosionOffsets(geometry).get("solid_1"));
});

native("four-cylinder motion closes rod endpoints and preserves immutable exact rest metrics", async () => {
  const preview = await previewProgram(program, 60000);
  assert.equal(preview.status, "ready", preview.error);
  const { geometry, report } = preview;
  assert.equal(report.objects.length, 21);
  assert.equal(report.motion.trackCount, 13);
  assert.equal(report.assembly.length, 26);
  assert.ok(report.objects.every((o) => o.path && o.brep.valid && o.brep.volume > 0));
  assert.ok(report.objects.some((o) => o.color?.[3] < 1));
  assert.match(report.diagnostics, /stroke=36/);
  const length = 60,
    r = 18;
  // At exact keyframes each rod connects its rotating crank pin to its piston wrist.
  for (const sample of [0, 22, 45, 90, 135, 180]) {
    const seconds = (4 * sample) / 180;
    const world = worldMatrices(geometry.assembly, motionMatrices(geometry.motion, seconds));
    for (let i = 0; i < 4; i++) {
      const rod = world.get(`/engine/rods/rod_${i + 1}`),
        piston = world.get(`/engine/pistons/piston_${i + 1}`);
      near(transformPoint(rod, [0, 0, length]), transformPoint(piston, [0, 0, 0]));
      const sign = i === 0 || i === 3 ? 1 : -1,
        x = [-90, -30, 30, 90][i];
      near(transformPoint(rod, [0, 0, 0]), transformPoint(world.get("/engine/crank"), [x, 0, sign * r]));
    }
  }
  const piston = report.objects.find((o) => o.path === "/engine/pistons/piston_1");
  const quarter = await previewProgram(program, 60000, undefined, {
    timeSeconds: 1,
    paths: ["/engine/pistons"]
  });
  assert.equal(quarter.status, "ready", quarter.error);
  assert.equal(quarter.report.view.objects.length, 4);
  near(
    quarter.report.view.objects.find((o) => o.path === piston.path).bounds[0],
    meshBounds(geometry.features.find((f) => f.path === piston.path).positions)[0].map((n, i) =>
      i === 2 ? n - 36 : n
    ),
    1e-4
  );
  assert.equal(quarter.report.volume, report.volume);
  assert.deepEqual(inspectProgram(program).report, report);
  assert.notEqual(quarter.png, preview.png);
  const selection = cadRuntimeAdapter.summarizeSelection({
    content: program,
    selection: { schema: "cad.assembly-node/v1", data: { path: "/engine/pistons" } }
  });
  assert.match(selection, /子装配 pistons.*4 个计算实体/);
  assert.throws(() =>
    cadRuntimeAdapter.summarizeSelection({
      content: program,
      selection: { schema: "cad.assembly-node/v1", data: { path: "/missing" } }
    })
  );
  const invalid = await previewProgram(program, 60000, undefined, { paths: ["/missing"] });
  assert.equal(invalid.status, "failed");
  assert.deepEqual(inspectProgram(program).report, report);
});
native("model API validates motion before commit and notices motion-only changes", async () => {
  const tools = programTools(),
    run = tools.find((t) => t.name === "cad_run_program");
  const ref = await tools
    .find((t) => t.name === "cad_get_api_reference")
    .execute({ content: program, params: { module: "Motion" } });
  assert.equal(ref.result.contract, "atria-cad-motion/v1");
  assert.match(ref.result.coordinates, /restLocal/);
  const viewer = await tools
    .find((t) => t.name === "cad_get_api_reference")
    .execute({ content: program, params: { module: "Viewer" } });
  assert.equal(viewer.result.contract, "atria-cad-view/v1");
  assert.match(viewer.result.preview.hiddenPaths, /子孙/);
  const baseline = await previewProgram(program, 60000);
  assert.equal(baseline.status, "ready", baseline.error);
  await assert.rejects(
    run.execute({
      content: program,
      resource: { revision: 3 },
      params: {
        source:
          source +
          "\ndef get_motion(p):\n    return {'duration':1,'tracks':[{'path':'/missing','type':'rotation','axis':[1,0,0],'times':[0,1],'values':[0,360]}]}\n",
        timeoutSeconds: 60
      }
    }),
    (e) => e.details.sourceSaved === false && /目标不存在/.test(e.message)
  );
  const change = await run.execute({
    content: program,
    resource: { revision: 3 },
    params: { parameters: { period: 8 }, timeoutSeconds: 60 }
  });
  assert.equal(change.operations.length, 1);
  assert.equal(change.result.changeSummary.volumeDelta, 0);
  assert.equal(change.result.changeSummary.motionChanged, true);
  assert.deepEqual(change.result.warnings, []);
  assert.equal(change.result.motion.duration, 8);
});
native("STEP roundtrip retains nested assembly names, colors and placements", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-step-tree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "engine.step");
  await writeFile(file, await exportCadQuery(program, "step", 60000));
  const { stdout } = await promisify(execFile)(
    cadQueryPython(),
    [
      "-I",
      "-B",
      "-c",
      `import cadquery as cq, json, sys
a=cq.Assembly.importStep(sys.argv[1])
print(json.dumps([{ "name":n,"position":l.toTuple()[0],"color":list(c.toTuple()) if c else None,"solids":len(s.Solids())} for s,n,l,c in a]))`,
      file
    ],
    { timeout: 60000 }
  );
  const members = JSON.parse(stdout);
  assert.equal(members.length, 21);
  const piston = members.find((n) => n.name.includes("pistons/piston_1"));
  assert.ok(piston, JSON.stringify(members.map((n) => n.name)));
  near(piston.position, [-90, 0, 78]);
  assert.ok(members.some((n) => n.name.includes("crank/shaft") && n.color));
});

native("exported Python retains shared human parameters for geometry and motion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-motion-python-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await cadRuntimeAdapter.exportResource({
    resource: { title: "engine.cad.json" },
    content: { ...program, parameters: { crankRadius: 20, period: 8 } },
    format: "python"
  });
  const file = join(directory, "engine.py");
  await writeFile(file, output.body);
  const { stdout } = await promisify(execFile)(
    cadQueryPython(),
    [
      "-I",
      "-B",
      "-c",
      `import runpy,json,sys
n=runpy.run_path(sys.argv[1]); a=n['main'](); m=n['get_motion']()
print(json.dumps({'duration':m['duration'],'parameters':{d['name']:d['initial'] for d in n['get_parameter_definitions']()},'solids':sum(len(s.Solids()) for s,_,_,_ in a)}))`,
      file
    ],
    { timeout: 60000 }
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.duration, 8);
  assert.equal(result.parameters.crankRadius, 20);
  assert.equal(result.solids, 21);
});

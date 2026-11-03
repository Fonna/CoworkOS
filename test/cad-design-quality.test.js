import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { smoothSurface, surfaceAppearance } from "../web/assets/cad/surface-rendering.js";
import { assessDesign, validateDesignManifest } from "../dist/src/software/cad/design-manifest.js";
import { validateGeometry } from "../dist/src/software/cad/program-geometry.js";
import { previewProgram } from "../dist/src/software/cad/program-preview.js";
import { emptyCadQueryProgram } from "../dist/src/software/cad/program.js";
import { programTools } from "../dist/src/applications/adapters/cad-program-tools.js";
const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const part = (path) => ({ id: "solid_0", name: "part", path, positions });
const design = () => ({
  intent: "kinematic-demo",
  components: [
    { label: "活塞", paths: ["/engine/pistons", "/engine/pistons/p1"], minimumCount: 2, material: "aluminum" }
  ],
  checks: [{ label: "间隙", status: "not_checked" }],
  limitations: ["未建模紧固件"]
});
test("curves get smooth normals while cylinder caps stay sharp and mesh vertices stay unchanged", () => {
  const mesh = new THREE.CylinderGeometry(10, 10, 20, 64).toNonIndexed();
  const before = Array.from(mesh.attributes.position.array);
  smoothSurface(mesh);
  assert.deepEqual(Array.from(mesh.attributes.position.array), before);
  const p = mesh.attributes.position,
    n = mesh.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      z = p.getZ(i),
      ny = n.getY(i);
    if (Math.abs(ny) > 0.9) assert.ok(Math.abs(Math.abs(ny) - 1) < 1e-5, "flat cap normal");
    else {
      assert.ok(Math.abs(ny) < 1e-5, "side does not blend into cap");
      const length = Math.hypot(x, z);
      assert.ok((x * n.getX(i) + z * n.getZ(i)) / length > 0.995, "radial smooth side");
    }
  }
  mesh.dispose();
  const box = new THREE.BoxGeometry().toNonIndexed();
  smoothSurface(box);
  for (let i = 0; i < box.attributes.normal.count; i++)
    assert.ok(
      [box.attributes.normal.getX(i), box.attributes.normal.getY(i), box.attributes.normal.getZ(i)].filter(
        (v) => Math.abs(v) > 0.99
      ).length === 1
    );
  box.dispose();
});
test("appearance modes preserve source color and have distinct material responses", () => {
  const feature = { color: [1, 0, 0, 0.5], material: "rubber" };
  assert.equal(surfaceAppearance(feature, "colors").color.getHex(), 0xff0000);
  assert.equal(surfaceAppearance(feature).color.getHex(), 0x8996a4);
  assert.ok(surfaceAppearance(feature, "materials").roughness > 0.8);
  assert.ok(surfaceAppearance({ material: "steel" }, "materials").metalness > 0.7);
  assert.deepEqual(feature.color, [1, 0, 0, 0.5]);
});
test("completeness uses actual descendant meshes without duplicate counts or prefix collisions", () => {
  const g = {
    features: [part("/engine/pistons/p1"), part("/engine/pistonsExtra")],
    design: validateDesignManifest(design())
  };
  let a = assessDesign(g);
  assert.equal(a.completeness, "missing_components");
  assert.equal(a.components[0].actualCount, 1);
  assert.match(a.warnings.join(" "), /需要 2/);
  g.features.push(part("/engine/pistons/p2"));
  a = assessDesign(g);
  assert.equal(a.completeness, "declared_components_present");
  assert.equal(a.sourceChecks[0].status, "not_checked");
  assert.match(a.warnings.join(" "), /尚未验证/);
  assert.deepEqual(a.limitations, ["未建模紧固件"]);
  assert.equal(assessDesign({ features: [] }).completeness, "not_declared");
  g.features = [{ ...part("/engine/pistons/p1"), positions: [] }];
  assert.equal(assessDesign(g).components[0].actualCount, 0);
});
test("manifest boundary rejects malformed fields and unreasonable budgets", () => {
  for (const invalid of [
    { ...design(), intent: "manufacturing-approved" },
    { ...design(), components: [{ label: "p", paths: ["missing"] }] },
    { ...design(), components: [{ label: "p", paths: ["/p"], minimumCount: 0 }] },
    { ...design(), checks: [{ label: "test", status: true }] },
    { ...design(), checks: [{ label: "test", status: "passed" }] },
    { ...design(), limitations: Array(129).fill("x") }
  ])
    assert.throws(() => validateDesignManifest(invalid), /验收清单/);
  const g = validateGeometry({
    positions,
    features: [part("/engine/pistons/p1")],
    assembly: [
      { path: "/engine", name: "engine", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      {
        path: "/engine/pistons/p1",
        name: "p1",
        parent: "/engine",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      }
    ],
    design: design(),
    dimensions: [1, 1, 0],
    volume: 0,
    definitions: [],
    parameters: {}
  });
  assert.equal(g.features[0].material, "aluminum");
});
test("loop diagnostic accepts multiple full rotations and detects translation or rotation jumps", () => {
  const track = { path: "/engine/shaft", type: "rotation", values: [0, 720] };
  const g = {
    features: [],
    motion: {
      tracks: [
        track,
        {
          path: "/engine/piston",
          type: "translation",
          values: [
            [0, 0, 0],
            [0, 0, 3]
          ]
        }
      ]
    }
  };
  assert.deepEqual(assessDesign(g).loopDiscontinuities, ["/engine/piston"]);
  track.values = [0, 45];
  assert.deepEqual(assessDesign(g).loopDiscontinuities, ["/engine/shaft", "/engine/piston"]);
});
test("model API advertises the executable Design contract", async () => {
  const help = programTools().find((t) => t.name === "cad_get_api_reference");
  const result = await help.execute({ content: emptyCadQueryProgram(), params: { module: "Design" } });
  assert.equal(result.result.supported, true);
  assert.match(result.result.example, /get_design_manifest/);
  assert.match(result.result.feedback, /not_declared/);
});
(process.platform === "darwin" ? test : test.skip)(
  "native manifest reaches geometry, report and tool feedback; invalid candidates do not return success",
  async () => {
    const source = `import cadquery as cq\ndef main(p):\n a=cq.Assembly(name='engine')\n a.add(cq.Workplane('XY').circle(5).extrude(10),name='piston')\n return a\ndef get_design_manifest(p):\n return {'intent':'kinematic-demo','components':[{'label':'活塞','paths':['/engine/piston'],'material':'aluminum'},{'label':'弹簧','paths':['/engine/spring']}],'checks':[{'label':'干涉','status':'not_checked'}],'limitations':['未建模弹簧']}\n`;
    const p = { ...emptyCadQueryProgram(), source };
    const preview = await previewProgram(p);
    assert.equal(preview.status, "ready", preview.error);
    assert.equal(preview.report.assessment.geometry, "brep_valid");
    assert.equal(preview.report.assessment.completeness, "missing_components");
    assert.equal(preview.geometry.features[0].material, "aluminum");
    const run = programTools().find((t) => t.name === "cad_run_program");
    const r = await run.execute({ content: p, resource: { revision: 1 }, params: {} });
    assert.match(r.result.warnings.join(" "), /弹簧/);
    const bad = await previewProgram({
      ...p,
      source: source.replace("'material':'aluminum'", "'material':'invented'")
    });
    assert.equal(bad.status, "failed");
    assert.match(bad.error, /验收清单/);
    const empty = await previewProgram({ ...p, source: source.replace("return a", "return []") });
    assert.equal(empty.report.assessment.components[0].actualCount, 0);
  }
);

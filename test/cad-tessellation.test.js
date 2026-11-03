import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { validateGeometry } from "../dist/src/software/cad/program-geometry.js";
import { geometryAtView, validateView } from "../dist/src/software/cad/assembly.js";

const fixture = () => ({
  positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
  features: [
    {
      id: "solid_0",
      name: "test",
      positions: [-1, 0, 0, 1, 0, 0, 0, 1, 0],
      bounds: [
        [-1, 0, 0],
        [1, 1, 0]
      ]
    }
  ],
  dimensions: [2, 1, 0],
  volume: 12.345,
  definitions: [],
  parameters: {}
});
const adjusted = { linearTolerance: 0.2, angularTolerance: 0.4, adjusted: true };

test("geometry accepts absent, default and adjusted display quality without changing exact metrics", () => {
  const original = fixture();
  const oldGeometry = validateGeometry(original);
  assert.equal(Object.hasOwn(oldGeometry, "tessellation"), false);
  for (const quality of [
    { linearTolerance: 0.1, angularTolerance: 0.1, adjusted: false },
    adjusted,
    { linearTolerance: 100, angularTolerance: Math.PI, adjusted: true }
  ]) {
    const geometry = validateGeometry({ ...original, tessellation: quality });
    assert.deepEqual(geometry.tessellation, quality);
    assert.notEqual(geometry.tessellation, quality, "wire metadata is copied into the validated result");
    assert.deepEqual(geometry.dimensions, original.dimensions);
    assert.equal(geometry.volume, original.volume);
    assert.deepEqual(geometry.positions, original.positions);
    assert.deepEqual(geometry.features, original.features);
  }
});

test("invalid display quality cannot pass the geometry boundary", () => {
  for (const quality of [null, [], 1, "quality", {}, { ...adjusted, adjusted: "true" }])
    assert.throws(() => validateGeometry({ ...fixture(), tessellation: quality }), /显示网格精度/);
  for (const field of ["linearTolerance", "angularTolerance"]) {
    for (const value of [undefined, null, "0.1", NaN, Infinity, -Infinity, 0, -0.1])
      assert.throws(
        () => validateGeometry({ ...fixture(), tessellation: { ...adjusted, [field]: value } }),
        /显示网格精度/
      );
  }
  for (const quality of [
    { ...adjusted, linearTolerance: 100.1 },
    { ...adjusted, angularTolerance: Math.PI + 0.001 },
    { ...adjusted, adjusted: undefined }
  ])
    assert.throws(() => validateGeometry({ ...fixture(), tessellation: quality }), /显示网格精度/);
});

test("derived display views preserve quality and leave rest geometry and exact metrics intact", () => {
  const geometry = validateGeometry({ ...fixture(), tessellation: adjusted });
  const before = structuredClone(geometry);
  const view = validateView({ section: { axis: "x", offset: 0 } }, geometry);
  const displayed = geometryAtView(geometry, view);
  assert.notDeepEqual(displayed.positions, geometry.positions);
  assert.deepEqual(displayed.tessellation, adjusted);
  assert.deepEqual(displayed.dimensions, geometry.dimensions);
  assert.equal(displayed.volume, geometry.volume);
  assert.deepEqual(geometry, before);
});

async function workerPreview(geometry, view) {
  const worker = new Worker(new URL("../dist/src/software/cad/program-preview-worker.js", import.meta.url), {
    workerData: { geometry, view },
    execArgv: []
  });
  try {
    return await new Promise((resolve, reject) => {
      let received = false;
      worker.once("message", (message) => {
        received = true;
        resolve(message);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (!received) reject(new Error(`Preview worker exited before its result (${code})`));
      });
    });
  } finally {
    await worker.terminate();
  }
}

test(
  "preview reports propagate display quality for ordinary and derived views",
  { timeout: 10000 },
  async () => {
    const geometry = {
      ...validateGeometry({ ...fixture(), tessellation: adjusted }),
      brep: {
        engine: "cadquery",
        version: "fixture",
        valid: true,
        solids: 1,
        faces: 6,
        bounds: [
          [-1, 0, 0],
          [1, 1, 0]
        ]
      }
    };
    for (const view of [undefined, { section: { axis: "x", offset: 0 } }]) {
      const preview = await workerPreview(geometry, view);
      assert.equal(preview.status, "ready", preview.error);
      assert.deepEqual(preview.report.tessellation, adjusted);
      assert.deepEqual(preview.geometry.tessellation, adjusted);
      assert.deepEqual(preview.report.brep, geometry.brep);
      assert.deepEqual(preview.report.dimensions, geometry.dimensions);
      assert.equal(preview.report.volume, geometry.volume);
      assert.equal(Buffer.from(preview.png, "base64").subarray(1, 4).toString(), "PNG");
    }
    const legacy = await workerPreview(validateGeometry(fixture()));
    assert.equal(legacy.status, "ready", legacy.error);
    assert.equal(Object.hasOwn(legacy.report, "tessellation"), false);
  }
);

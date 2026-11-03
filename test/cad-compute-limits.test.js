import assert from "node:assert/strict";
import { test } from "node:test";
import { CAD_COMPUTE_LIMITS, computeBudget } from "../dist/src/software/cad/compute-limits.js";
import { defaultComputeBudget } from "../dist/src/software/cad/program.js";
import { validateGeometry } from "../dist/src/software/cad/program-geometry.js";
import { evaluateProgram } from "../dist/src/software/cad/program-engine.js";
import { evaluateCadQuery } from "../dist/src/software/cad/cadquery-engine.js";

const mesh = (positions, features) => ({
  positions,
  features,
  dimensions: [1, 1, 1],
  volume: 1,
  definitions: [],
  parameters: {}
});
const solid = (positions, i = 0) => ({ id: `solid_${i}`, name: `part ${i}`, positions });

test("CAD accepts extended compute budgets and rejects invalid native or JSCAD deadlines", async () => {
  assert.equal(defaultComputeBudget({ engine: "cadquery" }), 180_000);
  assert.equal(defaultComputeBudget({ engine: "jscad" }), 60_000);
  assert.equal(computeBudget(600_000), 600_000);
  const program = {
    version: 2,
    engine: "jscad",
    units: "mm",
    source: "module.exports.main=()=>[];",
    parameters: {}
  };
  assert.equal(evaluateProgram(program, { timeoutMs: 600_000 }).features.length, 0);
  for (const timeoutMs of [0, -1, 0.5, 600_001, NaN, Infinity, "600000"]) {
    assert.throws(() => evaluateProgram(program, { timeoutMs }), /预算/);
    await assert.rejects(evaluateCadQuery({ ...program, engine: "cadquery" }, timeoutMs), /预算/);
  }
});

test("geometry accepts the full hard mesh budget but rejects excess aggregate feature coordinates", () => {
  const positions = new Array(CAD_COMPUTE_LIMITS.maxTotalTriangles * 9).fill(0);
  const geometry = validateGeometry(mesh(positions, [solid(positions)]));
  assert.equal(geometry.positions.length / 9, 1_000_000);
  assert.equal(geometry.features[0].positions.length, positions.length);
  assert.throws(
    () => validateGeometry(mesh([], [solid(positions), solid(new Array(9).fill(0), 1)])),
    /总计超过预算/
  );
  const oversized = new Array(positions.length + 9).fill(0);
  assert.throws(() => validateGeometry(mesh(oversized, [])), /网格/);
  assert.throws(() => validateGeometry(mesh([], [solid(oversized)])), /网格/);
});

test("JSCAD guest cannot bypass the accumulated feature mesh budget with a forged result", () => {
  const program = {
    version: 2,
    engine: "jscad",
    units: "mm",
    source: `const positions='0,'.repeat(4_500_008)+'0';
JSON.stringify=()=>'{"positions":[],"features":'+
  '['+[0,1].map(i=>'{"id":"solid_'+i+'","name":"part","positions":['+positions+']}').join(',')+']'+
  ',"dimensions":[1,1,1],"volume":1,"definitions":[],"parameters":{}}';
module.exports.main=()=>[];`,
    parameters: {}
  };
  assert.throws(() => evaluateProgram(program), /总计超过预算/);
});

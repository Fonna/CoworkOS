import assert from "node:assert/strict";
import { test } from "node:test";
import { PNG } from "pngjs";
import { evaluateProgram } from "../dist/src/software/cad/program-engine.js";
import { previewProgram } from "../dist/src/software/cad/program-preview.js";
import { surfaceAppearance } from "../web/assets/cad/surface-rendering.js";

const program = (source, parameters = {}) => ({
  version: 2,
  engine: "jscad",
  units: "mm",
  source,
  parameters
});
const source = `const {primitives, colors, transforms} = require('@jscad/modeling');
module.exports.main = () => [
  colors.colorize([0.83, 0.69, 0.22], primitives.cuboid({size:[10,10,10]})),
  transforms.translate([20,0,0], colors.colorize([1,0,0,0.4], primitives.cuboid({size:[10,10,10]}))),
  colors.colorize([0,0,0], transforms.translate([40,0,0], primitives.cuboid({size:[10,10,10]}))),
  transforms.translate([60,0,0], primitives.cuboid({size:[10,10,10]}))
];`;

test("JSCAD preview preserves independent RGB/RGBA colors through transforms and leaves uncolored parts unset", () => {
  const geometry = evaluateProgram(program(source), { exportStl: true });
  assert.deepEqual(
    geometry.features.map((f) => f.color),
    [[0.83, 0.69, 0.22, 1], [1, 0, 0, 0.4], [0, 0, 0, 1], undefined]
  );
  assert.deepEqual(geometry.dimensions, [70, 10, 10]);
  assert.ok(Math.abs(geometry.volume - 4000) < 1e-8);
  assert.equal(surfaceAppearance(geometry.features[0], "colors").color.getHexString(), "d4b038");
  assert.equal(surfaceAppearance(geometry.features[1], "colors").color.getHexString(), "ff0000");
  assert.equal(surfaceAppearance(geometry.features[2], "colors").color.getHexString(), "000000");
  assert.equal(surfaceAppearance(geometry.features[0], "engineering").color.getHexString(), "8996a4");
  assert.equal(Object.hasOwn(geometry.features[3], "color"), false);
  const bytes = Uint8Array.from(geometry.stl);
  assert.equal(new DataView(bytes.buffer).getUint32(80, true), geometry.positions.length / 9);
});

test("invalid JSCAD entity colors are rejected at the geometry boundary", () => {
  for (const color of ["[1,0]", "[1,0,0,1,1]", "[2,0,0,1]", "[0,0,0,-1]", "[NaN,0,0,1]", "null", "'red'"]) {
    assert.throws(
      () =>
        evaluateProgram(
          program(`const {cuboid}=require('@jscad/modeling').primitives;
module.exports.main=()=>{const solid=cuboid();solid.color=${color};return solid;};`)
        ),
      /颜色|网格/
    );
  }
});

test("worker reports and four-view PNG update when only the JSCAD color parameter changes", async () => {
  const source = `const {primitives,colors}=require('@jscad/modeling');
module.exports.getParameterDefinitions=()=>[{name:'red',type:'checkbox',initial:true}];
module.exports.main=(p)=>colors.colorize(p.red?[1,0,0]:[0,0,0],primitives.cuboid({size:[60,40,20]}));`;
  const red = await previewProgram(program(source));
  const black = await previewProgram(program(source, { red: false }));
  assert.equal(red.status, "ready");
  assert.equal(black.status, "ready");
  assert.deepEqual(red.report.objects[0].color, [1, 0, 0, 1]);
  assert.deepEqual(black.report.objects[0].color, [0, 0, 0, 1]);
  assert.deepEqual(red.report.dimensions, black.report.dimensions);
  assert.equal(red.report.volume, black.report.volume);
  const pixels = PNG.sync.read(Buffer.from(red.png, "base64"));
  let redPixels = 0;
  for (let i = 0; i < pixels.data.length; i += 4)
    if (pixels.data[i] > 100 && pixels.data[i + 1] === 0 && pixels.data[i + 2] === 0) redPixels++;
  assert.ok(redPixels > 1000, "four-view PNG contains the declared red surface");
  assert.notEqual(red.png, black.png);
  const cached = await previewProgram(program(source));
  assert.equal(cached.status, "ready");
  assert.deepEqual(cached.geometry.features[0].color, [1, 0, 0, 1]);
  assert.equal(cached.png, red.png);
});

const { primitives, extrusions, transforms, booleans } = require("@jscad/modeling");
const { cylinder, cylinderElliptic, polygon } = primitives;
const { translate, rotateX, rotateZ } = transforms;
const getParameterDefinitions = () => [
  { name: "radius", type: "float", initial: 18, min: 8, max: 40, caption: "箭体半径 (mm)" },
  { name: "height", type: "float", initial: 120, min: 50, max: 300, caption: "箭体长度 (mm)" },
  { name: "noseLength", type: "float", initial: 45, min: 25, max: 90, caption: "整流罩长度 (mm)" },
  { name: "resolution", type: "int", initial: 48, min: 16, max: 96, caption: "曲面预览精度" }
];
const named = (name, geometry) => Object.assign(geometry, { name });
function main(p) {
  const R = p.radius,
    H = p.height,
    L = p.noseLength;
  const rho = (R * R + L * L) / (2 * R);
  const profile = [
    [0, 0],
    [R, 0]
  ];
  for (let i = 1; i <= 24; i++) {
    const z = (L * i) / 24;
    profile.push([i === 24 ? 0 : Math.max(0, Math.sqrt(rho * rho - z * z) + R - rho), z]);
  }
  const nose = translate(
    [0, 0, H / 2],
    extrusions.extrudeRotate({ segments: p.resolution }, polygon({ points: profile }))
  );
  const body = booleans.subtract(
    cylinder({ radius: R, height: H, segments: p.resolution }),
    cylinder({ radius: R - 1.5, height: H + 2, segments: p.resolution })
  );
  const nozzleProfile = polygon({
    points: [
      [3, 0],
      [9, 18],
      [10.5, 18],
      [4.5, 0]
    ]
  });
  const nozzle = translate(
    [0, 0, -H / 2 - 18],
    extrusions.extrudeRotate({ segments: p.resolution }, nozzleProfile)
  );
  const objects = [named("薄壁箭体", body), named("旋转轮廓整流罩", nose), named("渐变喷管", nozzle)];
  const fin = translate(
    [R - 0.5, 1.5, -H / 2 + 8],
    rotateX(
      Math.PI / 2,
      extrusions.extrudeLinear(
        { height: 3 },
        polygon({
          points: [
            [0, 0],
            [26, 0],
            [0, 34]
          ]
        })
      )
    )
  );
  for (let i = 0; i < 4; i++) objects.push(named("轮廓尾翼 " + (i + 1), rotateZ((i * Math.PI) / 2, fin)));
  for (let i = 0; i < 3; i++) {
    const ring = booleans.subtract(
      cylinder({ radius: R + 1, height: 2, segments: p.resolution }),
      cylinder({ radius: R - 1, height: 4, segments: p.resolution })
    );
    objects.push(named("加强环 " + (i + 1), translate([0, 0, -H / 2 + 15 + (i * (H - 30)) / 2], ring)));
  }
  for (const side of [-1, 1]) {
    objects.push(
      named(
        "侧助推器 " + side,
        translate([side * (R + 9), 0, -20], cylinder({ radius: 6, height: 70, segments: p.resolution }))
      )
    );
    objects.push(
      named(
        "锥形助推器头 " + side,
        translate(
          [side * (R + 9), 0, 25],
          cylinderElliptic({ height: 20, startRadius: [6, 6], endRadius: [0, 0], segments: p.resolution })
        )
      )
    );
  }
  return objects;
}
module.exports = { main, getParameterDefinitions };

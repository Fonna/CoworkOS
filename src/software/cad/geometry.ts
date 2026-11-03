import modeling from "@jscad/modeling";
import { normalizeModel, type CadPart, type Vector3 } from "./model.js";
import { CAD_COMPUTE_LIMITS } from "./compute-limits.js";
const { primitives, transforms, booleans, geometries, measurements } = modeling;
const SEGMENTS = 32;
export function partGeometry(part: CadPart) {
  const primitive =
    part.shape === "box"
      ? primitives.cuboid({ size: part.size })
      : part.shape === "cylinder"
        ? primitives.cylinder({ radius: part.radius, height: part.height, segments: SEGMENTS })
        : primitives.sphere({ radius: part.radius, segments: SEGMENTS });
  return transforms.translate(
    part.position,
    transforms.rotate(part.rotation.map((v) => (v * Math.PI) / 180) as Vector3, primitive)
  );
}
export function buildGeometry(input: unknown) {
  const model = normalizeModel(input);
  let solid: ReturnType<typeof primitives.cuboid> | undefined;
  for (const part of model.parts) {
    const next = partGeometry(part);
    solid =
      part.mode === "cut" ? booleans.subtract(solid!, next) : solid ? booleans.union(solid, next) : next;
  }
  return solid;
}
export function geometryMesh(solid: ReturnType<typeof primitives.cuboid> | undefined) {
  if (!solid) return new Float32Array();
  const points: number[] = [];
  for (const polygon of geometries.geom3.toPolygons(solid)) {
    for (let i = 1; i < polygon.vertices.length - 1; i++) {
      points.push(...polygon.vertices[0], ...polygon.vertices[i], ...polygon.vertices[i + 1]);
      if (points.length > CAD_COMPUTE_LIMITS.maxTotalTriangles * 9)
        throw new Error("模型网格超过预览上限，预览精度保持不变");
    }
  }
  return new Float32Array(points);
}
export function inspectGeometry(solid: ReturnType<typeof primitives.cuboid> | undefined) {
  if (!solid || !geometries.geom3.toPolygons(solid).length) return { volume: 0, dimensions: [0, 0, 0] };
  const [low, high] = measurements.measureBoundingBox(solid);
  return { volume: measurements.measureVolume(solid), dimensions: high.map((value, i) => value - low[i]) };
}

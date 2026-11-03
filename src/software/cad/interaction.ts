import {
  defaultPart,
  normalizeModel,
  normalizePart,
  type CadPart,
  type CadShape,
  type Vector3
} from "./model.js";

/** Conservative world bounds, without importing a geometry engine into the UI. */
export function partBounds(part: CadPart) {
  const half =
    part.shape === "box"
      ? part.size.map((v) => v / 2)
      : [part.radius, part.radius, part.shape === "cylinder" ? part.height / 2 : part.radius];
  const [x, y, z] = part.rotation.map((v) => (v * Math.PI) / 180);
  const [sx, cx, sy, cy, sz, cz] = [
    Math.sin(x),
    Math.cos(x),
    Math.sin(y),
    Math.cos(y),
    Math.sin(z),
    Math.cos(z)
  ];
  const rows = [
    [cy * cz, sx * sy * cz - cx * sz, sx * sz + cx * sy * cz],
    [cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - sx * cz],
    [-sy, sx * cy, cx * cy]
  ];
  const extent =
    part.shape === "sphere"
      ? half
      : rows.map((row) => row.reduce((sum, v, i) => sum + Math.abs(v) * half[i], 0));
  return { min: part.position.map((v, i) => v - extent[i]), max: part.position.map((v, i) => v + extent[i]) };
}

/** New objects start outside the existing envelope, never hidden at its origin. */
export function placeBeside(input: unknown, part: CadPart, selected?: string): CadPart {
  const model = normalizeModel(input);
  if (!model.parts.length) return part;
  const solids = model.parts.filter((p) => p.mode === "add");
  const reference = model.parts.find((p) => p.id === selected) ?? model.parts[0];
  const right = Math.max(...solids.map((p) => partBounds(p).max[0]));
  const halfWidth = part.position[0] - partBounds(part).min[0];
  const gap = Math.max(2, Math.min(10, halfWidth * 0.2));
  const position: Vector3 = [
    Math.round((right + halfWidth + gap) * 10) / 10,
    reference.position[1],
    reference.position[2]
  ];
  // At the coordinate boundary place on the left, or explicitly reject an unplaceable scene.
  if (position[0] > 2000) {
    const left = Math.min(...solids.map((p) => partBounds(p).min[0]));
    position[0] = Math.round((left - halfWidth - gap) * 10) / 10;
  }
  return normalizePart({ ...part, position });
}
export function createPlacedPart(model: unknown, shape: CadShape, id: string, selected?: string) {
  return placeBeside(model, defaultPart(shape, id), selected);
}
export function duplicatePart(model: unknown, selected: string, id: string) {
  const source = normalizeModel(model).parts.find((p) => p.id === selected);
  if (!source) throw new Error("请先选择要复制的特征");
  return placeBeside(
    model,
    normalizePart({ ...source, id, name: `${source.name.slice(0, 76)} 副本` }),
    selected
  );
}

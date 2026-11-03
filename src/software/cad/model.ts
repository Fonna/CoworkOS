/** Legacy data-only CAD document; source-based designs use program.ts. */
export const CAD_KIND = "model/atria-cad+json";
export const CAD_APP = "cad";
export const MAX_PARTS = 64;
export type Vector3 = [number, number, number];
export type CadShape = "box" | "cylinder" | "sphere";
export interface CadPart {
  id: string;
  name: string;
  shape: CadShape;
  mode: "add" | "cut";
  size: Vector3;
  radius: number;
  height: number;
  position: Vector3;
  rotation: Vector3;
}
export interface CadModel {
  version: 1;
  units: "mm";
  parts: CadPart[];
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("包含不支持的字段");
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} 必须是 ${min}–${max} 之间的有限数字`);
  return value;
}
function vector(value: unknown, label: string, min: number, max: number): Vector3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} 必须包含三个数字`);
  return value.map((entry) => number(entry, label, min, max)) as Vector3;
}
export function partId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(value))
    throw new Error("特征 ID 必须以英文字母开头，最多 48 个字母、数字、下划线或连字符");
  return value;
}
export function normalizePart(input: unknown): CadPart {
  const value = record(input);
  keys(value, ["id", "name", "shape", "mode", "size", "radius", "height", "position", "rotation"]);
  const shape = value.shape;
  if (shape !== "box" && shape !== "cylinder" && shape !== "sphere") throw new Error("不支持的实体类型");
  const mode = value.mode ?? "add";
  if (mode !== "add" && mode !== "cut") throw new Error("模式必须是 add 或 cut");
  const id = partId(value.id);
  const name = value.name ?? id;
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw new Error("特征名称应为 1–80 个字符");
  return {
    id,
    name: name.trim(),
    shape,
    mode,
    size: vector(value.size ?? [40, 30, 20], "尺寸", 0.1, 1000),
    radius: number(value.radius ?? 10, "半径", 0.1, 500),
    height: number(value.height ?? 20, "高度", 0.1, 1000),
    position: vector(value.position ?? [0, 0, 0], "位置", -2000, 2000),
    rotation: vector(value.rotation ?? [0, 0, 0], "旋转角度", -360, 360)
  };
}
export function normalizeModel(input: unknown): CadModel {
  const value = record(input);
  keys(value, ["version", "units", "parts"]);
  if (value.version !== 1 || value.units !== "mm")
    throw new Error("仅支持版本 1、毫米单位的 CoworkOS CAD 模型");
  if (!Array.isArray(value.parts) || value.parts.length > MAX_PARTS)
    throw new Error(`最多支持 ${MAX_PARTS} 个特征`);
  const parts = value.parts.map(normalizePart);
  if (new Set(parts.map((part) => part.id)).size !== parts.length) throw new Error("特征 ID 不能重复");
  if (parts[0]?.mode === "cut") throw new Error("第一个特征必须是实体，不能是切除体");
  return { version: 1, units: "mm", parts };
}
export function emptyModel(): CadModel {
  return { version: 1, units: "mm", parts: [] };
}
export function defaultPart(shape: CadShape, id: string): CadPart {
  return normalizePart({ id, name: { box: "长方体", cylinder: "圆柱体", sphere: "球体" }[shape], shape });
}
export function applyCadOperation(content: unknown, type: string, payload: unknown): CadModel {
  const model = normalizeModel(content);
  const value = record(payload);
  if (type === "cad.replace") {
    keys(value, ["model"]);
    return normalizeModel(value.model);
  }
  if (type === "cad.edit") {
    keys(value, ["upsert", "remove"]);
    const upsert = value.upsert ?? [];
    const remove = value.remove ?? [];
    if (
      !Array.isArray(upsert) ||
      !Array.isArray(remove) ||
      upsert.length > MAX_PARTS ||
      remove.length > MAX_PARTS ||
      upsert.length + remove.length === 0
    )
      throw new Error(`请提供新增/替换特征或删除 ID，每组最多 ${MAX_PARTS} 项`);
    const parts = upsert.map(normalizePart);
    const ids = remove.map(partId);
    const allIds = [...parts.map((part) => part.id), ...ids];
    if (new Set(allIds).size !== allIds.length) throw new Error("同一批次中每个特征 ID 只能出现一次");
    if (ids.some((id) => !model.parts.some((part) => part.id === id)))
      throw new Error("待删除特征不存在，请先读取模型");
    model.parts = model.parts.filter((part) => !ids.includes(part.id));
    for (const part of parts) {
      const index = model.parts.findIndex((entry) => entry.id === part.id);
      if (index < 0) model.parts.push(part);
      else model.parts[index] = part;
    }
    // Validate the final model once: dependent edits succeed or fail together.
    return normalizeModel(model);
  }
  if (type === "cad.upsert") {
    keys(value, ["part"]);
    const part = normalizePart(value.part);
    const index = model.parts.findIndex((entry) => entry.id === part.id);
    if (index < 0) model.parts.push(part);
    else model.parts[index] = part;
    return normalizeModel(model);
  }
  if (type === "cad.remove") {
    keys(value, ["id"]);
    const id = partId(value.id);
    if (!model.parts.some((part) => part.id === id)) throw new Error("特征不存在，请先读取模型");
    return normalizeModel({ ...model, parts: model.parts.filter((part) => part.id !== id) });
  }
  throw new Error(`不支持的 CAD 操作 ${type}`);
}

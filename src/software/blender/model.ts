import { randomUUID } from "node:crypto";
import { ApplicationError } from "../../applications/types.js";
export { blenderTimeout as timeout } from "./compute-limits.js";

export const BLENDER_KIND = "project/atria-blender+json";
export const BLENDER_APP = "blender";
export const BLENDER_LIMITS = {
  source: 256_000,
  objects: 1000,
  triangles: 2_000_000,
  fileBytes: 128 * 1024 * 1024
};
export type BlenderValue =
  null | string | number | boolean | BlenderValue[] | { [key: string]: BlenderValue };
export type BlenderParameters = Record<string, BlenderValue>;
/** A UTF-8 workbench manifest points at a versioned native project. It never contains blend bytes. */
export interface BlenderDocument {
  version: 1;
  projectId: string;
  snapshot: string | null;
  source: string;
  parameters: BlenderParameters;
}
export interface BlenderObject {
  id: string;
  name: string;
  type: string;
  parent: string | null;
  position: number[];
  rotation: number[];
  scale: number[];
  dimensions: number[];
  color: number[];
  metallic: number;
  roughness: number;
  vertices: number;
  triangles: number;
}
export interface BlenderScene {
  blenderVersion: string;
  objects: BlenderObject[];
  triangles: number;
  bounds: number[][];
  camera: string | null;
  warnings: string[];
  diagnostics: string;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("需要对象参数");
  return value as Record<string, unknown>;
}
export function invalid(message: string): ApplicationError {
  return new ApplicationError("invalid_operation", message, { sourceSaved: false });
}
export function token(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw invalid("无效的 Blender 工程标识");
  return value;
}
export function parameters(value: unknown): BlenderParameters {
  const input = record(value ?? {}),
    result: BlenderParameters = {};
  if (Object.keys(input).length > 100) throw invalid("参数数量超过 100");
  for (const [key, item] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw invalid(`无效参数名称 ${key}`);
    result[key] = jsonValue(item);
  }
  if (JSON.stringify(result).length > 64_000) throw invalid("参数超过 64000 字符预算");
  return result;
}
/** JSON only: bounded depth/size, no host objects or non-finite numbers. */
export function jsonValue(value: unknown, depth = 0): BlenderValue {
  if (depth > 8) throw invalid("JSON 嵌套超过 8 层");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 64_000) return value;
  if (Array.isArray(value) && value.length <= 1000) return value.map((v) => jsonValue(v, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 1000) throw invalid("JSON 对象字段过多");
    return Object.fromEntries(entries.map(([key, item]) => [key, jsonValue(item, depth + 1)]));
  }
  throw invalid("需要有限数值或合法 JSON 值");
}

export function pythonSource(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > BLENDER_LIMITS.source)
    throw invalid("Python 源码不能为空或超过预算");
  return value;
}

export function renderOptions(input: Record<string, unknown>): Record<string, unknown> {
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || Number(n) < min || Number(n) > max) throw invalid(`整数应为 ${min}–${max}`);
    return Number(n);
  };
  if (input.resolution !== undefined && (input.width !== undefined || input.height !== undefined))
    throw invalid("resolution 与 width/height 不能同时指定");
  if ((input.width === undefined) !== (input.height === undefined))
    throw invalid("width 和 height 需要一起指定");
  if (
    input.camera !== undefined &&
    (typeof input.camera !== "string" || !input.camera.length || input.camera.length > 256)
  )
    throw invalid("camera 需要相机稳定 ID 或名称");
  if (input.denoise !== undefined && typeof input.denoise !== "boolean") throw invalid("denoise 需要布尔值");
  const resolution = integer(input.resolution, 768, 64, 2048);
  return {
    width: integer(input.width, resolution, 64, 2048),
    height: integer(input.height, resolution, 64, 2048),
    samples: integer(input.samples, 32, 1, 128),
    ...(input.frame !== undefined ? { frame: integer(input.frame, 1, -1_048_574, 1_048_574) } : {}),
    ...(input.camera !== undefined ? { camera: input.camera } : {}),
    ...(input.denoise !== undefined ? { denoise: input.denoise } : {})
  };
}
export function document(value: unknown): BlenderDocument {
  const input = record(value);
  if (input.version !== 1) throw invalid("不支持此 Blender 工程版本");
  if (typeof input.source !== "string" || input.source.length > BLENDER_LIMITS.source)
    throw invalid("建模源码过大或格式无效");
  return {
    version: 1,
    projectId: token(input.projectId),
    snapshot: input.snapshot === null ? null : token(input.snapshot),
    source: input.source,
    parameters: parameters(input.parameters)
  };
}
export function emptyDocument(input?: unknown): BlenderDocument {
  const initial = input === undefined ? {} : record(input);
  return document({
    version: 1,
    projectId: randomUUID().replaceAll("-", ""),
    snapshot: null,
    source: initial.source ?? "",
    parameters: initial.parameters ?? {}
  });
}
export function emptyScene(): BlenderScene {
  return {
    blenderVersion: "",
    objects: [],
    triangles: 0,
    bounds: [
      [0, 0, 0],
      [0, 0, 0]
    ],
    camera: null,
    warnings: [],
    diagnostics: ""
  };
}
/** Transport projection only. Native snapshots and workbench previews retain the full scene. */
export function scenePage(report: BlenderScene, input: Record<string, unknown>) {
  const offset = input.offset ?? 0,
    limit = input.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 1000
  )
    throw invalid("offset 应为非负整数，limit 应为 1–1000");
  for (const key of ["name", "type"])
    if (input[key] !== undefined && (typeof input[key] !== "string" || (input[key] as string).length > 256))
      throw invalid(`${key} 需要短字符串`);
  if (input.includeSource !== undefined && typeof input.includeSource !== "boolean")
    throw invalid("includeSource 需要布尔值");
  let ids: Set<string> | undefined;
  if (input.ids !== undefined) {
    if (!Array.isArray(input.ids) || input.ids.length > 1000) throw invalid("ids 需要稳定 ID 数组");
    ids = new Set(input.ids.map(token));
  }
  const matched = report.objects.filter(
    (obj) =>
      (!ids || ids.has(obj.id)) &&
      (input.name === undefined || obj.name.toLowerCase().includes((input.name as string).toLowerCase())) &&
      (input.type === undefined || obj.type === input.type)
  );
  const end = Number(offset) + Number(limit);
  return {
    ...report,
    objects: matched.slice(Number(offset), end),
    objectCount: report.objects.length,
    matchedCount: matched.length,
    nextOffset: end < matched.length ? end : null
  };
}
export function vector(value: unknown, length = 3): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9)
  )
    throw invalid("无效向量");
  return value as number[];
}
export function scene(value: unknown): BlenderScene {
  const input = record(value);
  if (!Array.isArray(input.objects) || input.objects.length > BLENDER_LIMITS.objects)
    throw invalid("场景对象数量超过预算");
  const ids = new Set<string>();
  const objects = input.objects.map((value) => {
    const o = record(value),
      id = token(o.id);
    if (ids.has(id)) throw invalid("场景对象 ID 重复");
    ids.add(id);
    if (typeof o.name !== "string" || o.name.length > 256 || typeof o.type !== "string")
      throw invalid("无效场景对象");
    const count = (v: unknown) => {
      if (!Number.isSafeInteger(v) || Number(v) < 0) throw invalid("无效网格统计");
      return Number(v);
    };
    const unit = (v: unknown) => {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw invalid("无效材质参数");
      return v;
    };
    return {
      id,
      name: o.name,
      type: o.type,
      parent: o.parent === null ? null : token(o.parent),
      position: vector(o.position),
      rotation: vector(o.rotation),
      scale: vector(o.scale),
      dimensions: vector(o.dimensions),
      color: vector(o.color, 4),
      metallic: unit(o.metallic),
      roughness: unit(o.roughness),
      vertices: count(o.vertices),
      triangles: count(o.triangles)
    };
  });
  const triangles = objects.reduce((n, o) => n + o.triangles, 0);
  if (triangles > BLENDER_LIMITS.triangles) throw invalid("场景三角面数量超过预算");
  if (typeof input.blenderVersion !== "string" || !Array.isArray(input.bounds) || input.bounds.length !== 2)
    throw invalid("无效场景报告");
  return {
    blenderVersion: input.blenderVersion,
    objects,
    triangles,
    bounds: input.bounds.map((v) => vector(v)),
    camera: input.camera === null ? null : token(input.camera),
    warnings: Array.isArray(input.warnings)
      ? input.warnings.filter((v): v is string => typeof v === "string").slice(0, 20)
      : [],
    diagnostics: typeof input.diagnostics === "string" ? input.diagnostics.slice(0, 4096) : ""
  };
}

export type BlenderEdit = {
  id: string;
  position?: number[];
  rotation?: number[];
  scale?: number[];
  color?: number[];
  metallic?: number;
  roughness?: number;
  name?: string;
};
export function edits(value: unknown): BlenderEdit[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw invalid("需要 1–100 项对象修改");
  const ids = new Set<string>();
  return value.map((item) => {
    const input = record(item),
      id = token(input.id);
    if (ids.has(id)) throw invalid("一次修改不能重复同一对象");
    ids.add(id);
    const result: BlenderEdit = { id };
    for (const key of ["position", "rotation", "scale", "color"] as const) {
      if (input[key] !== undefined) result[key] = vector(input[key], key === "color" ? 4 : 3);
    }
    if (result.scale?.some((n) => Math.abs(n) < 1e-6)) throw invalid("缩放不能为零");
    if (result.color?.some((n) => n < 0 || n > 1)) throw invalid("颜色分量应为 0–1");
    for (const key of ["metallic", "roughness"] as const) {
      if (input[key] !== undefined) {
        const n = input[key];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) throw invalid("材质参数应为 0–1");
        result[key] = n;
      }
    }
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128)
        throw invalid("无效对象名称");
      result.name = input.name.trim();
    }
    if (Object.keys(result).length === 1) throw invalid("对象修改为空");
    if (
      Object.keys(input).some(
        (key) =>
          !["id", "position", "rotation", "scale", "color", "metallic", "roughness", "name"].includes(key)
      )
    )
      throw invalid("未知对象修改字段");
    return result;
  });
}

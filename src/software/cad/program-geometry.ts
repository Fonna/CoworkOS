import { normalizeParameters, type ParameterValue } from "./program.js";
import { CAD_COMPUTE_LIMITS } from "./compute-limits.js";
import { validateAssembly, validateMotion, type AssemblyNode, type CadMotion } from "./assembly.js";
import {
  validateDesignManifest,
  type DesignManifest,
  type DesignAssessment,
  type CadMaterial
} from "./design-manifest.js";
export interface ProgramParameter {
  name: string;
  type: string;
  caption?: string;
  initial?: ParameterValue;
  min?: number;
  max?: number;
  step?: number;
  values?: ParameterValue[];
  captions?: string[];
}
export interface ProgramGeometry {
  positions: number[];
  features: Array<{
    id: string;
    name: string;
    positions: number[];
    bounds?: number[][];
    path?: string;
    color?: number[];
    material?: CadMaterial;
    brep?: { valid: true; solids: number; faces: number; volume: number };
  }>;
  assembly?: AssemblyNode[];
  motion?: CadMotion;
  design?: DesignManifest;
  assessment?: DesignAssessment;
  dimensions: number[];
  volume: number;
  definitions: ProgramParameter[];
  parameters: Record<string, ParameterValue>;
  stl?: number[];
  diagnostics?: string;
  tessellation?: {
    linearTolerance: number;
    angularTolerance: number;
    adjusted: boolean;
  };
  brep?: {
    engine: "cadquery";
    version: string;
    valid: true;
    solids: number;
    faces: number;
    bounds: number[][];
  };
}
export function validateGeometry(value: unknown): ProgramGeometry {
  if (!value || typeof value !== "object") throw new Error("无效几何结果");
  const wire = value as Record<string, unknown>;
  const numbers = (input: unknown, limit: number): number[] => {
    if (
      !Array.isArray(input) ||
      input.length > limit ||
      !input.every((n) => typeof n === "number" && Number.isFinite(n))
    )
      throw new Error("无效或超出预算的网格");
    return input;
  };
  const positions = numbers(wire.positions, CAD_COMPUTE_LIMITS.maxTotalTriangles * 9);
  if (positions.length % 9) throw new Error("无效三角网格");
  if (!Array.isArray(wire.features) || wire.features.length > 1024) throw new Error("无效实体列表");
  let featureCoordinates = 0;
  const features = wire.features.map((input, i) => {
    if (!input || typeof input !== "object") throw new Error("无效实体");
    const node = input as Record<string, unknown>;
    const mesh = numbers(node.positions, CAD_COMPUTE_LIMITS.maxPartTriangles * 9);
    featureCoordinates += mesh.length;
    if (featureCoordinates > CAD_COMPUTE_LIMITS.maxTotalTriangles * 9)
      throw new Error("实体网格总计超过预算");
    if (node.id !== `solid_${i}` || typeof node.name !== "string" || node.name.length > 80 || mesh.length % 9)
      throw new Error("无效实体元数据");
    let bounds: number[][] | undefined;
    if (node.bounds !== undefined) {
      if (!Array.isArray(node.bounds) || node.bounds.length !== 2) throw new Error("无效实体包围盒");
      bounds = node.bounds.map((v) => numbers(v, 3));
      if (bounds.some((v) => v.length !== 3) || bounds[0].some((v, i) => v > bounds![1][i]))
        throw new Error("无效实体包围盒");
    }
    const feature: ProgramGeometry["features"][number] = {
      id: node.id as string,
      name: node.name,
      positions: mesh,
      ...(bounds ? { bounds } : {})
    };
    if (node.path !== undefined) {
      if (typeof node.path !== "string" || node.path.length > 512) throw new Error("无效装配路径");
      feature.path = node.path;
    }
    if (node.color !== undefined) {
      const color = numbers(node.color, 4);
      if (color.length !== 4 || color.some((n) => n < 0 || n > 1)) throw new Error("颜色须为 0–1 RGBA");
      feature.color = color;
    }
    if (node.brep !== undefined) {
      const b = node.brep as NonNullable<typeof feature.brep>;
      if (
        !b ||
        b.valid !== true ||
        !Number.isInteger(b.solids) ||
        b.solids < 1 ||
        !Number.isInteger(b.faces) ||
        b.faces < 1 ||
        typeof b.volume !== "number" ||
        !Number.isFinite(b.volume) ||
        b.volume < 0
      )
        throw new Error("无效零件 BRep 诊断");
      feature.brep = { valid: true, solids: b.solids, faces: b.faces, volume: b.volume };
    }
    return feature;
  });
  const dimensions = numbers(wire.dimensions, 3);
  if (
    dimensions.length !== 3 ||
    dimensions.some((n) => n < 0) ||
    typeof wire.volume !== "number" ||
    !Number.isFinite(wire.volume)
  )
    throw new Error("无效模型度量");
  if (!Array.isArray(wire.definitions) || wire.definitions.length > 2048) throw new Error("无效参数定义");
  const seen = new Set<string>();
  const definitions: ProgramParameter[] = [];
  for (const raw of wire.definitions) {
    if (!raw || typeof raw !== "object") throw new Error("无效参数定义");
    const d = raw as Record<string, unknown>;
    if (d.type === "group") continue;
    if (
      typeof d.name !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(d.name) ||
      seen.has(d.name) ||
      typeof d.type !== "string" ||
      !["float", "number", "int", "slider", "checkbox", "choice", "text"].includes(d.type)
    )
      throw new Error("无效或重复的参数定义");
    seen.add(d.name);
    const definition: ProgramParameter = {
      name: d.name,
      type: d.type,
      caption: typeof d.caption === "string" ? d.caption.slice(0, 160) : d.name
    };
    for (const key of ["min", "max", "step"] as const)
      if (typeof d[key] === "number" && Number.isFinite(d[key])) definition[key] = d[key];
    if (Array.isArray(d.values)) {
      if (d.values.length > 256 || !d.values.every((v) => ["number", "boolean", "string"].includes(typeof v)))
        throw new Error("无效参数选项");
      definition.values = d.values;
      definition.captions = Array.isArray(d.captions)
        ? d.captions.map((v) => String(v).slice(0, 160))
        : undefined;
    }
    definitions.push(definition);
  }
  const parameters = normalizeParameters(wire.parameters);
  const geometry: ProgramGeometry = {
    positions,
    features,
    dimensions,
    volume: wire.volume,
    definitions,
    parameters
  };
  if (wire.assembly !== undefined) {
    geometry.assembly = validateAssembly(wire.assembly);
    const paths = new Set(geometry.assembly.map((n) => n.path));
    if (features.some((f) => !f.path || !paths.has(f.path))) throw new Error("实体引用了不存在的装配节点");
  } else if (features.some((f) => f.path)) throw new Error("实体路径缺少装配树");
  if (wire.motion !== undefined) geometry.motion = validateMotion(wire.motion, geometry.assembly ?? []);
  if (wire.design !== undefined) {
    geometry.design = validateDesignManifest(wire.design);
    for (const feature of features) {
      const matches = geometry.design.components.flatMap((c) =>
        c.material
          ? c.paths
              .filter((p) => feature.path === p || feature.path?.startsWith(`${p}/`))
              .map((p) => ({ path: p, material: c.material! }))
          : []
      );
      feature.material = matches.sort((a, b) => b.path.length - a.path.length)[0]?.material;
    }
  }
  if (wire.stl !== undefined) {
    const bytes = numbers(wire.stl, CAD_COMPUTE_LIMITS.maxExportBytes);
    if (!bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error("无效 STL 数据");
    geometry.stl = bytes;
  }
  if (wire.diagnostics !== undefined) {
    if (typeof wire.diagnostics !== "string") throw new Error("无效建模诊断");
    geometry.diagnostics = wire.diagnostics.slice(0, 4096);
  }
  if (wire.tessellation !== undefined) {
    const quality = wire.tessellation as NonNullable<ProgramGeometry["tessellation"]>;
    if (
      !quality ||
      typeof quality !== "object" ||
      Array.isArray(quality) ||
      typeof quality.linearTolerance !== "number" ||
      !Number.isFinite(quality.linearTolerance) ||
      quality.linearTolerance <= 0 ||
      quality.linearTolerance > 100 ||
      typeof quality.angularTolerance !== "number" ||
      !Number.isFinite(quality.angularTolerance) ||
      quality.angularTolerance <= 0 ||
      quality.angularTolerance > Math.PI ||
      typeof quality.adjusted !== "boolean"
    )
      throw new Error("无效显示网格精度");
    geometry.tessellation = {
      linearTolerance: quality.linearTolerance,
      angularTolerance: quality.angularTolerance,
      adjusted: quality.adjusted
    };
  }
  return geometry;
}

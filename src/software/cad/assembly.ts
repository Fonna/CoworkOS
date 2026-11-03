import type { ProgramGeometry } from "./program-geometry.js";

export interface AssemblyNode {
  path: string;
  name: string;
  parent?: string;
  /** Column-major rigid transform, in the parent coordinate frame. */
  transform: number[];
}
export interface MotionTrack {
  path: string;
  type: "translation" | "rotation";
  times: number[];
  values: number[][] | number[];
  axis?: number[];
  pivot?: number[];
}
export interface CadMotion {
  duration: number;
  tracks: MotionTrack[];
}
export interface CadView {
  timeSeconds?: number;
  paths?: string[];
  hiddenPaths?: string[];
  explode?: number;
  explodeMode?: "parts" | "groups";
  section?: CadSection;
  sections?: CadSection[];
}
export interface CadSection {
  axis: "x" | "y" | "z";
  offset: number;
  inverted?: boolean;
}
export const withinPath = (path: string | undefined, parent: string) =>
  path === parent || !!path?.startsWith(parent + "/");
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 16 }, (_, n) => {
    const row = n % 4,
      col = Math.floor(n / 4);
    return [0, 1, 2, 3].reduce((v, i) => v + a[i * 4 + row] * b[col * 4 + i], 0);
  });
}
export function transformPoint(m: number[], p: ArrayLike<number>): number[] {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}
export function inverseRigid(m: number[]): number[] {
  const result = identity();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) result[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++)
    result[12 + r] = -[0, 1, 2].reduce((v, c) => v + result[c * 4 + r] * m[12 + c], 0);
  return result;
}
const vector = (value: unknown, length: number): number[] => {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9)
  )
    throw new Error("装配/运动需要有限且有界的数值");
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效装配/运动对象");
  return value as Record<string, unknown>;
};
export function validateAssembly(value: unknown): AssemblyNode[] {
  if (!Array.isArray(value) || value.length > 2048) throw new Error("装配节点超过预算");
  const seen = new Map<string, number>();
  return value.map((raw) => {
    const n = object(raw);
    if (
      typeof n.path !== "string" ||
      !n.path.startsWith("/") ||
      n.path.length > 512 ||
      seen.has(n.path) ||
      typeof n.name !== "string" ||
      n.name.length > 80
    )
      throw new Error("装配路径须唯一，名称最多 80 字符");
    const parent = n.parent;
    if (parent !== undefined && (typeof parent !== "string" || !seen.has(parent)))
      throw new Error("装配父节点必须先于子节点且存在");
    const depth = parent === undefined ? 1 : seen.get(parent as string)! + 1;
    if (depth > 32) throw new Error("装配层级超过 32");
    const m = vector(n.transform, 16);
    // Reject scale/shear/reflection. Inverse and interpolation assume rigid transforms.
    if (Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) + Math.abs(m[15] - 1) > 1e-6)
      throw new Error("装配变换须为刚体矩阵");
    for (let a = 0; a < 3; a++)
      for (let b = 0; b < 3; b++) {
        const dot = [0, 1, 2].reduce((v, r) => v + m[a * 4 + r] * m[b * 4 + r], 0);
        if (Math.abs(dot - Number(a === b)) > 1e-5) throw new Error("装配变换不能包含缩放或剪切");
      }
    const determinant =
      m[0] * (m[5] * m[10] - m[9] * m[6]) -
      m[4] * (m[1] * m[10] - m[9] * m[2]) +
      m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (Math.abs(determinant - 1) > 1e-5) throw new Error("装配变换不能包含镜像");
    seen.set(n.path, depth);
    return {
      path: n.path,
      name: n.name,
      ...(parent === undefined ? {} : { parent: parent as string }),
      transform: m
    };
  });
}
export function validateMotion(value: unknown, nodes: AssemblyNode[]): CadMotion {
  const motion = object(value);
  if (
    typeof motion.duration !== "number" ||
    !Number.isFinite(motion.duration) ||
    motion.duration <= 0 ||
    motion.duration > 3600 ||
    !Array.isArray(motion.tracks) ||
    !motion.tracks.length ||
    motion.tracks.length > 256
  )
    throw new Error("运动需要 0–3600 秒周期及 1–256 条轨道");
  const paths = new Set(nodes.map((n) => n.path)),
    seen = new Set<string>();
  let keys = 0;
  const duration = motion.duration;
  const tracks = motion.tracks.map((raw): MotionTrack => {
    const t = object(raw);
    if (typeof t.path !== "string" || !paths.has(t.path))
      throw new Error(`运动目标不存在：${String(t.path)}；使用装配的完整路径`);
    if (t.type !== "translation" && t.type !== "rotation")
      throw new Error("运动 type 须为 translation 或 rotation");
    const key = `${t.path}:${t.type}`;
    if (seen.has(key)) throw new Error("同一节点的同类运动轨道不能重复");
    seen.add(key);
    if (
      !Array.isArray(t.times) ||
      t.times.length < 2 ||
      t.times.length > 1024 ||
      (keys += t.times.length) > 16384
    )
      throw new Error("运动关键帧超过预算");
    const times = vector(t.times, t.times.length);
    if (
      times[0] !== 0 ||
      Math.abs(times.at(-1)! - duration) > 1e-8 ||
      times.some((n, i) => n < 0 || n > duration || (i > 0 && n <= times[i - 1]))
    )
      throw new Error("关键帧时间须严格递增，从 0 到 duration");
    if (!Array.isArray(t.values) || t.values.length !== times.length)
      throw new Error("关键帧 times/values 长度不一致");
    if (t.type === "translation")
      return { path: t.path, type: t.type, times, values: t.values.map((v) => vector(v, 3)) };
    const axis = vector(t.axis, 3),
      length = Math.hypot(...axis);
    if (length < 1e-8) throw new Error("旋转轴不能为零");
    return {
      path: t.path,
      type: t.type,
      times,
      values: vector(t.values, times.length),
      axis: axis.map((n) => n / length),
      pivot: vector(t.pivot ?? [0, 0, 0], 3)
    };
  });
  return { duration, tracks };
}
export function sampleTrack(track: MotionTrack, time: number): number | number[] {
  const t = Math.max(0, Math.min(track.times.at(-1)!, time));
  let low = 0,
    high = track.times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (track.times[mid] <= t) low = mid;
    else high = mid;
  }
  const ratio = (t - track.times[low]) / (track.times[high] - track.times[low]);
  if (track.type === "rotation") {
    const v = track.values as number[];
    return v[low] + (v[high] - v[low]) * ratio;
  }
  const v = track.values as number[][];
  return v[low].map((n, i) => n + (v[high][i] - n) * ratio);
}
/** Motion is a delta in the node's parent frame, applied BEFORE its rest transform. */
export function motionMatrices(motion: CadMotion | undefined, time: number): Map<string, number[]> {
  const translations = new Map<string, number[]>(),
    rotations = new Map<string, number[]>();
  for (const track of motion?.tracks ?? []) {
    const m = identity(),
      value = sampleTrack(track, time);
    if (track.type === "translation") {
      m.splice(12, 3, ...(value as number[]));
      translations.set(track.path, m);
    } else {
      const [x, y, z] = track.axis!,
        a = ((value as number) * Math.PI) / 180,
        c = Math.cos(a),
        s = Math.sin(a),
        d = 1 - c;
      m.splice(
        0,
        12,
        c + x * x * d,
        y * x * d + z * s,
        z * x * d - y * s,
        0,
        x * y * d - z * s,
        c + y * y * d,
        z * y * d + x * s,
        0,
        x * z * d + y * s,
        y * z * d - x * s,
        c + z * z * d,
        0
      );
      const p = track.pivot!,
        rp = transformPoint(m, p);
      m.splice(12, 3, ...p.map((n, i) => n - rp[i]));
      rotations.set(track.path, m);
    }
  }
  return new Map(
    [...new Set([...translations.keys(), ...rotations.keys()])].map((path) => [
      path,
      multiply(translations.get(path) ?? identity(), rotations.get(path) ?? identity())
    ])
  );
}
export function worldMatrices(
  nodes: AssemblyNode[],
  deltas = new Map<string, number[]>()
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const n of nodes)
    result.set(
      n.path,
      multiply(
        n.parent ? result.get(n.parent)! : identity(),
        multiply(deltas.get(n.path) ?? identity(), n.transform)
      )
    );
  return result;
}
export function validateView(raw: unknown, geometry: ProgramGeometry): CadView {
  const v = object(raw),
    result: CadView = {};
  if (
    Object.keys(v).some(
      (key) =>
        !["timeSeconds", "paths", "hiddenPaths", "explode", "explodeMode", "section", "sections"].includes(
          key
        )
    )
  )
    throw new Error("未知 CAD 视图选项");
  if (v.timeSeconds !== undefined) {
    if (
      !geometry.motion ||
      typeof v.timeSeconds !== "number" ||
      !Number.isFinite(v.timeSeconds) ||
      v.timeSeconds < 0 ||
      v.timeSeconds > geometry.motion.duration
    )
      throw new Error("运动时间须在 0 到 duration 内，且模型具有运动轨道");
    result.timeSeconds = v.timeSeconds;
  }
  for (const key of ["paths", "hiddenPaths"] as const) {
    if (v[key] === undefined) continue;
    const available = new Set(geometry.assembly?.map((n) => n.path));
    if (
      !Array.isArray(v[key]) ||
      !v[key].length ||
      v[key].length > 256 ||
      !v[key].every((p) => typeof p === "string" && available.has(p))
    )
      throw new Error("隔离路径不存在或超过预算");
    result[key] = v[key];
  }
  if (v.explode !== undefined) {
    if (typeof v.explode !== "number" || !Number.isFinite(v.explode) || v.explode < 0 || v.explode > 1)
      throw new Error("爆炸比例须在 0–1");
    result.explode = v.explode;
  }
  if (v.explodeMode !== undefined) {
    if (v.explodeMode !== "parts" && v.explodeMode !== "groups") throw new Error("无效爆炸方式");
    result.explodeMode = v.explodeMode;
  }
  const section = (rawSection: unknown): CadSection => {
    const s = object(rawSection);
    if (
      Object.keys(s).some((key) => !["axis", "offset", "inverted"].includes(key)) ||
      !["x", "y", "z"].includes(String(s.axis)) ||
      typeof s.offset !== "number" ||
      !Number.isFinite(s.offset) ||
      Math.abs(s.offset) > 1e9 ||
      (s.inverted !== undefined && typeof s.inverted !== "boolean")
    )
      throw new Error("剖切需要 x/y/z 轴和毫米位置");
    return {
      axis: s.axis as CadSection["axis"],
      offset: s.offset,
      ...(s.inverted === undefined ? {} : { inverted: s.inverted as boolean })
    };
  };
  if (v.section !== undefined) result.section = section(v.section);
  if (v.sections !== undefined) {
    if (v.section !== undefined || !Array.isArray(v.sections) || !v.sections.length || v.sections.length > 3)
      throw new Error("剖切最多三个轴，section 与 sections 不能同时使用");
    result.sections = v.sections.map(section);
    if (new Set(result.sections.map((s) => s.axis)).size !== result.sections.length)
      throw new Error("剖切轴不能重复");
  }
  return result;
}
export function explosionOffsets(
  geometry: ProgramGeometry,
  mode: "parts" | "groups" = "parts"
): Map<string, number[]> {
  const center = [0, 1, 2].map((a) => {
    const bounds = geometry.features.map((f) => f.bounds).filter((b) => b !== undefined);
    return bounds.length
      ? (Math.min(...bounds.map((b) => b[0][a])) + Math.max(...bounds.map((b) => b[1][a]))) / 2
      : 0;
  });
  const distance = Math.max(...geometry.dimensions, 1) * 0.6;
  const nodes = new Map(geometry.assembly?.map((n) => [n.path, n]));
  const groupKey = (f: ProgramGeometry["features"][number]) => {
    if (mode !== "groups" || !f.path) return f.id;
    let node = nodes.get(f.path);
    while (node?.parent && nodes.get(node.parent)?.parent) node = nodes.get(node.parent);
    return node?.path ?? f.id;
  };
  const groups = new Map<string, number[][]>();
  for (const f of geometry.features) {
    const key = groupKey(f),
      bounds = groups.get(key);
    if (!f.bounds) continue;
    if (!bounds)
      groups.set(
        key,
        f.bounds.map((b) => [...b])
      );
    else
      for (let a = 0; a < 3; a++) {
        bounds[0][a] = Math.min(bounds[0][a], f.bounds[0][a]);
        bounds[1][a] = Math.max(bounds[1][a], f.bounds[1][a]);
      }
  }
  const keys = [...new Set(geometry.features.map(groupKey))];
  return new Map(
    geometry.features.map((f, i) => {
      const key = groupKey(f),
        bounds = groups.get(key);
      if (mode === "groups") i = keys.indexOf(key);
      const v = bounds ? center.map((n, a) => (bounds[0][a] + bounds[1][a]) / 2 - n) : [0, 0, 0];
      if (Math.hypot(...v) < 1e-6) v[i % 3] = i % 2 ? -1 : 1;
      const length = Math.hypot(...v);
      return [f.id, v.map((n) => (n / length) * distance)];
    })
  );
}
/** Pure derived view: source geometry, metrics and baseline cache are never mutated. */
export function geometryAtView(geometry: ProgramGeometry, view: CadView): ProgramGeometry {
  const rest = worldMatrices(geometry.assembly ?? []),
    pose = worldMatrices(geometry.assembly ?? [], motionMatrices(geometry.motion, view.timeSeconds ?? 0));
  const offsets = explosionOffsets(geometry, view.explodeMode);
  const features = geometry.features
    .filter(
      (f) =>
        (!view.paths || view.paths.some((p) => withinPath(f.path, p))) &&
        !view.hiddenPaths?.some((p) => withinPath(f.path, p))
    )
    .map((f) => {
      const m =
        f.path && rest.has(f.path)
          ? multiply(pose.get(f.path)!, inverseRigid(rest.get(f.path)!))
          : identity();
      const offset = offsets.get(f.id)!.map((n) => n * (view.explode ?? 0)),
        positions: number[] = [];
      for (let i = 0; i < f.positions.length; i += 3)
        positions.push(...transformPoint(m, f.positions.slice(i, i + 3)).map((n, a) => n + offset[a]));
      let clipped = positions;
      for (const section of view.sections ?? (view.section ? [view.section] : [])) {
        const axis = "xyz".indexOf(section.axis),
          limit = section.offset,
          input = clipped;
        clipped = [];
        const insidePlane = (p: number[]) => (section.inverted ? p[axis] >= limit : p[axis] <= limit);
        for (let i = 0; i < input.length; i += 9) {
          const polygon = [input.slice(i, i + 3), input.slice(i + 3, i + 6), input.slice(i + 6, i + 9)],
            cut: number[][] = [];
          for (let j = 0; j < 3; j++) {
            const a = polygon[j],
              b = polygon[(j + 1) % 3],
              inside = insidePlane(a);
            if (inside) cut.push(a);
            if (inside !== insidePlane(b)) {
              const t = (limit - a[axis]) / (b[axis] - a[axis]);
              cut.push(a.map((n, k) => n + (b[k] - n) * t));
            }
          }
          for (let j = 1; j + 1 < cut.length; j++) clipped.push(...cut[0], ...cut[j], ...cut[j + 1]);
        }
      }
      return { ...f, positions: clipped };
    });
  return { ...geometry, features, positions: features.flatMap((f) => f.positions) };
}

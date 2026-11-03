import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { normalizeProgram, defaultComputeBudget, type CadProgram, type ParameterValue } from "./program.js";
import type { ProgramParameter, ProgramGeometry } from "./program-geometry.js";
import { evaluateCadQuery } from "./cadquery-engine.js";
import { CAD_COMPUTE_LIMITS, computeBudget } from "./compute-limits.js";
import { CadComputeQueue } from "./compute-queue.js";
export { computeBudget } from "./compute-limits.js";
import type { AssemblyNode, CadView } from "./assembly.js";

export interface PreviewReport {
  assessment?: ProgramGeometry["assessment"];
  diagnostics?: string;
  brep?: ProgramGeometry["brep"];
  tessellation?: ProgramGeometry["tessellation"];
  dimensions: number[];
  volume: number;
  triangles: number;
  definitions: ProgramParameter[];
  parameters: Record<string, ParameterValue>;
  assembly?: AssemblyNode[];
  motion?: {
    kind: "kinematic-keyframes";
    duration: number;
    trackCount: number;
    signature: string;
    tracks: Array<{ path: string; type: string; keyframes: number }>;
  };
  view?: {
    options: CadView;
    bounds: number[][];
    objects: Array<{ id: string; path?: string; bounds: number[][]; triangles: number }>;
  };
  objects: Array<{
    id: string;
    name: string;
    path?: string;
    color?: number[];
    material?: ProgramGeometry["features"][number]["material"];
    brep?: ProgramGeometry["features"][number]["brep"];
    bounds: number[][];
    triangles: number;
  }>;
}
export type PreviewState =
  | { status: "not_checked" }
  | { status: "ready"; report: PreviewReport }
  | { status: "failed"; error: string };
type PreviewResult =
  | { status: "ready"; report: PreviewReport; png: string; geometry: ProgramGeometry }
  | { status: "failed"; error: string };

// Derived metadata only; never put meshes/images in the resource or its history.
const reports = new Map<string, PreviewState>();
const fingerprint = (program: CadProgram) =>
  createHash("sha256")
    .update(JSON.stringify(normalizeProgram(program)))
    .digest("hex");
export function inspectProgram(program: CadProgram): PreviewState {
  return reports.get(fingerprint(program)) ?? { status: "not_checked" };
}
function rememberReport(key: string, state: PreviewState) {
  reports.delete(key);
  reports.set(key, state);
  while (reports.size > 16) reports.delete(reports.keys().next().value!);
}
const ready = new Map<string, { result: Extract<PreviewResult, { status: "ready" }>; bytes: number }>();
let retainedBytes = 0;
const maxRetainedBytes = CAD_COMPUTE_LIMITS.cacheBytes;
function remember(key: string, result: Extract<PreviewResult, { status: "ready" }>) {
  const geometry = result.geometry;
  const bytes =
    (geometry.positions.length + geometry.features.reduce((n, f) => n + f.positions.length, 0)) * 8 +
    JSON.stringify({
      ...geometry,
      positions: [],
      features: geometry.features.map((f) => ({ ...f, positions: [] }))
    }).length *
      2 +
    JSON.stringify(result.report).length * 2 +
    result.png.length * 2;
  const previous = ready.get(key);
  if (previous) retainedBytes -= previous.bytes;
  ready.delete(key);
  if (bytes > maxRetainedBytes) return;
  while (ready.size && (ready.size >= 8 || retainedBytes + bytes > maxRetainedBytes)) {
    const oldest = ready.keys().next().value!;
    retainedBytes -= ready.get(oldest)!.bytes;
    ready.delete(oldest);
  }
  ready.set(key, { result: structuredClone(result), bytes });
  retainedBytes += bytes;
}
function recalled(key: string) {
  const cached = ready.get(key);
  if (!cached) return undefined;
  ready.delete(key);
  ready.set(key, cached);
  return cached.result;
}
const queue = new CadComputeQueue();

/** Each job owns a worker and a fresh sandbox. Slow geometry never blocks HTTP or saving. */
export async function previewProgram(
  program: CadProgram,
  timeoutMs = defaultComputeBudget(program),
  signal?: AbortSignal,
  view?: CadView
): Promise<PreviewResult> {
  const document = normalizeProgram(program);
  computeBudget(timeoutMs);
  signal?.throwIfAborted();
  const key = fingerprint(document);
  const cached = recalled(key);
  if (cached && view === undefined) {
    rememberReport(key, { status: "ready", report: structuredClone(cached.report) });
    return structuredClone(cached);
  }
  let release: (() => void) | undefined;
  try {
    release = await queue.acquire(signal);
    signal?.throwIfAborted();
    const cached = recalled(key);
    if (cached && view === undefined) {
      rememberReport(key, { status: "ready", report: structuredClone(cached.report) });
      return structuredClone(cached);
    }
    const deadline = Date.now() + timeoutMs;
    const geometry =
      cached?.geometry ??
      (document.engine === "cadquery" ? await evaluateCadQuery(document, timeoutMs, signal) : undefined);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("CAD 计算超时；源码已保留，可增加计算预算重试");
    const result = await new Promise<PreviewResult>((resolve) => {
      const worker = new Worker(new URL("./program-preview-worker.js", import.meta.url), {
        workerData: { program: document, timeoutMs: remaining, geometry, view },
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: CAD_COMPUTE_LIMITS.previewWorkerMemoryMb }
      });
      let settled = false;
      const finish = (result: PreviewResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ status: "failed", error: "CAD 预览超时；源码已保留，可增加计算预算重试" }),
        Math.max(1, deadline - Date.now())
      );
      const abort = () => finish({ status: "failed", error: "CAD 预览已取消；源码已保留" });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.once("message", finish);
      worker.once("error", (error) => finish({ status: "failed", error: `CAD 预览失败：${error.message}` }));
      worker.once("exit", (code) => {
        if (!settled) finish({ status: "failed", error: `CAD 计算进程提前退出（${code}）；源码已保留` });
      });
    });
    if (!signal?.aborted && view === undefined) {
      if (result.status === "ready") remember(key, result);
      rememberReport(
        key,
        result.status === "ready" ? { status: "ready", report: structuredClone(result.report) } : result
      );
    }
    return result;
  } catch (error) {
    if (!release && signal?.aborted) throw error;
    const result = {
      status: "failed" as const,
      error: error instanceof Error ? error.message : "CAD 计算失败"
    };
    if (!signal?.aborted && view === undefined) {
      rememberReport(key, result);
    }
    return result;
  } finally {
    release?.();
  }
}

export async function withCadComputeSlot<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await queue.acquire(signal);
  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    release();
  }
}

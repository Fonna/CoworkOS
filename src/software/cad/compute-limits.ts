const MiB = 1024 * 1024;

/** Old hosts keep their runner until restart when the native request protocol changes. */
export const CADQUERY_RUNNER_FILE = "cadquery-runner-v2.py";

/** Shared by the native runner, isolated JSCAD workers, tools and editor. */
export const CAD_COMPUTE_LIMITS = Object.freeze({
  maxPartTriangles: 1_000_000,
  maxTotalTriangles: 1_000_000,
  maxResultBytes: 480 * MiB,
  maxExportBytes: 512 * MiB,
  nativeMemoryBytes: 2048 * MiB,
  jscadMemoryBytes: 512 * MiB,
  previewWorkerMemoryMb: 1024,
  cacheBytes: 256 * MiB,
  maxSourceBytes: MiB,
  maxDocumentBytes: 8 * MiB,
  maxConcurrent: 2,
  maxQueued: 16,
  maxQueueWaitMs: 600_000,
  maxTimeoutMs: 600_000,
  nativeDefaultTimeoutMs: 180_000,
  jscadDefaultTimeoutMs: 60_000
});

export const CAD_TIMEOUT_STEPS = Object.freeze([20_000, 60_000, 180_000, 300_000, 600_000]);

export function computeBudget(
  value: unknown = undefined,
  fallback: number = CAD_COMPUTE_LIMITS.jscadDefaultTimeoutMs
): number {
  const budget = value === undefined ? fallback : value;
  if (
    typeof budget !== "number" ||
    !Number.isInteger(budget) ||
    budget < 1 ||
    budget > CAD_COMPUTE_LIMITS.maxTimeoutMs
  )
    throw new Error("无效 CAD 计算预算");
  return budget;
}

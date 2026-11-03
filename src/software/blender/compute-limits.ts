import { ApplicationError } from "../../applications/types.js";

/** Shared native deadlines for tools, imports, exports and the workbench. */
export const BLENDER_COMPUTE_LIMITS = Object.freeze({
  runTimeoutSeconds: 180,
  renderTimeoutSeconds: 300,
  queryTimeoutSeconds: 60,
  maxTimeoutSeconds: 600
});

export function blenderTimeout(
  value: unknown,
  fallback: number = BLENDER_COMPUTE_LIMITS.runTimeoutSeconds
): number {
  const seconds = value ?? fallback;
  if (
    !Number.isInteger(seconds) ||
    Number(seconds) < 1 ||
    Number(seconds) > BLENDER_COMPUTE_LIMITS.maxTimeoutSeconds
  )
    throw new ApplicationError(
      "invalid_operation",
      `时限应为 1–${BLENDER_COMPUTE_LIMITS.maxTimeoutSeconds} 秒`,
      { sourceSaved: false }
    );
  return Number(seconds) * 1000;
}

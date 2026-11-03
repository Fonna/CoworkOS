import { relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { containsFilePath } from "./file-path.js";

export const DEFAULT_COMMAND_MAX_LOG_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COMMAND_PREVIEW_BYTES = 8_000;

export function commandOutputBudget(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Synthetic stderr shares the preview budget; the full diagnostic stays in error. */
export function commandDiagnosticPreview(message: string, maxBytes: number): string {
  return new StringDecoder("utf8").write(Buffer.from(message).subarray(0, maxBytes));
}

/** Keep evidence references usable by both Task browsing and private file reads. */
export function commandCaptureEvidence(
  value: unknown,
  agentRoot: string,
  workspaceRoot: string
): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const evidence: Record<string, unknown> = {};
  for (const key of ["stdoutBytes", "stderrBytes", "stdoutLogBytes", "stderrLogBytes"]) {
    if (typeof source[key] === "number") evidence[key] = source[key];
  }
  for (const key of ["stdoutTruncated", "stderrTruncated", "logLimitExceeded"]) {
    if (typeof source[key] === "boolean") evidence[key] = source[key];
  }
  for (const stream of ["stdout", "stderr"]) {
    const path = source[`${stream}Path`];
    if (typeof path !== "string") continue;
    const readPath = relative(agentRoot, path).replaceAll("\\", "/");
    if (containsFilePath(workspaceRoot, path)) {
      evidence[`${stream}Path`] = relative(workspaceRoot, path).replaceAll("\\", "/");
      if (agentRoot !== workspaceRoot) evidence[`${stream}ReadPath`] = readPath;
    } else {
      // A programmatic caller may expose a separate browsing root. Its own
      // command logs remain readable through read_file, not Task browsing.
      evidence[`${stream}Path`] = readPath;
      evidence.logPathBase = "agent";
    }
  }
  return evidence;
}

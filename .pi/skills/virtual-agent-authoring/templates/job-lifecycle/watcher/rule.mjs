import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Set manifest.sources[0] to an absolute CoworkOS start_job record path.
const CONFIG = { quietAfterMs: 600_000 };
export default createWatcher(CONFIG);

export function createWatcher({ quietAfterMs = 600_000, now = Date.now } = {}) {
  return async function check(context) {
    if (!Number.isSafeInteger(quietAfterMs) || quietAfterMs < 1) throw new Error("invalid quietAfterMs");
    const source = context.sources[0];
    if (typeof source !== "string" || source.length > 512 || !isAbsolute(source))
      throw new Error("job record path must be absolute and <= 512 characters");
    const clock = now();
    if (!Number.isFinite(clock)) throw new Error("invalid clock");
    if (!(await stat(source)).isFile()) throw new Error("job record is not a regular file");
    const handle = await open(source, "r");
    let record;
    try {
      const buffer = Buffer.alloc(32_769);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
      }
      if (bytes > 32_768) throw new Error("job record exceeds 32 KiB");
      record = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    } finally {
      await handle.close();
    }
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.jobId !== "string" ||
      !record.jobId ||
      record.jobId.length > 128 ||
      typeof record.logPath !== "string" ||
      Buffer.byteLength(record.logPath) > 2_048 ||
      !isAbsolute(record.logPath) ||
      typeof record.startedAt !== "string" ||
      record.startedAt.length > 64 ||
      !Number.isFinite(Date.parse(record.startedAt)) ||
      Date.parse(record.startedAt) > clock ||
      (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid < 1)) ||
      (record.finishedAt !== undefined &&
        (typeof record.finishedAt !== "string" ||
          record.finishedAt.length > 64 ||
          !Number.isFinite(Date.parse(record.finishedAt)) ||
          Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
          Date.parse(record.finishedAt) > clock)) ||
      (record.exitCode !== undefined && !Number.isInteger(record.exitCode)) ||
      (record.signal !== undefined && (typeof record.signal !== "string" || record.signal.length > 32))
    ) {
      throw new Error("invalid job record");
    }
    if (record.finishedAt === undefined && record.pid === undefined)
      throw new Error("job has no pid or recorded exit");
    let log;
    try {
      log = await stat(record.logPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (log && !log.isFile()) throw new Error("job log is not a regular file");
    let alive = false;
    if (!record.finishedAt) {
      try {
        process.kill(record.pid, 0);
        alive = true;
      } catch (error) {
        if (error.code === "EPERM") alive = true;
        else if (error.code !== "ESRCH") throw error;
      }
    }
    const quietMs = Math.max(0, clock - Math.max(Date.parse(record.startedAt), log?.mtimeMs ?? 0));
    const status = record.finishedAt ? "finished" : alive ? "running" : "unobserved_exit";
    const identity = `${source}:${record.jobId}:${record.startedAt}:${record.pid ?? "none"}`;
    const key = hash(`${identity}:${quietAfterMs}`);
    const previous = context.previousState?.key === key ? context.previousState : undefined;
    const quiet = status === "running" && quietMs >= quietAfterMs;
    const state = { key, status, quiet, sequence: previous?.sequence ?? 0 };
    // The registration probe establishes a baseline, including terminal jobs.
    if (!previous) return { events: [], state: { ...state, quiet: false } };
    const types = [];
    if (status !== previous.status) types.push(`job.${status}`);
    if (quiet && !previous.quiet) types.push("job.quiet");
    const events = types.map((type) => ({
      source,
      type,
      dedupeKey: hash(`${key}:${++state.sequence}:${type}`),
      priority: 3,
      occurredAt: new Date(clock).toISOString(),
      payload: {
        jobId: record.jobId,
        startedAt: record.startedAt,
        pid: record.pid,
        status,
        exitCode: record.exitCode,
        signal: record.signal,
        quietMs,
        logBytes: log?.size ?? 0,
        logPath: record.logPath
      }
    }));
    return { events, state };
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

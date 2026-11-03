import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Edit these fields; manifest.sources[0] points to the metric JSON snapshot.
const CONFIG = {
  metric: "REPLACE_METRIC",
  unit: "REPLACE_UNIT",
  threshold: null,
  direction: "above",
  consecutiveSamples: 2,
  maxAgeMs: 300_000
};
export default createWatcher(CONFIG);

export function createWatcher(config) {
  return async function check(context) {
    const {
      metric,
      unit,
      threshold,
      direction = "above",
      clearThreshold = threshold,
      consecutiveSamples = 2,
      maxAgeMs = 300_000,
      now = Date.now
    } = config;
    if (
      typeof metric !== "string" ||
      !metric ||
      Buffer.byteLength(metric) > 128 ||
      typeof unit !== "string" ||
      !unit ||
      Buffer.byteLength(unit) > 64 ||
      !Number.isFinite(threshold) ||
      !Number.isFinite(clearThreshold) ||
      !["above", "below"].includes(direction) ||
      (direction === "above" ? clearThreshold > threshold : clearThreshold < threshold) ||
      !Number.isSafeInteger(consecutiveSamples) ||
      consecutiveSamples < 1 ||
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 1
    )
      throw new Error("invalid metric configuration");
    const source = context.sources[0];
    if (typeof source !== "string" || source.length > 512 || !isAbsolute(source))
      throw new Error("metric path must be absolute and <= 512 characters");
    if (!(await stat(source)).isFile()) throw new Error("metric snapshot is not a regular file");
    const handle = await open(source, "r");
    let sample;
    try {
      const buffer = Buffer.alloc(16_385);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
      }
      if (bytes > 16_384) throw new Error("metric snapshot exceeds 16 KiB");
      sample = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    } finally {
      await handle.close();
    }
    const clock = now();
    const observedAt = Date.parse(sample?.observedAt);
    if (
      !sample ||
      sample.metric !== metric ||
      sample.unit !== unit ||
      !Number.isFinite(sample.value) ||
      typeof sample.observedAt !== "string" ||
      sample.observedAt.length > 64 ||
      !Number.isFinite(clock) ||
      !Number.isFinite(observedAt) ||
      observedAt > clock ||
      clock - observedAt > maxAgeMs
    ) {
      throw new Error("invalid, stale, future, or mismatched metric sample");
    }
    const key = hash(
      JSON.stringify([
        source,
        metric,
        unit,
        threshold,
        clearThreshold,
        direction,
        consecutiveSamples,
        maxAgeMs
      ])
    );
    const previous = context.previousState?.key === key ? context.previousState : undefined;
    // A repeated or older timestamp is not another independent sample.
    if (previous && observedAt <= previous.observedAt) return { events: [], state: previous };
    const hit = direction === "above" ? sample.value >= threshold : sample.value <= threshold;
    const clear = direction === "above" ? sample.value < clearThreshold : sample.value > clearThreshold;
    const state = {
      key,
      observedAt,
      count: hit ? Math.min(consecutiveSamples, (previous?.count ?? 0) + 1) : 0,
      latched: previous?.latched ?? false,
      sequence: previous?.sequence ?? 0
    };
    if (clear) state.latched = false;
    if (!previous || state.latched || state.count < consecutiveSamples) return { events: [], state };
    state.latched = true;
    return {
      events: [
        {
          source,
          type: "metric.threshold",
          priority: 3,
          dedupeKey: hash(`${key}:${++state.sequence}`),
          occurredAt: new Date(observedAt).toISOString(),
          payload: {
            metric,
            unit,
            value: sample.value,
            threshold,
            direction,
            consecutiveSamples,
            observedAt: sample.observedAt,
            evidencePath: source
          }
        }
      ],
      state
    };
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

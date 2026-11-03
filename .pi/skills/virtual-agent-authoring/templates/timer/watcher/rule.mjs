import { createHash } from "node:crypto";

// Absolute UTC start time; null intervalMs means one-shot. Harness owns polling.
const CONFIG = { startAt: "REPLACE_ISO_TIME", intervalMs: null, endAt: null };
export default createWatcher(CONFIG);

export function createWatcher({ startAt, intervalMs = null, endAt = null, now = Date.now } = {}) {
  return async function check(context) {
    const start = Date.parse(startAt);
    const end = endAt === null ? Infinity : Date.parse(endAt);
    const clock = now();
    if (
      typeof startAt !== "string" ||
      startAt.length > 64 ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(startAt) ||
      !Number.isFinite(start) ||
      (endAt !== null &&
        (typeof endAt !== "string" || endAt.length > 64 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(endAt))) ||
      !(end > start) ||
      !Number.isFinite(clock) ||
      (intervalMs !== null && (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000))
    )
      throw new Error("invalid timer configuration");
    const key = hash(JSON.stringify([startAt, intervalMs, endAt]));
    const previous = context.previousState?.key === key ? context.previousState : undefined;
    if (!previous) {
      if (intervalMs === null && clock >= start)
        throw new Error("one-shot startAt must be future when establishing a baseline");
      return {
        events: [],
        state: {
          key,
          lastSlot: clock < start ? -1 : Math.floor((clock - start) / intervalMs),
          finished: clock >= end
        }
      };
    }
    if (previous.finished) return { events: [], state: previous };
    if (clock >= end) return { events: [], state: { ...previous, finished: true } };
    if (clock < start) return { events: [], state: previous };
    const slot = intervalMs === null ? 0 : Math.floor((clock - start) / intervalMs);
    if (slot <= previous.lastSlot) return { events: [], state: previous };
    const scheduledAt = new Date(start + slot * (intervalMs ?? 0)).toISOString();
    return {
      events: [
        {
          source: "clock",
          type: "timer.due",
          priority: 2,
          dedupeKey: hash(`${key}:${slot}`),
          occurredAt: new Date(clock).toISOString(),
          payload: {
            scheduledAt,
            observedAt: new Date(clock).toISOString(),
            skippedIntervals: Math.max(0, slot - previous.lastSlot - 1)
          }
        }
      ],
      state: { key, lastSlot: slot, finished: intervalMs === null }
    };
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

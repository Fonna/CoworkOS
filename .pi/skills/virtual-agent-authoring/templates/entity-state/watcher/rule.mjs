import { createHash } from "node:crypto";

// Source: JSON { id, revision, status, observedAt }; bind a stable entity ID.
const CONFIG = { entityId: "REPLACE_ENTITY_ID", targetStates: ["REPLACE_TARGET_STATE"], maxAgeMs: 300_000 };
export default createWatcher(CONFIG);

export function createWatcher({ entityId, targetStates, maxAgeMs = 300_000, now = Date.now } = {}) {
  return async function check(context) {
    if (
      typeof entityId !== "string" ||
      !entityId ||
      entityId.startsWith("REPLACE_") ||
      entityId.length > 512 ||
      !Array.isArray(targetStates) ||
      !targetStates.length ||
      targetStates.length > 100 ||
      targetStates.some(
        (value) => typeof value !== "string" || !value || value.startsWith("REPLACE_") || value.length > 128
      ) ||
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 1
    )
      throw new Error("invalid entity configuration");
    const source = context.sources[0];
    if (typeof source !== "string" || source.length > 512 || !/^https?:\/\//.test(source))
      throw new Error("entity needs a bounded http/https source");
    const response = await context.fetchUrl(source);
    if (
      !response ||
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status >= 300 ||
      typeof response.content !== "string" ||
      Buffer.byteLength(response.content) > 16_384
    )
      throw new Error("invalid entity response");
    const entity = JSON.parse(response.content);
    const observedAt = Date.parse(entity?.observedAt);
    const clock = now();
    if (
      entity?.id !== entityId ||
      !Number.isSafeInteger(entity.revision) ||
      entity.revision < 0 ||
      typeof entity.status !== "string" ||
      !entity.status ||
      entity.status.length > 128 ||
      typeof entity.observedAt !== "string" ||
      entity.observedAt.length > 64 ||
      !Number.isFinite(observedAt) ||
      !Number.isFinite(clock) ||
      observedAt > clock ||
      clock - observedAt > maxAgeMs
    ) {
      throw new Error("invalid, stale, future, or mismatched entity snapshot");
    }
    const key = hash(JSON.stringify([source, entityId, targetStates, maxAgeMs]));
    const previous = context.previousState?.key === key ? context.previousState : undefined;
    if (previous && (entity.revision < previous.revision || observedAt < previous.observedAt))
      return { events: [], state: previous };
    if (previous && entity.revision === previous.revision) {
      if (entity.status !== previous.status) throw new Error("entity status changed without a new revision");
      return { events: [], state: { ...previous, observedAt } };
    }
    const state = {
      key,
      revision: entity.revision,
      status: entity.status,
      observedAt,
      sequence: previous?.sequence ?? 0
    };
    if (!previous || entity.status === previous.status || !targetStates.includes(entity.status))
      return { events: [], state };
    return {
      events: [
        {
          source,
          type: "entity.transition",
          priority: 2,
          dedupeKey: hash(`${key}:${++state.sequence}:${entity.revision}`),
          occurredAt: entity.observedAt,
          payload: {
            id: entity.id,
            previousStatus: previous.status,
            status: entity.status,
            revision: entity.revision,
            observedAt: entity.observedAt,
            evidenceUrl: source
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

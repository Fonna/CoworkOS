import { randomUUID } from "node:crypto";
import type { Event } from "../domain/types.js";

export function fakeEvent(runId = "run_test"): Event {
  return {
    eventId: `event_${randomUUID()}`,
    type: "test.event",
    taskId: "task_test",
    runId,
    occurredAt: new Date().toISOString(),
    payload: {}
  };
}

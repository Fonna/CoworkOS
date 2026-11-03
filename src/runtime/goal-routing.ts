import type { InboxMessage } from "../domain/types.js";
import type { WatchProgram } from "../domain/watch.js";
import type { InboxStore } from "./scheduler.js";
import { backgroundMonitoringPaused, monitorWakePaused } from "./monitoring-control.js";

/** Goal reviews have one clock: nextReviewAt, delivered by GoalSupervisor. */
export function goalOwnsTaskClock(
  programs: WatchProgram[],
  backgroundTask: boolean,
  programId?: string
): boolean {
  const managed = programs.filter((program) => program.goal);
  return managed.length > 0 && (backgroundTask || managed.some((program) => program.programId === programId));
}

/** Legacy shared-session timers auto-filled goal sources without declaring ownership. */
export function taskClockPaused(
  programs: WatchProgram[],
  backgroundTask: boolean,
  monitorIds: string[],
  programId?: string
): boolean {
  if (backgroundTask || programId) return monitorWakePaused(programs, monitorIds);
  const goalSources = new Set(
    programs.filter((program) => program.goal).flatMap((program) => program.monitorIds)
  );
  return monitorWakePaused(
    programs,
    monitorIds.filter((id) => !goalSources.has(id))
  );
}

/** Explicit completion may cancel a ready wake before any Main has leased it. */
export async function discardGoalMessage(inbox: InboxStore, message: InboxMessage): Promise<void> {
  if (message.state === "ready") await inbox.leaseMessage("main", message.messageId, 1000, "completed-goal");
  await inbox.consume(message.messageId);
}

/** Pausing one goal cannot suppress unrelated user work in a shared session. */
export function routeGoalMessage(
  programs: WatchProgram[],
  backgroundTask: boolean,
  message: InboxMessage
): "deliver" | "hold" | "discard" {
  const payload = message.payload as
    { programId?: string; requestId?: string; type?: string; monitorIds?: string[] } | undefined;
  const program = programs.find(
    (entry) =>
      entry.programId === payload?.programId ||
      Boolean(payload?.requestId && entry.goal?.decisionRequestId === payload.requestId)
  );
  if (program?.status === "paused") return "hold";
  if (program?.goal?.disposition === "needs_input" && message.kind !== "human_command") return "hold";
  if (program?.goal && program.status === "completed") return "discard";
  if (message.kind === "human_command") return "deliver";
  if (
    ["main.scheduled_wake", "main.monitors_lost"].includes(payload?.type ?? "") &&
    Array.isArray(payload?.monitorIds) &&
    (payload.type === "main.scheduled_wake"
      ? taskClockPaused(programs, backgroundTask, payload.monitorIds, payload.programId)
      : monitorWakePaused(programs, payload.monitorIds))
  )
    return "hold";
  if (backgroundTask && backgroundMonitoringPaused(programs)) return "hold";
  if (
    payload?.type === "main.scheduled_wake" &&
    goalOwnsTaskClock(programs, backgroundTask, payload.programId)
  )
    return "discard";
  const managed = programs.filter((entry) => entry.goal);
  if (
    backgroundTask &&
    managed.length &&
    managed.every((entry) => ["paused", "completed"].includes(entry.status))
  )
    return managed.some((entry) => entry.status === "paused") ? "hold" : "discard";
  return "deliver";
}

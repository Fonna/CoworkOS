import { join } from "node:path";
import { now } from "../domain/types.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { InboxStore } from "./scheduler.js";

/** A failed model response ends an attempt, not an accepted monitoring objective. */
export async function recoverWatchMain(
  workspaceRoot: string,
  taskId: string,
  runId: string,
  supervisorWake: boolean
): Promise<boolean> {
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  const task = await workspace.readTask(taskId);
  if (task.status === "cancelled" || task.status === "completed") return false;
  const watches = new WatchProgramStore(workspaceRoot);
  const programs = await watches.listPrograms(taskId);
  let active = false;
  let total = 0,
    paused = 0;
  for (const program of programs) {
    if (program.status === "completed") continue;
    for (const monitor of await watches.listVirtualAgents(taskId, program.programId)) {
      if (monitor.status === "retired" || (monitor.expiresAt && Date.parse(monitor.expiresAt) <= Date.now()))
        continue;
      total += 1;
      if (program.status === "paused" || monitor.status === "paused") paused += 1;
      else if (monitor.status === "active") active = true;
    }
  }
  if (total > 0 && total === paused) return true;
  if (!active && !(programs.length && (task.monitoring?.scope === "background" || supervisorWake)))
    return false;
  const day = now().slice(0, 10);
  const retries = task.watchRecovery?.day === day ? task.watchRecovery.retries : 0;
  if (retries >= 6) return true;
  await workspace.updateTask(taskId, { watchRecovery: { day, retries: retries + 1 } });
  const messageId = `watch-main-retry-${runId}-${day}-${retries + 1}`;
  await new InboxStore(
    join(workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
  ).enqueue({
    messageId,
    recipientAgentId: "main",
    kind: "external_event",
    eventId: messageId,
    priority: 5,
    state: "ready",
    createdAt: now(),
    payload: {
      type: "watch.main_retry",
      reason: "监控会话上次模型处理失败。原始事件和上下文仍在持久记录中，继续时先核对已执行的动作。",
      retry: retries + 1,
      dailyLimit: 6
    }
  });
  return true;
}

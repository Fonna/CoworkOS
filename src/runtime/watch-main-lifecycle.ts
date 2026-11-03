import { GoalStore } from "./goal-store.js";
import { GoalActivityStore } from "./goal-activity-store.js";
import { now } from "../domain/types.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { readSleep, writeSleep } from "./main-sleep.js";
import { WatchProgramStore } from "./watch-program-store.js";

/** A completed response settles one turn of a standing background objective. */
export async function parkBackgroundWatchGoal(
  workspaceRoot: string,
  taskId: string,
  runId: string
): Promise<boolean> {
  const task = await new LocalWorkspaceStore(workspaceRoot).readTask(taskId);
  const watches = new WatchProgramStore(workspaceRoot);
  const programs = await watches.listPrograms(taskId);
  const managed = programs.filter((program) => program.goal && program.status !== "completed");
  if (
    (task.monitoring?.scope !== "background" && managed.length === 0) ||
    task.status === "cancelled" ||
    task.completion?.signal === "finish_task"
  )
    return false;
  const monitorIds = [];
  for (const program of programs) {
    if (program.status === "completed") continue;
    for (const monitor of await watches.listVirtualAgents(taskId, program.programId)) {
      if (
        ["active", "paused"].includes(monitor.status) &&
        (!monitor.expiresAt || Date.parse(monitor.expiresAt) > Date.now())
      )
        monitorIds.push(monitor.monitorId);
    }
  }
  for (const candidate of managed) {
    if (candidate.status === "paused") continue;
    const store = new GoalStore(workspaceRoot);
    await store.withGoal(taskId, candidate.programId, async (program) => {
      const goal = program.goal!;
      if (["paused", "completed"].includes(program.status) || goal.disposition === "needs_input") return;
      const active = (await watches.listVirtualAgents(taskId, program.programId)).some(
        (monitor) =>
          monitor.status === "active" && (!monitor.expiresAt || Date.parse(monitor.expiresAt) > Date.now())
      );
      if (goal.progressPending || !goal.progressAt || (!active && !goal.nextReviewAt)) {
        await new GoalActivityStore(workspaceRoot, taskId, program.programId).publish(goal, {
          topicKey: `goal-stalled:${goal.revision}`,
          kind: "important",
          title: `${goal.brief.title}需要检查`,
          summary: "本轮处理结束，但尚未登记有效的进展或等待条件。请打开会话补充要求，或恢复目标重新规划。",
          sources: []
        });
        await store.save(
          program,
          { ...goal, waitingFor: "需要补充计划或有效的监控/复盘时间" },
          "review_required"
        );
      }
    });
  }
  if (!monitorIds.length && !managed.length) return false;
  if ((await readSleep(workspaceRoot, taskId))?.runId !== runId)
    await writeSleep(workspaceRoot, taskId, {
      runId,
      monitorIds,
      parkedAt: now(),
      reason: "本轮回答已完成，独立后台监控目标仍持续；等待注册监控的下一次事件。"
    });
  return true;
}

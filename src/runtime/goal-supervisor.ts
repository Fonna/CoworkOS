import { join } from "node:path";
import { now } from "../domain/types.js";
import { localGoalDate, nextWeeklyDigest } from "../domain/goal.js";
import { ensureGoalDecision } from "./goal-decisions.js";
import { GoalStore } from "./goal-store.js";
import { GoalActivityStore } from "./goal-activity-store.js";
import { InboxStore } from "./scheduler.js";

/** Clock/repair only. Goal planning and business decisions belong to Main. */
export class GoalSupervisor {
  private readonly store: GoalStore;
  constructor(private readonly workspaceRoot: string) {
    this.store = new GoalStore(workspaceRoot);
  }

  async runTask(taskId: string, mainRunId: string): Promise<void> {
    for (const candidate of await this.store.programs.listPrograms(taskId)) {
      if (!candidate.goal || ["paused", "completed"].includes(candidate.status)) continue;
      await this.store.withGoal(taskId, candidate.programId, async (program) => {
        const goal = program.goal;
        if (!goal || ["paused", "completed"].includes(program.status)) return;
        const inbox = new InboxStore(
          join(this.workspaceRoot, taskId, "runs", mainRunId, "agents", "main", "inbox-store.json")
        );
        await ensureGoalDecision(this.workspaceRoot, program);
        let changed = false;
        if (
          goal.progressAt &&
          !goal.pendingCommand &&
          !goal.nextReviewAt &&
          goal.disposition !== "needs_input"
        ) {
          const monitors = await this.store.programs.listVirtualAgents(taskId, program.programId);
          const active = monitors.some(
            (monitor) =>
              monitor.status === "active" &&
              (!monitor.expiresAt || Date.parse(monitor.expiresAt) > Date.now())
          );
          if (!active && program.status !== "review_required") {
            await new GoalActivityStore(this.workspaceRoot, taskId, program.programId).publish(goal, {
              topicKey: `goal-no-wake:${goal.revision}`,
              kind: "important",
              title: `${goal.brief.title}的等待条件已失效`,
              summary: "监控已结束或不可用，且没有下次复盘时间。请恢复目标重新规划，或打开会话调整要求。",
              sources: []
            });
            goal.waitingFor = "需要恢复有效监控或设置复盘时间";
            program.status = "review_required";
            changed = true;
          }
        }
        if (goal.pendingCommand) {
          const command = goal.pendingCommand;
          await inbox.enqueue({
            messageId: command.id,
            eventId: command.id,
            recipientAgentId: "main",
            kind: "external_event",
            priority: 20,
            state: "ready",
            createdAt: now(),
            payload: {
              type: "watch.goal_command",
              programId: program.programId,
              goalRevision: goal.revision,
              reason: command.reason,
              brief: goal.brief,
              instruction:
                "读取当前长期目标，继续已有计划；必要时调整监控，记录进展并登记等待条件。仅通过 publish_goal_update 汇报值得关注的结果。"
            }
          });
          goal.pendingCommand = undefined;
          changed = true;
        }
        if (
          goal.nextReviewAt &&
          Date.parse(goal.nextReviewAt) <= Date.now() &&
          goal.disposition !== "needs_input"
        ) {
          const at = goal.nextReviewAt;
          const messageId = `goal-review-${program.programId}-${goal.revision}-${at}`;
          await inbox.enqueue({
            messageId,
            eventId: messageId,
            recipientAgentId: "main",
            kind: "external_event",
            priority: 5,
            state: "ready",
            createdAt: now(),
            payload: {
              type: "watch.goal_review",
              programId: program.programId,
              goalRevision: goal.revision,
              scheduledAt: at,
              nextAction: goal.nextAction,
              waitingFor: goal.waitingFor,
              instruction: "按当前目标继续下一步；用实际结果更新计划，再决定继续、等待、请求用户决策或完成。"
            }
          });
          goal.lastReviewAt = now();
          goal.nextReviewAt = undefined;
          changed = true;
        }
        if (
          goal.brief.notificationPolicy === "digest" &&
          goal.brief.digest &&
          goal.nextDigestAt &&
          Date.parse(goal.nextDigestAt) <= Date.now()
        ) {
          const occurrence = goal.nextDigestAt;
          await new GoalActivityStore(this.workspaceRoot, taskId, program.programId).digest(occurrence, goal);
          goal.lastDigestLocalDate = localGoalDate(occurrence, goal.brief.digest.timeZone);
          goal.nextDigestAt = nextWeeklyDigest(goal.brief.digest, Date.now(), goal.lastDigestLocalDate);
          changed = true;
        }
        if (changed) await this.store.save(program, goal);
      });
    }
  }
}

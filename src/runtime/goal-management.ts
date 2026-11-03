import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { now } from "../domain/types.js";
import type { WatchProgram } from "../domain/watch.js";
import {
  GoalConflictError,
  goalBriefSchema,
  goalProgressSchema,
  goalUpdateSchema,
  nextWeeklyDigest,
  type LongTermGoal
} from "../domain/goal.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { withFileLock } from "../storage/file-lock.js";
import { ensureGoalDecision } from "./goal-decisions.js";
import { GoalStore } from "./goal-store.js";
import { GoalActivityStore } from "./goal-activity-store.js";
import { HumanRequestStore } from "./human.js";
import { requireBackgroundMonitoringActive } from "./monitoring-control.js";
import { InboxStore } from "./scheduler.js";
import { recordGoalDelegation } from "./goal-delegation.js";

const identity = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const createSchema = z
  .object({
    brief: goalBriefSchema,
    scope: z.enum(["session", "background"]).default("background"),
    requestId: z.string().min(1).max(200)
  })
  .strict();

/** Shared user/model operations. Scheduling and HTTP contain no copies of these rules. */
export class GoalManagement {
  readonly store: GoalStore;
  readonly workspace: LocalWorkspaceStore;
  constructor(readonly workspaceRoot: string) {
    this.store = new GoalStore(workspaceRoot);
    this.workspace = new LocalWorkspaceStore(workspaceRoot);
  }

  activity(taskId: string, programId: string): GoalActivityStore {
    return new GoalActivityStore(this.workspaceRoot, taskId, programId);
  }

  /** Model references may come from another conversation's global goal list. */
  async resolveTaskId(programId: string, explicitTaskId?: string): Promise<string> {
    if (explicitTaskId) {
      await this.store.read(explicitTaskId, programId);
      return explicitTaskId;
    }
    const matches = [];
    for (const task of await this.workspace.listTasks())
      if ((await this.store.programs.listPrograms(task.taskId)).some((p) => p.programId === programId))
        matches.push(task.taskId);
    if (matches.length === 1) return matches[0];
    throw new Error(
      matches.length
        ? "目标引用不唯一，请使用 manage_goal list 返回的 taskId 和 programId"
        : "目标不存在，请使用 manage_goal list 查询已有目标，不要读取或修改内部状态文件"
    );
  }

  /** One durable, idempotent handoff; the goal's own Main does the work. */
  async steer(
    taskId: string,
    programId: string,
    expectedRevision: number,
    input: { message: string; requestId: string; sourceTaskId: string; sourceRunId?: string }
  ) {
    const message = z.string().trim().min(1).max(4000).parse(input.message);
    return this.store.withGoal(taskId, programId, async (program) => {
      if (program.goal)
        await recordGoalDelegation(this.workspaceRoot, input.sourceTaskId, input.sourceRunId, program);
      const goal = this.store.requireRevision(program, expectedRevision);
      await this.requireOpen(program);
      if (program.status === "paused")
        throw new Error("目标已暂停；转交请求不能恢复目标，请按用户要求显式恢复");
      if (goal.disposition === "needs_input") throw new Error("目标正在等待用户决定，请先回答已有问题");
      const messageId = `goal-steer-${identity([programId, input.sourceTaskId, input.requestId])}`;
      const runId = program.watchRunId ?? (await this.workspace.readTask(taskId)).activeRunId;
      if (!runId) throw new Error("目标没有可接收请求的 Main Run");
      const inbox = new InboxStore(
        join(this.workspaceRoot, taskId, "runs", runId, "agents", "main", "inbox-store.json")
      );
      const queued = await inbox.enqueue({
        messageId,
        eventId: messageId,
        recipientAgentId: "main",
        kind: "external_event",
        priority: 20,
        state: "ready",
        createdAt: now(),
        payload: {
          type: "watch.goal_steer",
          programId,
          goalRevision: goal.revision,
          sourceTaskId: input.sourceTaskId,
          instruction: message
        }
      });
      return { taskId, programId, messageId, status: queued.state, revision: goal.revision };
    });
  }

  async create(
    sourceTaskId: string | undefined,
    value: unknown,
    sourceRunId?: string
  ): Promise<WatchProgram> {
    const input = createSchema.parse(value);
    if (sourceTaskId) await requireBackgroundMonitoringActive(this.workspaceRoot, sourceTaskId);
    if (input.scope === "session" && !sourceTaskId) throw new Error("会话内目标需要一个进行中的会话");
    const token = identity([sourceTaskId ?? "", input.scope, input.requestId]);
    const taskId = input.scope === "background" ? `goal-task_${token}` : sourceTaskId!;
    const programId = `goal_${token}`;
    return withFileLock(join(this.workspaceRoot, `.goal-create-${token}`), async () => {
      const existing = (await this.workspace.listTasks()).find((task) => task.taskId === taskId);
      if (
        input.scope === "session" &&
        (!existing || ["completed", "cancelled", "failed"].includes(existing.status))
      )
        throw new Error("请在进行中的会话创建目标，或选择独立后台目标");
      if (!existing) {
        await this.workspace.createTask(taskId, {
          goal: input.brief.objective,
          completion: { policy: "explicit" }
        });
        await this.workspace.updateTask(taskId, {
          title: input.brief.title,
          monitoring: { scope: "background", sourceTaskId }
        });
      }
      const owner = await this.workspace.readTask(taskId);
      const runId = owner.activeRunId ?? `main-${taskId}`;
      if (!owner.activeRunId) {
        await this.workspace.createRun(taskId, runId);
        await this.workspace.transitionTask(taskId, "waiting", { runId, reason: "long_term_goal_created" });
      }
      await this.store.programs.createProgram({
        taskId,
        programId,
        subject: input.brief.title,
        objective: input.brief.objective,
        scope: input.scope,
        sourceTaskId,
        watchRunId: runId
      });
      const saved = await this.store.withGoal(taskId, programId, async (program) => {
        if (program.goal) {
          if (program.goal.creationHash && program.goal.creationHash !== identity(input.brief))
            throw new GoalConflictError();
          return program;
        }
        const goal: LongTermGoal = {
          version: 1,
          revision: 1,
          creationHash: identity(input.brief),
          brief: input.brief,
          steps: [],
          facts: [],
          summary: "目标已登记，等待制定计划",
          nextAction: "制定计划并登记合适的监控或复盘时间",
          disposition: "continue",
          progressPending: true,
          nextDigestAt: input.brief.digest ? nextWeeklyDigest(input.brief.digest) : undefined,
          pendingCommand: { id: `goal-created-${token}`, reason: "created" }
        };
        return this.store.save(program, goal, "discovering");
      });
      await recordGoalDelegation(this.workspaceRoot, sourceTaskId, sourceRunId, saved);
      return saved;
    });
  }

  async get(taskId: string, programId: string) {
    const program = await this.store.read(taskId, programId);
    return {
      ...program,
      monitors: await this.store.programs.listVirtualAgents(taskId, programId),
      activity: await this.activity(taskId, programId).view(),
      decision: program.goal?.decisionRequestId
        ? await new HumanRequestStore(this.workspaceRoot)
            .read(taskId, program.goal.decisionRequestId)
            .catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            })
        : undefined,
      task: await this.workspace.readTask(taskId)
    };
  }

  async edit(taskId: string, programId: string, expectedRevision: number, value: unknown) {
    const brief = goalBriefSchema.parse(value);
    return this.store.withGoal(taskId, programId, async (program) => {
      const old = this.store.requireRevision(program, expectedRevision);
      await this.requireOpen(program);
      if (old.decisionRequestId) {
        await ensureGoalDecision(this.workspaceRoot, program);
        await new HumanRequestStore(this.workspaceRoot).cancel(taskId, old.decisionRequestId);
      }
      const revision = old.revision + 1;
      return this.store.save(
        program,
        {
          ...old,
          revision,
          brief,
          decisionRequestId: undefined,
          nextDigestAt: brief.digest ? nextWeeklyDigest(brief.digest) : undefined,
          progressPending: true,
          pendingCommand: { id: `goal-edited-${programId}-${revision}`, reason: "edited" },
          summary: "要求已更新，等待调整计划",
          nextAction: "根据新的要求调整计划与监控",
          waitingFor: undefined,
          disposition: "continue"
        },
        program.status === "paused" ? "paused" : "discovering"
      );
    });
  }

  async progress(taskId: string, programId: string, expectedRevision: number, value: unknown) {
    const input = goalProgressSchema.parse(value);
    return this.store.withGoal(taskId, programId, async (program) => {
      const old = this.store.requireRevision(program, expectedRevision);
      await this.requireOpen(program);
      if (program.status === "paused") throw new Error("目标已暂停");
      if (old.decisionRequestId) await ensureGoalDecision(this.workspaceRoot, program);
      if (old.decisionRequestId && input.disposition !== "needs_input") {
        const question = await new HumanRequestStore(this.workspaceRoot).read(taskId, old.decisionRequestId);
        if (question.status === "pending") throw new Error("用户尚未回答此目标的问题，请保留等待状态");
      }
      const monitors = await this.store.programs.listVirtualAgents(taskId, programId);
      const active = monitors.some(
        (monitor) =>
          monitor.status === "active" && (!monitor.expiresAt || Date.parse(monitor.expiresAt) > Date.now())
      );
      if (["wait", "continue"].includes(input.disposition) && !active && !input.nextReviewAt)
        throw new Error("持续目标需要活动监控或明确的下次复盘时间；否则请完成目标或请求用户决策");
      let decisionRequestId = old.decisionRequestId;
      if (
        input.disposition === "needs_input" &&
        (!decisionRequestId || old.waitingFor !== input.waitingFor)
      ) {
        if (decisionRequestId)
          await new HumanRequestStore(this.workspaceRoot).cancel(taskId, decisionRequestId);
        decisionRequestId = `human-goal_${identity([programId, old.revision + 1, input.waitingFor])}`;
      }
      const goal: LongTermGoal = {
        ...old,
        revision: old.revision + 1,
        steps: input.steps ?? old.steps,
        facts: input.facts ?? old.facts,
        summary: input.summary,
        nextAction: input.nextAction,
        waitingFor: input.waitingFor,
        disposition: input.disposition,
        nextReviewAt: input.nextReviewAt ?? undefined,
        progressAt: now(),
        progressPending: false,
        pendingCommand: undefined,
        decisionRequestId: input.disposition === "needs_input" ? decisionRequestId : undefined
      };
      if (input.disposition === "complete") {
        for (const monitor of monitors)
          if (monitor.status !== "retired")
            await this.store.programs.updateVirtualAgent(taskId, programId, monitor.monitorId, {
              status: "retired"
            });
      }
      const saved = await this.store.save(
        program,
        goal,
        input.disposition === "complete"
          ? "completed"
          : input.disposition === "needs_input"
            ? "review_required"
            : "monitoring"
      );
      await ensureGoalDecision(this.workspaceRoot, saved);
      return saved;
    });
  }

  async publish(taskId: string, programId: string, expectedRevision: number, value: unknown) {
    const input = goalUpdateSchema.parse(value);
    return this.store.withGoal(taskId, programId, async (program) => {
      const goal = this.store.requireRevision(program, expectedRevision);
      await this.requireOpen(program);
      if (program.status === "paused") throw new Error("目标已暂停");
      return this.activity(taskId, programId).publish(goal, input);
    });
  }

  async control(
    taskId: string,
    programId: string,
    action: "pause" | "resume" | "complete",
    expectedRevision: number
  ) {
    z.enum(["pause", "resume", "complete"]).parse(action);
    return this.store.withGoal(taskId, programId, async (program) => {
      if (action === "complete" && program.status === "completed") return program;
      const old = this.store.requireRevision(program, expectedRevision);
      await this.requireOpen(program);
      if (action === "complete" && old.decisionRequestId) {
        await ensureGoalDecision(this.workspaceRoot, program);
        await new HumanRequestStore(this.workspaceRoot).cancel(taskId, old.decisionRequestId);
      }
      if (action === "complete") {
        for (const monitor of await this.store.programs.listVirtualAgents(taskId, programId))
          if (monitor.status !== "retired")
            await this.store.programs.updateVirtualAgent(taskId, programId, monitor.monitorId, {
              status: "retired"
            });
      }
      return this.store.save(
        program,
        {
          ...old,
          revision: old.revision + 1,
          progressPending: action === "resume" ? true : old.progressPending,
          stopRequested: action === "complete",
          pendingCommand:
            action === "resume"
              ? { id: `goal-resumed-${programId}-${old.revision + 1}`, reason: "resumed" }
              : undefined,
          nextReviewAt: action === "complete" ? undefined : old.nextReviewAt,
          summary:
            action === "pause"
              ? "已暂停，保留计划和待处理结果"
              : action === "complete"
                ? "目标已结束"
                : old.summary,
          disposition: action === "complete" ? "complete" : old.disposition
        },
        action === "pause" ? "paused" : action === "complete" ? "completed" : "monitoring"
      );
    });
  }

  async respond(taskId: string, programId: string, answer: string) {
    return this.store.withGoal(taskId, programId, async (program) => {
      if (!program.goal?.decisionRequestId) throw new Error("这个目标没有等待回答的问题");
      await this.requireOpen(program);
      if (program.status === "paused") throw new Error("请先恢复目标，再提交回答");
      await ensureGoalDecision(this.workspaceRoot, program);
      return new HumanRequestStore(this.workspaceRoot).submitAnswer(
        taskId,
        program.goal.decisionRequestId,
        answer
      );
    });
  }

  private async requireOpen(program: WatchProgram) {
    if (program.status === "completed") throw new Error("目标已结束，请新建目标");
    const task = await this.workspace.readTask(program.taskId);
    if (["completed", "cancelled", "failed"].includes(task.status))
      throw new Error("会话已结束，请先重新打开会话");
  }
}

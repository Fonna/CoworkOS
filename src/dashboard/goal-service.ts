import type { VirtualAgentSpec, WatchProgram } from "../domain/watch.js";
import { GoalManagement } from "../runtime/goal-management.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { HumanRequestStore } from "../runtime/human.js";
import { WatchManagement } from "../runtime/watch-management.js";
import { effectiveWatchProgram } from "../runtime/monitoring-control.js";

/** Present old programs consistently even when their stored status predates their sources. */
function displayStatus(
  program: WatchProgram,
  taskStatus: string,
  monitors: Pick<VirtualAgentSpec, "status">[]
): WatchProgram["status"] {
  if (program.goal) return program.status;
  if (
    ["failed", "cancelled", "completed"].includes(taskStatus) ||
    (monitors.length > 0 && monitors.every((monitor) => monitor.status === "retired"))
  )
    return "completed";
  return effectiveWatchProgram(program, monitors).status;
}

/** Dashboard orchestration only; user and model operations share GoalManagement. */
export function createGoalService(ports: {
  harnessRoot: string;
  workspaceRoot(): string;
  knownWorkspaceRoots(): Promise<string[]>;
  locateTask(taskId: string): Promise<{ workspaceRoot: string }>;
  resumeHumanAnswers(taskId: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
}) {
  const manager = async (taskId: string) =>
    new GoalManagement((await ports.locateTask(taskId)).workspaceRoot);
  async function view(root: string, taskId: string, programId: string) {
    const management = new GoalManagement(root);
    const data = await management.get(taskId, programId);
    const monitoring = await new WatchManagement(root, ports.harnessRoot).list(taskId);
    const monitors = monitoring.monitors.filter((monitor) => monitor.programId === programId);
    return { ...data, status: displayStatus(data, data.task.status, monitors), monitors };
  }
  return {
    async all(taskId?: string) {
      const result = [];
      const roots = taskId
        ? [(await ports.locateTask(taskId)).workspaceRoot]
        : await ports.knownWorkspaceRoots();
      for (const root of new Set(roots)) {
        const management = new GoalManagement(root);
        for (const task of await new LocalWorkspaceStore(root).listTasks()) {
          if (taskId && task.taskId !== taskId) continue;
          for (const program of await management.store.programs.listPrograms(task.taskId)) {
            const activity = program.goal
              ? await management.activity(task.taskId, program.programId).view(1)
              : undefined;
            const legacyStatus = displayStatus(
              program,
              task.status,
              program.goal
                ? []
                : await management.store.programs.listVirtualAgents(task.taskId, program.programId)
            );
            result.push({
              ...program,
              status: legacyStatus,
              taskStatus: task.status,
              decision: program.goal?.decisionRequestId
                ? await new HumanRequestStore(root)
                    .read(task.taskId, program.goal.decisionRequestId)
                    .then((request) => ({ status: request.status }))
                    .catch((error) => {
                      if (error.code === "ENOENT") return undefined;
                      throw error;
                    })
                : undefined,
              ownerError: Boolean(task.lastError),
              goal: program.goal
                ? {
                    revision: program.goal.revision,
                    brief: { title: program.goal.brief.title, objective: program.goal.brief.objective },
                    summary: program.goal.summary,
                    nextAction: program.goal.nextAction,
                    waitingFor: program.goal.waitingFor,
                    disposition: program.goal.disposition,
                    progressPending: program.goal.progressPending,
                    pendingCommand: program.goal.pendingCommand
                  }
                : undefined,
              unreadCount: activity?.unreadCount ?? 0,
              pendingDigestCount: activity?.pendingDigestCount ?? 0
            });
          }
        }
      }
      return result;
    },
    async feed(offset = 0, unreadOnly = false, taskId?: string) {
      const programs = (await this.all(taskId)).filter((program) => program.goal);
      const entries = [];
      let total = 0,
        unreadCount = 0;
      for (const program of programs) {
        const management = await manager(program.taskId);
        const page = await management
          .activity(program.taskId, program.programId)
          .notificationPage(offset + 30, 0, unreadOnly);
        total += page.total;
        unreadCount += page.unreadCount;
        entries.push(
          ...page.notifications.map((notice) => ({
            ...notice,
            taskId: program.taskId,
            programId: program.programId,
            goalTitle: program.goal!.brief.title
          }))
        );
      }
      entries.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.notificationId.localeCompare(b.notificationId) ||
          a.programId.localeCompare(b.programId)
      );
      return { notifications: entries.slice(offset, offset + 30), total, unreadCount };
    },
    async get(taskId: string, programId: string) {
      return view((await ports.locateTask(taskId)).workspaceRoot, taskId, programId);
    },
    async create(sourceTaskId: string | undefined, input: unknown) {
      const root = sourceTaskId
        ? (await ports.locateTask(sourceTaskId)).workspaceRoot
        : ports.workspaceRoot();
      const program = await new GoalManagement(root).create(sourceTaskId, input);
      return view(root, program.taskId, program.programId);
    },
    async control(taskId: string, programId: string, input: Record<string, unknown>) {
      const management = await manager(taskId);
      if (input.action === "edit")
        await management.edit(taskId, programId, Number(input.revision), input.brief);
      else if (input.action === "respond") {
        if (typeof input.answer !== "string" || !input.answer.trim() || input.answer.length > 10000)
          throw new Error("请输入有效的回答");
        await management.respond(taskId, programId, input.answer);
        await ports.resumeHumanAnswers(taskId);
      } else if (["pause", "resume", "complete"].includes(String(input.action)))
        await management.control(
          taskId,
          programId,
          input.action as "pause" | "resume" | "complete",
          Number(input.revision)
        );
      else throw new Error("未知目标操作");
      if (input.action === "complete") {
        const owner = await management.workspace.readTask(taskId);
        if (
          owner.monitoring?.scope === "background" &&
          (await management.store.programs.listPrograms(taskId)).every(
            (program) => program.status === "completed"
          )
        )
          await ports.cancelTask(taskId);
      }
      return view(management.workspaceRoot, taskId, programId);
    },
    async readNotification(taskId: string, programId: string, notificationId: string) {
      const management = await manager(taskId);
      await management.store.read(taskId, programId);
      await management.activity(taskId, programId).readNotification(notificationId);
      return { ok: true };
    },
    async activity(taskId: string, programId: string, offset: number) {
      const management = await manager(taskId);
      await management.store.read(taskId, programId);
      return management.activity(taskId, programId).view(50, offset);
    }
  };
}

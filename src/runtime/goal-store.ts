import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";
import { WatchProgramStore } from "./watch-program-store.js";
import type { WatchProgram } from "../domain/watch.js";
import { GoalConflictError, type LongTermGoal } from "../domain/goal.js";

export function goalDirectory(root: string, taskId: string, programId: string): string {
  for (const value of [taskId, programId])
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)) throw new Error("invalid goal identity");
  return join(root, taskId, "watch", "programs", programId);
}

/** Goal edits and publishing share this short lock. No model call runs under it. */
export class GoalStore {
  readonly programs: WatchProgramStore;
  constructor(readonly workspaceRoot: string) {
    this.programs = new WatchProgramStore(workspaceRoot);
  }

  read(taskId: string, programId: string): Promise<WatchProgram> {
    goalDirectory(this.workspaceRoot, taskId, programId);
    return this.programs.readProgram(taskId, programId);
  }

  withGoal<T>(
    taskId: string,
    programId: string,
    operation: (program: WatchProgram) => Promise<T>
  ): Promise<T> {
    const directory = goalDirectory(this.workspaceRoot, taskId, programId);
    return withFileLock(join(directory, ".goal-control"), async () =>
      operation(await this.read(taskId, programId))
    );
  }

  requireRevision(program: WatchProgram, expectedRevision: number): LongTermGoal {
    if (!program.goal) throw new Error("请先将监控登记为长期目标");
    if (!Number.isSafeInteger(expectedRevision) || program.goal.revision !== expectedRevision)
      throw new GoalConflictError();
    return program.goal;
  }

  /** Call inside withGoal; WatchProgram's own lock also protects monitor membership. */
  save(program: WatchProgram, goal: LongTermGoal, status = program.status): Promise<WatchProgram> {
    return this.programs.updateProgram(program.taskId, program.programId, {
      goal,
      status,
      subject: { ...program.subject, name: goal.brief.title },
      objective: goal.brief.objective,
      notificationPolicy: goal.brief.notificationPolicy
    });
  }
}

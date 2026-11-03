import type { WatchProgram } from "../domain/watch.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { GoalActivityStore } from "./goal-activity-store.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { HumanRequestStore } from "./human.js";

/** Goal intent is saved first; these idempotent effects can be repaired after a crash. */
export async function ensureGoalDecision(root: string, program: WatchProgram): Promise<void> {
  const goal = program.goal;
  if (goal?.disposition !== "needs_input" || !goal.decisionRequestId || !goal.waitingFor) return;
  const task = await new LocalWorkspaceStore(root).readTask(program.taskId);
  const human = new HumanRequestStore(root);
  try {
    await human.read(program.taskId, goal.decisionRequestId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await human.create(
      {
        taskId: program.taskId,
        runId: task.activeRunId ?? program.watchRunId!,
        question: goal.waitingFor,
        context: goal.brief.objective
      },
      goal.decisionRequestId
    );
  }
  const activity = new GoalActivityStore(root, program.taskId, program.programId);
  if (!(await activity.hasTopic(`decision:${goal.decisionRequestId}`)))
    await activity.publish(goal, {
      topicKey: `decision:${goal.decisionRequestId}`,
      kind: "decision",
      title: `${goal.brief.title}需要你的决定`,
      summary: goal.waitingFor,
      sources: []
    });
}

/** A goal-specific decision must not suspend unrelated responsibilities on the same Main. */
export async function blockingHumanRequests(root: string, taskId: string) {
  const programs = await new WatchProgramStore(root).listPrograms(taskId);
  const owned = new Set(programs.map((program) => program.goal?.decisionRequestId).filter(Boolean));
  return (await new HumanRequestStore(root).list(taskId, "pending")).filter(
    (request) => !owned.has(request.requestId)
  );
}

import { WatchProgramStore } from "./watch-program-store.js";

/** Bounded working state; notifications and raw source history never enter it. */
export async function goalContext(
  workspaceRoot: string,
  taskId: string,
  maxCharacters = 16_000
): Promise<string> {
  const programs = (await new WatchProgramStore(workspaceRoot).listPrograms(taskId)).filter(
    (program) => program.goal && program.status !== "completed"
  );
  if (!programs.length) return "";
  const selected = [];
  let used = 0;
  for (const program of programs) {
    const goal = program.goal!;
    let value = JSON.stringify({
      programId: program.programId,
      revision: goal.revision,
      status: program.status,
      title: goal.brief.title,
      objective: goal.brief.objective,
      completionCriteria: goal.brief.completionCriteria,
      preferences: goal.brief.preferences,
      notificationPolicy: goal.brief.notificationPolicy,
      summary: goal.summary,
      progressPending: goal.progressPending,
      nextAction: goal.nextAction,
      waitingFor: goal.waitingFor,
      nextReviewAt: goal.nextReviewAt,
      decisionRequestId: goal.decisionRequestId,
      steps: goal.steps,
      facts: goal.facts.slice(-10),
      monitorIds: program.monitorIds
    });
    if (value.length > Math.max(700, maxCharacters - 500))
      value = JSON.stringify({
        programId: program.programId,
        revision: goal.revision,
        status: program.status,
        title: goal.brief.title,
        summary: goal.summary.slice(0, 300),
        truncated: true
      });
    if (used + value.length > Math.max(700, maxCharacters - 300)) break;
    selected.push(value);
    used += value.length;
  }
  return `<long_term_goal_state>\n${selected.join("\n")}\n${programs.length > selected.length ? "另有目标未展开，使用 manage_goal 查询。" : ""}\n</long_term_goal_state>`;
}

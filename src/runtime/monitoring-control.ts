import type { VirtualAgentSpec, WatchProgram } from "../domain/watch.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";

/** Old programs predate goal controls; their sources still express durable pause intent. */
export function effectiveWatchProgram(
  program: WatchProgram,
  monitors: Pick<VirtualAgentSpec, "status">[]
): WatchProgram {
  if (
    !program.goal &&
    program.status !== "completed" &&
    monitors.some((monitor) => monitor.status === "paused") &&
    monitors.every((monitor) => ["paused", "retired", "draft"].includes(monitor.status))
  )
    return { ...program, status: "paused" };
  return program;
}

export async function monitoringPrograms(root: string, taskId: string): Promise<WatchProgram[]> {
  const store = new WatchProgramStore(root);
  return Promise.all(
    (await store.listPrograms(taskId)).map(async (program) =>
      effectiveWatchProgram(program, await store.listVirtualAgents(taskId, program.programId))
    )
  );
}

export function backgroundMonitoringPaused(programs: WatchProgram[]): boolean {
  return (
    programs.length > 0 &&
    programs.every((program) => ["paused", "completed"].includes(program.status)) &&
    programs.some((program) => program.status === "paused" || program.goal?.stopRequested)
  );
}

export function monitorWakePaused(programs: WatchProgram[], monitorIds: string[]): boolean {
  return (
    monitorIds.length > 0 &&
    monitorIds.every((id) =>
      programs.some((program) => program.status === "paused" && program.monitorIds.includes(id))
    )
  );
}

/** Autonomous work in a stopped background task cannot move itself to a fresh goal. */
export async function requireBackgroundMonitoringActive(root: string, taskId: string): Promise<void> {
  const task = await new LocalWorkspaceStore(root).readTask(taskId);
  if (
    task.monitoring?.scope === "background" &&
    backgroundMonitoringPaused(await monitoringPrograms(root, taskId))
  )
    throw new Error("后台目标已暂停；请由用户显式恢复，不能自行恢复或另建目标绕过暂停");
}

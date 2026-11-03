import { id, now } from "./types.js";

/** User-facing long-running worker kinds; Runtime treats them uniformly. */
export type VirtualAgentKind = "watch" | "experiment" | "research" | "generic";
export type VirtualAgentProgramStatus = "active" | "waiting" | "paused" | "failed" | "completed";

export interface VirtualAgentProgram {
  programId: string;
  taskId: string;
  kind: VirtualAgentKind;
  objective: string;
  status: VirtualAgentProgramStatus;
  wake: "never" | "important" | "always";
  sourceId?: string;
  agentIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface VirtualAgentEvent {
  eventId: string;
  programId: string;
  taskId: string;
  agentId?: string;
  type: string;
  dedupeKey?: string;
  priority: number;
  summary?: string;
  payload?: unknown;
  createdAt: string;
}

export function newVirtualAgentProgram(input: { taskId: string; kind: VirtualAgentKind; objective: string; sourceId?: string; wake?: VirtualAgentProgram["wake"]; programId?: string }): VirtualAgentProgram {
  const timestamp = now();
  return {
    programId: input.programId ?? id("va"),
    taskId: input.taskId,
    kind: input.kind,
    objective: input.objective,
    status: "active",
    wake: input.wake ?? "important",
    sourceId: input.sourceId,
    agentIds: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function newVirtualAgentEvent(input: Omit<VirtualAgentEvent, "eventId" | "createdAt">): VirtualAgentEvent {
  return { ...input, eventId: id("va-event"), createdAt: now() };
}

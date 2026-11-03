import { id, now, type InboxMessage } from "./types.js";
import type { LongTermGoal } from "./goal.js";

/** Product-level lifecycle for a long-running user interest. */
export type WatchProgramStatus = "discovering" | "monitoring" | "paused" | "review_required" | "completed";
export type MonitorStatus = "draft" | "active" | "paused" | "failed" | "retired";
export type WakePolicy = "never" | "important" | "always";
export type NotificationPolicy = "important_only" | "digest" | "all";
export type WatchClassification = "no_change" | "relevant_change" | "uncertain";

/** A reusable adapter/handler recipe. It contains no task-specific state. */
export interface WatchProfile {
  profileId: string;
  version: number;
  kind:
    "web-page-change" | "rss-news" | "search-news" | "research-papers" | "file-change" | "timer" | "custom";
  description: string;
  sourceKinds: string[];
  reusable: boolean;
}

/** Stable product object created from a user's long-term interest. */
export interface WatchProgram {
  programId: string;
  taskId: string;
  /** Stable Run used by the watcher; model runs use separate run ids. */
  watchRunId?: string;
  scope?: "session" | "background";
  sourceTaskId?: string;
  status: WatchProgramStatus;
  subject: { name: string; canonicalIds?: string[]; aliases?: string[]; confidence?: number };
  objective: string;
  notificationPolicy: NotificationPolicy;
  monitorIds: string[];
  baselineArtifactId?: string;
  revision: number;
  goal?: LongTermGoal;
  createdAt: string;
  updatedAt: string;
}

/** Deliberately small Main-facing instance schema. Runtime fills in state. */
export interface VirtualAgentSpec {
  monitorId: string;
  programId: string;
  task: string;
  profileId?: string;
  persistent: true;
  templateId?: string;
  config?: Record<string, unknown>;
  eventMode?: "analyze" | "direct";
  maxModelRunsPerDay?: number;
  maxWakeRequestsPerDay?: number;
  expiresAt?: string;
  status: MonitorStatus;
  cadenceSeconds?: number;
  wake: WakePolicy;
  sourcesHint?: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface VirtualAgentState {
  monitorId: string;
  status: MonitorStatus;
  lastCheckedAt?: string;
  checkCount?: number;
  eventCount?: number;
  modelRunCount?: number;
  modelBudgetDay?: string;
  modelRunsToday?: number;
  wakeBudgetDay?: string;
  wakeRequestsToday?: number;
  wakeRequestCount?: number;
  /** Daily delivery reservations make failed enqueues retry without charging twice. */
  wakeRequestIds?: string[];
  retryAt?: string;
  pollRetryAt?: string;
  analysisRetryAt?: string;
  wakeRetryAt?: string;
  deliveryRetryAt?: string;
  pollFailures?: number;
  analysisFailures?: number;
  deliveryFailures?: number;
  pollError?: string;
  analysisError?: string;
  deliveryError?: string;
  deferredReason?: "model_unconfigured";
  processing?: boolean;
  lastEventAt?: string;
  lastEventId?: string;
  lastRunId?: string;
  lastClassification?: WatchClassification;
  analysisEventId?: string;
  analysisRunId?: string;
  nextCheckAt?: string;
  lastWakeAt?: string;
  /** An analyzed result awaiting durable delivery to Main. Replayed without another model run. */
  pendingWake?: { runId: string; message: InboxMessage; controlMessageIds?: string[] };
  /** Direct source delivery can overlap an independently analyzed human control. */
  pendingControlWake?: { runId: string; message: InboxMessage; controlMessageIds?: string[] };
  cursor?: string;
  consecutiveFailures: number;
  failureStartedAt?: string;
  failureNotifiedAt?: string;
  lastSummary?: string;
  updatedAt: string;
}

export const BUILTIN_WATCH_PROFILES: readonly WatchProfile[] = [
  {
    profileId: "web-page-change",
    version: 1,
    kind: "web-page-change",
    description: "Detect a meaningful change on a directly visited URL.",
    sourceKinds: ["url"],
    reusable: true
  },
  {
    profileId: "rss-news",
    version: 1,
    kind: "rss-news",
    description: "Poll an RSS/Atom feed and emit new entries.",
    sourceKinds: ["rss", "atom"],
    reusable: true
  },
  {
    profileId: "search-news",
    version: 1,
    kind: "search-news",
    description: "Run a bounded news search and deduplicate results.",
    sourceKinds: ["search"],
    reusable: true
  },
  {
    profileId: "research-papers",
    version: 1,
    kind: "research-papers",
    description: "Discover recent academic works from Crossref/OpenAlex for later relevance verification.",
    sourceKinds: ["crossref", "openalex", "papers"],
    reusable: true
  },
  {
    profileId: "file-change",
    version: 1,
    kind: "file-change",
    description: "Poll a local file and emit content changes.",
    sourceKinds: ["file"],
    reusable: true
  },
  {
    profileId: "timer",
    version: 1,
    kind: "timer",
    description: "Wake Main on a fixed cadence with no source to observe.",
    sourceKinds: ["clock"],
    reusable: true
  },
  {
    profileId: "custom",
    version: 1,
    kind: "custom",
    description: "Execute a Virtual Agent-authored watcher/rule.mjs in its task workspace.",
    sourceKinds: ["web", "api", "file", "custom"],
    reusable: true
  }
];

export function newWatchProgram(input: {
  taskId: string;
  subject: string;
  objective: string;
  notificationPolicy?: NotificationPolicy;
  watchRunId?: string;
  scope?: "session" | "background";
  sourceTaskId?: string;
}): WatchProgram {
  const timestamp = now();
  return {
    programId: id("watch"),
    taskId: input.taskId,
    watchRunId: input.watchRunId,
    scope: input.scope ?? "session",
    sourceTaskId: input.sourceTaskId,
    status: "discovering",
    subject: { name: input.subject },
    objective: input.objective,
    notificationPolicy: input.notificationPolicy ?? "important_only",
    monitorIds: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function newVirtualAgent(input: {
  programId: string;
  task: string;
  profileId?: string;
  cadenceSeconds?: number;
  wake?: WakePolicy;
  sourcesHint?: string[];
}): VirtualAgentSpec {
  const timestamp = now();
  return {
    monitorId: id("monitor"),
    programId: input.programId,
    task: input.task,
    profileId: input.profileId,
    persistent: true,
    status: "draft",
    cadenceSeconds: input.cadenceSeconds,
    wake: input.wake ?? "important",
    sourcesHint: input.sourcesHint,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function initialVirtualAgentState(monitorId: string): VirtualAgentState {
  return { monitorId, status: "draft", consecutiveFailures: 0, updatedAt: now() };
}

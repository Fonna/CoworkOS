import { id, now } from "./types.js";

/** Durable state for an iterative training, evaluation or data experiment. */
export type ExperimentStatus = "planned" | "running" | "waiting" | "paused" | "completed" | "failed";
export type ExperimentRunStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "timed_out" | "cancelled";

/**
 * What a run changed. Self-improvement work optimizes different things —
 * training data, model weights, the harness code itself — so identity is a
 * kind plus a free-form reference rather than a fixed field per kind.
 */
export type ExperimentSubject = "dataset" | "weights" | "code" | "prompt" | "config" | "other";

/** Which stage of one iteration a run performed. */
export type ExperimentRunKind = "train" | "evaluate" | "generate_data" | "analyze" | "modify" | "other";

export interface ExperimentVariant {
  subject: ExperimentSubject;
  /** Dataset version, checkpoint directory, commit sha — whatever names this variant. */
  ref: string;
  /** The run this variant was derived from. Optimization builds on a parent; it does not sample independently. */
  parentRunId?: string;
  changes?: string;
}

/**
 * The one metric used to order and compare runs. Everything else stays in the
 * free-form `metrics` record, so comparison never depends on guessing which
 * of several field names carries the score.
 */
export interface MetricSpec {
  name: string;
  direction: "maximize" | "minimize";
  target?: number;
}

/** Where a run's metrics came from. A file is evidence; a model summary is a report of one. */
export type MetricsOrigin = "file" | "reported";

export interface ExperimentBudget {
  maxRuns?: number;
  maxWallTimeMs?: number;
}

export interface ExperimentProgram {
  experimentId: string;
  taskId: string;
  /** The model-facing policy owner is always Main; Runtime never chooses a run. */
  decisionOwner: "main";
  objective: string;
  successCriteria?: string;
  /** Declared once, so later runs can be ordered and compared without inferring a field name. */
  primaryMetric?: MetricSpec;
  status: ExperimentStatus;
  budget: ExperimentBudget;
  runCount: number;
  currentRunId?: string;
  nextAction?: string;
  lastSummary?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentRun {
  runId: string;
  experimentId: string;
  taskId: string;
  callId: string;
  agentId: string;
  objective: string;
  kind?: ExperimentRunKind;
  variant?: ExperimentVariant;
  status: ExperimentRunStatus;
  summary?: string;
  artifacts: string[];
  metrics?: Record<string, unknown>;
  /** Path the metrics were read from, relative to the task workspace. */
  metricsSource?: string;
  metricsOrigin?: MetricsOrigin;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
}

export function newExperimentProgram(input: { taskId: string; objective: string; successCriteria?: string; primaryMetric?: MetricSpec; budget?: ExperimentBudget; experimentId?: string }): ExperimentProgram {
  const timestamp = now();
  return {
    experimentId: input.experimentId ?? id("experiment"),
    taskId: input.taskId,
    decisionOwner: "main",
    objective: input.objective,
    successCriteria: input.successCriteria,
    primaryMetric: input.primaryMetric ? { ...input.primaryMetric } : undefined,
    status: "planned",
    budget: { ...input.budget },
    runCount: 0,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function newExperimentRun(input: { taskId: string; experimentId: string; callId: string; agentId: string; objective: string; kind?: ExperimentRunKind; variant?: ExperimentVariant }): ExperimentRun {
  const timestamp = now();
  return {
    runId: id("experiment-run"),
    experimentId: input.experimentId,
    taskId: input.taskId,
    callId: input.callId,
    agentId: input.agentId,
    objective: input.objective,
    kind: input.kind,
    variant: input.variant ? { ...input.variant } : undefined,
    status: "queued",
    artifacts: [],
    startedAt: timestamp,
    updatedAt: timestamp
  };
}

/** Read the primary metric off a run, if it reported one as a finite number. */
export function primaryMetricValue(run: ExperimentRun, spec?: MetricSpec): number | undefined {
  if (!spec) return undefined;
  const value = run.metrics?.[spec.name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Whether `candidate` beats `incumbent` under the metric's own direction. */
export function isBetter(candidate: number, incumbent: number, spec: MetricSpec): boolean {
  return spec.direction === "minimize" ? candidate < incumbent : candidate > incumbent;
}

export interface MetricSeries {
  name: string;
  /** One entry per run that reported this metric, in run order. */
  points: Array<{ runId: string; value: number }>;
}

/**
 * Derive the metric series from what the runs actually reported.
 *
 * Nothing declares which metric matters or which direction is better: a name
 * that recurs across rounds is a series, and reading its trend is Main's
 * judgment to make. Guessing a direction here would be the Runtime deciding
 * what counts as improvement.
 */
export function metricSeries(runs: readonly ExperimentRun[]): MetricSeries[] {
  const byName = new Map<string, MetricSeries["points"]>();
  for (const run of runs) {
    for (const [name, raw] of Object.entries(run.metrics ?? {})) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const points = byName.get(name) ?? [];
      points.push({ runId: run.runId, value: raw });
      byName.set(name, points);
    }
  }
  return [...byName.entries()]
    // A value seen only once is a reading, not yet a trend; keep it last so the
    // series Main is actually iterating on read first.
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([name, points]) => ({ name, points }));
}

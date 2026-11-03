import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicWrite } from "../applications/fs-utils.js";
import { withFileLock } from "../storage/file-lock.js";
import { DEFAULT_SCIENCE_CATALOG_VERSION, scienceCatalog } from "../tools/science/catalog.js";
import type { ScienceToolOptions } from "../tools/science-tools.js";
import { configuredScienceEnvironment, type ScienceEnvironmentConfig } from "./science-environment.js";

const unavailable = (): ScienceToolOptions => ({ enabled: false, catalogVersion: "unavailable" });

/** Configuration parsing never probes Python or changes the host environment. */
export function configuredScienceTools(
  env: NodeJS.ProcessEnv = process.env,
  config: ScienceEnvironmentConfig = {}
): ScienceToolOptions | undefined {
  const selected = configuredScienceEnvironment(config, env);
  if (!selected.enabled || selected.configurationError) return undefined;
  return {
    enabled: true,
    pythonExecutable: selected.pythonExecutable,
    chemistryPythonExecutable: selected.chemistryPythonExecutable,
    catalogVersion: DEFAULT_SCIENCE_CATALOG_VERSION
  };
}

function validExecutable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\0\r\n]/.test(value) &&
    (isAbsolute(value) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
  );
}

interface ScienceRun {
  workspaceRoot: string;
  taskId: string;
  runId: string;
}

interface ScienceSelection {
  version: 1;
  catalogVersion: string;
  pythonExecutable: string;
  chemistryPythonExecutable?: string;
  timeoutMs?: number;
}

function validIdentity(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

function selectionPath(run: ScienceRun): string {
  return join(run.workspaceRoot, run.taskId, "runs", run.runId, "science-tools.json");
}

function selection(value: unknown): ScienceSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<ScienceSelection>;
  const catalog =
    typeof record.catalogVersion === "string" ? scienceCatalog(record.catalogVersion) : undefined;
  if (
    record.version !== 1 ||
    typeof record.catalogVersion !== "string" ||
    !catalog ||
    !validExecutable(record.pythonExecutable) ||
    (record.chemistryPythonExecutable !== undefined && !validExecutable(record.chemistryPythonExecutable)) ||
    (record.timeoutMs !== undefined &&
      (!Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1 || record.timeoutMs > 120_000))
  )
    return undefined;
  return {
    version: 1,
    catalogVersion: record.catalogVersion,
    pythonExecutable: record.pythonExecutable,
    ...(catalog.some((entry) => entry.runtime === "chemistry") &&
    record.chemistryPythonExecutable !== undefined
      ? { chemistryPythonExecutable: record.chemistryPythonExecutable }
      : {}),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs })
  };
}

async function readSelection(path: string, enabled: boolean): Promise<ScienceToolOptions | null | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = raw.length <= 16_384 ? JSON.parse(raw) : undefined;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 2 &&
      (parsed as { version?: unknown }).version === 1 &&
      (parsed as { scope?: unknown }).scope === "none"
    )
      return null;
    const record = selection(parsed);
    if (!record) return unavailable();
    const { version: _version, ...options } = record;
    return { ...options, enabled };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : unavailable();
  }
}

/** Pin one Run's tool implementation/runtime; disabling it keeps its replay schemas available. */
export async function scienceToolsForRun(
  run: ScienceRun,
  env: NodeJS.ProcessEnv = process.env,
  config: ScienceEnvironmentConfig = {}
): Promise<ScienceToolOptions | undefined> {
  const configured = configuredScienceTools(env, config);
  if (![run.taskId, run.runId].every(validIdentity)) return configured ? unavailable() : undefined;
  const path = selectionPath(run);
  const prior = await readSelection(path, configured !== undefined);
  if (prior !== undefined || !configured) return prior ?? undefined;
  try {
    return await withFileLock(
      path,
      async () => {
        const current = await readSelection(path, true);
        if (current !== undefined) return current ?? undefined;
        const { enabled: _enabled, ...options } = configured;
        await atomicWrite(path, JSON.stringify({ version: 1, ...options }), {
          mode: 0o600
        });
        return configured;
      },
      { recoverDeadOwner: true, timeoutMs: 2000 }
    );
  } catch {
    // A failed optional pin must not prevent ordinary Agent startup or overwrite recovery evidence.
    return unavailable();
  }
}

/** Trusted retry orchestration preserves the original scope for same-Run and new-Run retries. */
export async function inheritScienceToolsForRun(run: ScienceRun, fromRunId: string): Promise<void> {
  if (![run.taskId, run.runId, fromRunId].every(validIdentity))
    throw new Error("Invalid scientific Run identity.");
  const sameRun = run.runId === fromRunId;
  const sourcePath = selectionPath({ ...run, runId: fromRunId });
  const lockOptions = { recoverDeadOwner: true, timeoutMs: 2000 };
  const raw = await withFileLock(
    sourcePath,
    async () => {
      try {
        return await readFile(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const absent = Buffer.from(JSON.stringify({ version: 1, scope: "none" }));
          if (sameRun) await atomicWrite(sourcePath, absent, { mode: 0o600, exclusive: true });
          return absent;
        }
        throw new Error("Unable to read the original scientific Run scope.");
      }
    },
    lockOptions
  );
  if (sameRun) return;
  const path = selectionPath(run);
  await withFileLock(
    path,
    async () => {
      try {
        const current = await readFile(path);
        if (!current.equals(raw)) throw new Error("The destination Run has a different scientific scope.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(path, raw, { mode: 0o600, exclusive: true });
      }
    },
    lockOptions
  );
}

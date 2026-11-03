import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mainIsAlive } from "../runtime/main-heartbeat.js";
import { withFileLock } from "../storage/file-lock.js";

interface ProjectExecutionLease {
  token: string;
  pid: number;
  host: string;
  runId: string;
  updatedAt: string;
}

function leasePath(workspaceRoot: string, taskId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(taskId) || taskId === "." || taskId === "..") {
    throw new Error("invalid task ID for project execution");
  }
  return join(workspaceRoot, taskId, "agents", "main", "project-execution.json");
}

async function readLease(path: string): Promise<ProjectExecutionLease | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ProjectExecutionLease>;
    if (
      typeof value.token !== "string" ||
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.host !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw new Error("invalid project execution lease; preserve it for recovery");
    }
    return value as ProjectExecutionLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Covers the launcher-to-Pi startup gap, including an interactive CLI between turns. */
export async function projectExecutionIsAlive(workspaceRoot: string, taskId: string): Promise<boolean> {
  return mainIsAlive(await readLease(leasePath(workspaceRoot, taskId)));
}

/** Acquire while holding the project's catalog lock, before fixing the process CWD. */
export async function beginProjectExecution(
  workspaceRoot: string,
  taskId: string
): Promise<{
  refresh: () => Promise<void>;
  release: () => Promise<void>;
}> {
  const path = leasePath(workspaceRoot, taskId);
  const token = randomUUID();
  const write = async (): Promise<void> => {
    const value: ProjectExecutionLease = {
      token,
      pid: process.pid,
      host: hostname(),
      runId: "project-launch",
      updatedAt: new Date().toISOString()
    };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${token}`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  await withFileLock(
    path,
    async () => {
      if (mainIsAlive(await readLease(path))) throw new Error("该会话已在运行，请先退出或停止运行。");
      await write();
    },
    { recoverDeadOwner: true }
  );
  return {
    refresh: () =>
      withFileLock(
        path,
        async () => {
          if ((await readLease(path))?.token === token) await write();
        },
        { recoverDeadOwner: true }
      ),
    release: () =>
      withFileLock(
        path,
        async () => {
          if ((await readLease(path))?.token === token) await rm(path, { force: true });
        },
        { recoverDeadOwner: true }
      )
  };
}

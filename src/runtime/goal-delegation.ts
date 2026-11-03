import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { WatchProgram } from "../domain/watch.js";
import { WatchProgramStore } from "./watch-program-store.js";
import { readGoalDelegationRequest } from "./goal-delegation-request.js";

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/);
const receipt = z.object({
  taskId: identity,
  programId: identity,
  requestId: z.string().min(1).max(512).optional()
});
const directory = (root: string, taskId: string, runId: string) =>
  join(root, identity.parse(taskId), "runs", identity.parse(runId), "goal-delegations");

/** A model Run that delegated work cannot fall back to a separate collector. */
export async function recordGoalDelegation(
  root: string,
  sourceTaskId: string | undefined,
  sourceRunId: string | undefined,
  program: WatchProgram
): Promise<void> {
  if (!sourceTaskId || !sourceRunId || sourceTaskId === program.taskId) return;
  const folder = directory(root, sourceTaskId, sourceRunId);
  const request = await readGoalDelegationRequest(root, sourceTaskId, sourceRunId);
  const value = receipt.parse({ ...program, requestId: request?.requestId ?? request?.legacyRequestId });
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  const suffix = value.requestId
    ? `.${createHash("sha256").update(value.requestId).digest("hex").slice(0, 32)}`
    : "";
  await rename(temporary, join(folder, `${value.programId}${suffix}.json`));
}

export async function requireCollectorOwnership(
  root: string,
  taskId: string,
  runId: string | undefined,
  programId?: string
): Promise<void> {
  if (!taskId || !runId) return;
  const folder = directory(root, taskId, runId);
  let files;
  try {
    files = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const store = new WatchProgramStore(root);
  const request = await readGoalDelegationRequest(root, taskId, runId);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const delegated = receipt.parse(JSON.parse(await readFile(join(folder, file), "utf8")));
    const delegatedRequestId = delegated.requestId ?? request?.legacyRequestId;
    if (request?.requestId && delegatedRequestId && delegatedRequestId !== request.requestId) continue;
    if (programId && programId !== delegated.programId) continue;
    const owner = await store.readProgram(delegated.taskId, delegated.programId);
    throw new Error(
      `目标 ${owner.programId} 已交接给 ${owner.taskId} 的 Main。当前注册会话不能再创建采集器，` +
        "也不能省略 programId 另建独立监控。需要补充要求请使用 manage_goal steer；暂停或结束不能在本轮绕过。"
    );
  }
}

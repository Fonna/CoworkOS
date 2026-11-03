import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withFileLock } from "../storage/file-lock.js";

/** Retries after the initial request: at most six attempts in total. */
export const DEFAULT_MODEL_ERROR_RETRIES = 5;

/** Seed Main's native Pi retry budget while retaining explicit user/project settings. */
export async function ensurePiRetryDefaults(agentDir: string): Promise<void> {
  const path = join(agentDir, "settings.json");
  await withFileLock(path, async () => {
    let settings: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings");
      settings = value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(`CoworkOS 的 Agent 设置无法读取（${path}），已保留原文件`, { cause: error });
    }
    const retry = settings.retry;
    if (retry !== undefined && (!retry || typeof retry !== "object" || Array.isArray(retry)))
      throw new Error(`CoworkOS 的 Agent 重试设置无效（${path}），已保留原文件`);
    if ((retry as Record<string, unknown> | undefined)?.maxRetries !== undefined) return;
    const next = { ...settings, retry: { ...(retry ?? {}), maxRetries: DEFAULT_MODEL_ERROR_RETRIES } };
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  });
}

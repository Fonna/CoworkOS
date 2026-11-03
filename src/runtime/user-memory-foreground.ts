import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { withFileLock } from "../storage/file-lock.js";

const ownerSchema = z.object({ pid: z.number().int().positive(), host: z.string(), taskId: z.string() });
const inputSchema = z
  .object({
    taskId: z.string(),
    inputs: z
      .array(
        z
          .object({ runId: z.string(), text: z.string().max(6000), projectDirectory: z.string().optional() })
          .strict()
      )
      .max(8),
    availableAt: z.number(),
    generation: z.number().int().nonnegative()
  })
  .strict();
type ForegroundInput = z.infer<typeof inputSchema>;
const inboxIndexSchema = z.array(z.string().regex(/^[a-f0-9]{64}\.json$/)).max(30);
const quietSchema = z.object({ availableAt: z.number() }).strict();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const shortLock = { recoverDeadOwner: true, retryMs: 5, timeoutMs: 25 };

export async function writeMemoryJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Foreground leases contain no speech and exist independently of learning eligibility. */
export class UserMemoryForeground {
  constructor(private readonly path: string) {}
  private activityPath(taskId: string, leaseId: string) {
    return join(
      `${this.path}.activity`,
      `${digest(`${hostname()}:${process.pid}:${taskId}:${leaseId}`)}.json`
    );
  }
  private inputPath(taskId: string) {
    return join(`${this.path}.inbox`, `${digest(taskId)}.json`);
  }
  private async readIndex(): Promise<string[]> {
    try {
      return inboxIndexSchema.parse(JSON.parse(await readFile(`${this.path}.inbox-index.json`, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async active(taskId: string, leaseId: string): Promise<void> {
    await writeMemoryJson(this.activityPath(taskId, leaseId), { pid: process.pid, host: hostname(), taskId });
  }
  async idle(taskId: string, leaseId: string, now = Date.now()): Promise<void> {
    // Publish cooldown before releasing the lease. A failing intake must still release its Run.
    const path = this.inputPath(taskId);
    try {
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await withFileLock(
        path,
        async () => {
          try {
            const input = inputSchema.parse(JSON.parse(await readFile(path, "utf8")));
            input.availableAt = Math.max(input.availableAt, now + 60_000);
            await writeMemoryJson(path, input);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
        shortLock
      );
    } finally {
      try {
        await withFileLock(
          `${this.path}.quiet`,
          async () => {
            let availableAt = now + 60_000;
            try {
              availableAt = Math.max(
                availableAt,
                quietSchema.parse(JSON.parse(await readFile(`${this.path}.quiet.json`, "utf8"))).availableAt
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            await writeMemoryJson(`${this.path}.quiet.json`, { availableAt });
          },
          shortLock
        );
      } finally {
        await rm(this.activityPath(taskId, leaseId), { force: true });
      }
    }
  }
  async isQuiet(now: number): Promise<boolean> {
    try {
      return (
        quietSchema.parse(JSON.parse(await readFile(`${this.path}.quiet.json`, "utf8"))).availableAt > now
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async isActive(): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(`${this.path}.activity`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(`${this.path}.activity`, name);
      try {
        const owner = ownerSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (owner.host !== hostname()) return true;
        try {
          process.kill(owner.pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
        }
        await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
      }
    }
    return false;
  }
  async enqueue(
    input: ForegroundInput["inputs"][number] & { taskId: string },
    generation: number,
    now = Date.now()
  ): Promise<void> {
    const path = this.inputPath(input.taskId);
    await withFileLock(
      `${this.path}.inbox-index`,
      async () => {
        const name = `${digest(input.taskId)}.json`;
        const index = await this.readIndex();
        const next = [...index.filter((item) => item !== name), name];
        for (const evicted of next.slice(0, Math.max(0, next.length - 30))) {
          const evictedPath = join(`${this.path}.inbox`, evicted);
          await withFileLock(evictedPath, async () => rm(evictedPath, { force: true }), shortLock);
        }
        await writeMemoryJson(`${this.path}.inbox-index.json`, next.slice(-30));
        await withFileLock(
          path,
          async () => {
            let previous: ForegroundInput | undefined;
            try {
              previous = inputSchema.parse(JSON.parse(await readFile(path, "utf8")));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const { taskId, ...speech } = input;
            const inputs = previous?.generation === generation ? previous.inputs : [];
            if (!inputs.some((item) => item.runId === speech.runId && item.text === speech.text))
              inputs.push(speech);
            await writeMemoryJson(path, {
              taskId,
              inputs: inputs.slice(-8),
              generation,
              availableAt: now + 60_000
            });
          },
          shortLock
        );
      },
      shortLock
    );
  }
  /** Only the background lease owner scans/drains accepted speech. Foreground writes stay bounded. */
  async drain(now: number, accept: (input: ForegroundInput) => Promise<boolean>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(`${this.path}.inbox`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(`${this.path}.inbox`, name);
      await withFileLock(
        path,
        async () => {
          let input: ForegroundInput;
          try {
            input = inputSchema.parse(JSON.parse(await readFile(path, "utf8")));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          if (input.availableAt > now) return;
          if (!(await accept(input))) return;
          await rm(path, { force: true });
        },
        { recoverDeadOwner: true, timeoutMs: 250 }
      );
    }
  }
}

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Event } from "../domain/types.js";
import { withFileLock } from "./file-lock.js";

export interface EventStore {
  append(event: Event): Promise<void>;
  list(runId: string): Promise<Event[]>;
}

export class JsonlEventStore implements EventStore {
  constructor(private readonly filePath: string) {}

  async append(event: Event): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
  }

  async list(runId: string): Promise<Event[]> {
    return withFileLock(this.filePath, async () => {
      try {
        const text = await readFile(this.filePath, "utf8");
        return text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Event)
          .filter((event) => event.runId === runId);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
  }
}

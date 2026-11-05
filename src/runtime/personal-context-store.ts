import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import { withFileLock } from "../storage/file-lock.js";
import { replaceFile } from "../storage/replace-file.js";
import {
  contextDocumentSchema,
  PERSONAL_CONTEXT_LIMITS,
  PersonalContextError,
  type ContextDocument
} from "../domain/personal-context.js";

/** Trusted runtime storage only; never expose transactions or paths to model tools. */
export class PersonalContextStore {
  readonly path: string;
  constructor(options: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.path = resolve(
      options.path ?? join(atriaDataPaths(options.env).home, "personal-context", "context.json")
    );
  }

  private async load(): Promise<ContextDocument | undefined> {
    let handle;
    try {
      handle = await open(this.path, "r");
      if ((await handle.stat()).size > PERSONAL_CONTEXT_LIMITS.bytes)
        throw new PersonalContextError("storage_invalid");
      const raw = await handle.readFile("utf8");
      try {
        return contextDocumentSchema.parse(JSON.parse(raw));
      } catch {
        throw new PersonalContextError("storage_invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async read(): Promise<ContextDocument> {
    return (await this.load()) ?? this.transaction((doc) => structuredClone(doc));
  }

  /** Under our lock, only this module's UUID-named abandoned files can be removed. */
  private async removeAbandonedSnapshots(): Promise<void> {
    const prefix = `${basename(this.path)}.tmp-`;
    for (const entry of await readdir(dirname(this.path), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const suffix = entry.name.slice(prefix.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)) continue;
      await rm(join(dirname(this.path), entry.name), { force: true });
    }
  }

  async transaction<T>(change: (doc: ContextDocument) => T): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    return withFileLock(
      this.path,
      async () => {
        const doc = (await this.load()) ?? {
          version: 1 as const,
          epoch: randomUUID(),
          generation: 0,
          snapshotRevision: 0,
          settings: { enabled: false, registrationEnabled: false, sensitiveEnabled: false },
          records: [],
          events: [],
          receipts: [],
          requests: []
        };
        const result = change(doc);
        if (
          doc.records.length > PERSONAL_CONTEXT_LIMITS.records ||
          doc.events.length > PERSONAL_CONTEXT_LIMITS.events ||
          doc.receipts.length > PERSONAL_CONTEXT_LIMITS.receipts ||
          doc.requests.length > PERSONAL_CONTEXT_LIMITS.requests
        )
          throw new PersonalContextError("capacity");
        const raw = `${JSON.stringify(contextDocumentSchema.parse(doc))}\n`;
        if (Buffer.byteLength(raw) > PERSONAL_CONTEXT_LIMITS.bytes)
          throw new PersonalContextError("capacity");
        await this.removeAbandonedSnapshots();
        const temporary = `${this.path}.tmp-${randomUUID()}`;
        try {
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(raw, "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await replaceFile(temporary, this.path);
        } finally {
          await rm(temporary, { force: true });
        }
        return result;
      },
      { recoverDeadOwner: true, timeoutMs: 1000 }
    );
  }
}

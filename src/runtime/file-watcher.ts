import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WatcherEvent, WatcherPoller } from "./watcher.js";

export interface FilePollingWatcherOptions {
  watcherId: string;
  rootDirectory: string;
  relativePath: string;
  emitInitial?: boolean;
}

/**
 * Small provider-neutral file watcher for long-running Tasks.
 * Polling is deliberate: it works across local filesystems, mounted volumes
 * and restarted Workers without relying on an OS watch handle staying alive.
 */
export class FilePollingWatcher implements WatcherPoller {
  readonly watcherId: string;
  private readonly rootDirectory: string;
  private readonly targetPath: string;
  private readonly emitInitial: boolean;
  private previousFingerprint?: string;

  constructor(options: FilePollingWatcherOptions) {
    if (!options.watcherId.trim()) throw new Error("watcherId must not be empty");
    if (isAbsolute(options.relativePath) || options.relativePath.split(/[\\/]/).includes(".."))
      throw new Error("relativePath must stay inside rootDirectory");
    this.watcherId = options.watcherId;
    this.rootDirectory = resolve(options.rootDirectory);
    this.targetPath = resolve(this.rootDirectory, options.relativePath);
    const relativeTarget = relative(this.rootDirectory, this.targetPath);
    if (isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`))
      throw new Error("relativePath escapes rootDirectory");
    this.emitInitial = options.emitInitial ?? false;
  }

  async poll(): Promise<WatcherEvent[]> {
    const info = await stat(this.targetPath);
    if (!info.isFile()) throw new Error(`watched path is not a file: ${this.targetPath}`);
    const bytes = await readFile(this.targetPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const fingerprint = `${info.mtimeMs}:${info.size}:${digest}`;
    const changed = this.previousFingerprint !== fingerprint;
    const firstObservation = this.previousFingerprint === undefined;
    this.previousFingerprint = fingerprint;
    if ((!changed && !firstObservation) || (firstObservation && !this.emitInitial)) return [];
    const path = relative(this.rootDirectory, this.targetPath).split("\\").join("/");
    return [
      {
        watcherId: this.watcherId,
        source: "filesystem",
        type: firstObservation ? "file.discovered" : "file.changed",
        dedupeKey: `${path}:${fingerprint}`,
        payload: { path, size: info.size, modifiedAt: info.mtime.toISOString(), sha256: digest }
      }
    ];
  }
}

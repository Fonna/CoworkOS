import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** User-owned storage stays writable in a packaged app and survives app upgrades. */
export function blenderRuntimeDirectory(): string {
  return process.env.COWORK_BLENDER_RUNTIME
    ? resolve(process.env.COWORK_BLENDER_RUNTIME)
    : join(homedir(), "Library", "Application Support", "Atria", "runtimes", "blender");
}

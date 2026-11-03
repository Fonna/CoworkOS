import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { ApplicationService } from "./application-service.js";
import { safeIdentifier } from "./types.js";
import { taskApplicationProject } from "./project-context.js";

/** Task metadata/history stay in storage; a loaded document retains its actual source root. */
export async function taskApplicationWorkspace(taskStorageRoot: string, taskId: string): Promise<string> {
  const storageRoot = resolve(taskStorageRoot);
  try {
    const manifest = JSON.parse(
      await readFile(
        join(storageRoot, safeIdentifier(taskId, "taskId"), "applications", "manifest.json"),
        "utf8"
      )
    );
    if (typeof manifest.workspaceRoot === "string" && isAbsolute(manifest.workspaceRoot))
      return resolve(manifest.workspaceRoot);
    // Same-root bindings historically omit workspaceRoot. An existing loaded
    // identity still means the storage root, never the new-file project default.
    if (manifest.loadedInstanceId || manifest.activeInstanceId || manifest.boundResourceId)
      return storageRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const task = await new LocalWorkspaceStore(storageRoot).readTask(taskId);
  if (task.temporaryWorkspaceRoot) return task.temporaryWorkspaceRoot;
  return (await taskApplicationProject(storageRoot, taskId))?.projectDirectory ?? storageRoot;
}

export async function applicationServiceForTask(
  taskStorageRoot: string,
  taskId: string
): Promise<ApplicationService> {
  return new ApplicationService(
    await taskApplicationWorkspace(taskStorageRoot, taskId),
    undefined,
    taskStorageRoot,
    await taskApplicationProject(taskStorageRoot, taskId)
  );
}

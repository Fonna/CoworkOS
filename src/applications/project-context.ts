import { basename, isAbsolute, resolve } from "node:path";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { readProjectAssignment } from "../workspace/project-assignment.js";
import { safeIdentifier, type ApplicationProject } from "./types.js";

/** A creation snapshot is affiliation, never a replacement for a resource's physical root. */
export async function taskApplicationProject(
  storageRoot: string,
  taskId: string
): Promise<ApplicationProject | null> {
  safeIdentifier(taskId, "taskId");
  const task = await new LocalWorkspaceStore(storageRoot).readTask(taskId).catch((error: Error) => {
    if (error.message === `unknown task: ${taskId}`) return undefined;
    throw error;
  });
  if (
    !task ||
    task.temporaryWorkspaceRoot ||
    task.kind === "workspace" ||
    !task.projectDirectory ||
    !isAbsolute(task.projectDirectory)
  )
    return null;
  const project =
    task.projectId && task.projectCatalogPath
      ? await readProjectAssignment(task.projectCatalogPath, task.projectId)
      : undefined;
  return {
    projectId: task.projectId ?? resolve(task.projectDirectory),
    projectName: project?.projectName ?? basename(task.projectDirectory),
    projectDirectory: task.projectDirectory,
    ...(task.projectCatalogPath ? { projectCatalogPath: task.projectCatalogPath } : {})
  };
}

/** Follow a project rename for presentation, preserving the original creation directory. */
export async function resolveApplicationProject(
  project: ApplicationProject | null
): Promise<ApplicationProject | null> {
  if (!project?.projectCatalogPath) return project;
  const current = await readProjectAssignment(project.projectCatalogPath, project.projectId);
  return current ? { ...project, projectName: current.projectName } : project;
}

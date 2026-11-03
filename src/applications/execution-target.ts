import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ApplicationService } from "./application-service.js";
import { ApplicationError, type WorkspaceResource } from "./types.js";

/** A tool may validate this identity, but must never use its paths as a grant. */
export interface ApplicationExecutionTarget {
  resourceId: string;
  appType: string;
  appInstanceId?: string;
  resourceWorkspaceRoot: string;
  resourcePath: string;
}

export function validApplicationExecutionTarget(value: unknown): value is ApplicationExecutionTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as ApplicationExecutionTarget;
  return Boolean(
    typeof target.resourceId === "string" &&
    target.resourceId.length > 0 &&
    typeof target.appType === "string" &&
    target.appType.length > 0 &&
    (target.appInstanceId === undefined || typeof target.appInstanceId === "string") &&
    typeof target.resourceWorkspaceRoot === "string" &&
    isAbsolute(target.resourceWorkspaceRoot) &&
    typeof target.resourcePath === "string" &&
    isAbsolute(target.resourcePath)
  );
}

export async function assertApplicationExecutionTarget(
  service: ApplicationService,
  resource: WorkspaceResource,
  target: ApplicationExecutionTarget
): Promise<void> {
  const instance = await service.instances.findByResource(resource.resourceId);
  if (
    resource.resourceId !== target.resourceId ||
    resource.appType !== target.appType ||
    instance?.appInstanceId !== target.appInstanceId ||
    (await realpath(service.resourceWorkspaceRoot)) !== target.resourceWorkspaceRoot ||
    (await realpath(service.resources.absolutePath(resource))) !== target.resourcePath
  )
    throw new ApplicationError(
      "execution_scope_changed",
      "原请求的应用资源归属已改变，拒绝向新目标执行工具",
      {}
    );
}

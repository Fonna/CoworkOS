export type ExecutionCapability =
  "software.read" | "software.edit" | "gui.observe" | "gui.control" | "process.execute";
export interface PermissionRequest {
  taskId: string;
  capability: ExecutionCapability;
  target: string;
}
export interface PermissionGrant extends PermissionRequest {
  expiresAt: number;
  authorizedBy: "human";
  decisionId: string;
}
export interface ExecutionPermissions {
  assert(request: PermissionRequest): Promise<void>;
}
/** Human decisions are supplied by the host; applications and models cannot manufacture grants. */
export class GrantedPermissions implements ExecutionPermissions {
  constructor(
    private readonly grants: readonly PermissionGrant[],
    private readonly clock = Date.now
  ) {}
  async assert(request: PermissionRequest): Promise<void> {
    if (
      !this.grants.some(
        (grant) =>
          grant.authorizedBy === "human" &&
          grant.decisionId.trim() &&
          grant.expiresAt > this.clock() &&
          grant.taskId === request.taskId &&
          grant.capability === request.capability &&
          grant.target === request.target
      )
    )
      throw new Error(`Permission required: ${request.capability}`);
  }
}

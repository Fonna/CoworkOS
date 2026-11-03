import type { ExecutionPermissions } from "../security/execution-permissions.js";
import type { ResourceTarget, SoftwareOperation } from "./contracts.js";
import { SoftwareProviderRegistry } from "./provider-registry.js";
/** All provider calls from a host go through the same execution permission boundary. */
export class SoftwareService {
  constructor(
    private readonly registry: SoftwareProviderRegistry,
    private readonly permissions: ExecutionPermissions
  ) {}
  private targetName(providerId: string, target: ResourceTarget): string {
    const identity =
      target.kind === "project"
        ? target.root
        : target.kind === "remote"
          ? `${target.connectionId}/${target.objectId}`
          : target.path;
    return `${providerId}:${target.kind}:${identity}`;
  }
  async read(taskId: string, providerId: string, target: ResourceTarget, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.permissions.assert({
      taskId,
      capability: "software.read",
      target: this.targetName(providerId, target)
    });
    return this.registry.resolve(providerId, target).read(target, signal);
  }
  async apply(
    taskId: string,
    providerId: string,
    target: ResourceTarget,
    operation: SoftwareOperation,
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    await this.permissions.assert({
      taskId,
      capability: "software.edit",
      target: this.targetName(providerId, target)
    });
    return this.registry.resolve(providerId, target).apply(target, operation, signal);
  }
}

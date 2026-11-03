import { SoftwareProtocolError, type ResourceTarget, type SoftwareProvider } from "./contracts.js";
/** Registration is installation-time trusted code, never a model-provided executable. */
export class SoftwareProviderRegistry {
  private readonly providers = new Map<string, SoftwareProvider>();
  register(provider: SoftwareProvider): void {
    if (provider.protocolVersion !== 2 || this.providers.has(provider.id))
      throw new Error("Unsupported protocol or duplicate software provider");
    this.providers.set(provider.id, provider);
  }
  resolve(id: string, target: ResourceTarget): SoftwareProvider {
    const provider = this.providers.get(id);
    if (!provider || !provider.resourceKinds.includes(target.kind))
      throw new SoftwareProtocolError("unsupported_resource", `Provider ${id} cannot open ${target.kind}`);
    return provider;
  }
  async close(): Promise<void> {
    await Promise.all([...this.providers.values()].map((provider) => provider.close?.()));
  }
}

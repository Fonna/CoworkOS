import { ApplicationError, type ApplicationDefinition, type WorkbenchRuntimeAdapter } from "./types.js";

/**
 * A static registry of trusted, built-in Adapters.
 *
 * MVP deliberately does not execute Adapter code found in a Task: an Adapter is
 * ordinary harness source that is registered here. Everything the platform needs
 * to route a resource — which application owns it, which operations exist, which
 * kinds it can open — is read from the declaration, never from a switch on
 * `appType` somewhere in the store.
 */
export class ApplicationRegistry {
  private readonly adapters = new Map<string, WorkbenchRuntimeAdapter>();

  register(adapter: WorkbenchRuntimeAdapter): this {
    const appType = adapter.definition.appType;
    if (!appType) throw new Error("adapter definition requires appType");
    if (this.adapters.has(appType)) throw new Error(`adapter already registered: ${appType}`);
    this.adapters.set(appType, adapter);
    return this;
  }

  /** The single lookup every caller uses, so an unknown app fails identically everywhere. */
  require(appType: string): WorkbenchRuntimeAdapter {
    const adapter = this.adapters.get(appType);
    if (!adapter)
      throw new ApplicationError("application_not_found", `未注册的应用类型：${appType}`, { appType });
    return adapter;
  }

  definitions(): ApplicationDefinition[] {
    return [...this.adapters.values()].map((adapter) => adapter.definition);
  }

  /** Default launchers and model discovery, without removing support for existing resources. */
  catalogDefinitions(): ApplicationDefinition[] {
    return this.definitions().filter((definition) => definition.catalogVisibility !== "compatibility");
  }

  /** Pick an application for a resource kind when the caller did not name one. */
  forKind(kind: string): WorkbenchRuntimeAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.definition.resourceKinds.includes(kind)) return adapter;
    }
    return undefined;
  }

  /** Interchange formats are not native resource kinds: conversion belongs to the UI Adapter. */
  forFileImport(mimeType: string): WorkbenchRuntimeAdapter | undefined {
    return [...this.adapters.values()].find((adapter) =>
      adapter.definition.fileImportFormats?.some((format) => format.mimeType === mimeType)
    );
  }

  /** Reject a resource the named application cannot open, before anything is written. */
  requireKind(appType: string, kind: string): WorkbenchRuntimeAdapter {
    const adapter = this.require(appType);
    if (!adapter.definition.resourceKinds.includes(kind)) {
      throw new ApplicationError(
        "unsupported_resource_kind",
        `${adapter.definition.displayName} 无法打开 ${kind}`,
        {
          appType,
          kind,
          supported: adapter.definition.resourceKinds
        }
      );
    }
    return adapter;
  }

  requireOperation(appType: string, operationType: string): WorkbenchRuntimeAdapter {
    const adapter = this.require(appType);
    if (!(operationType in adapter.definition.operationSchemas)) {
      throw new ApplicationError(
        "invalid_operation",
        `${adapter.definition.displayName} 不支持操作 ${operationType}`,
        {
          appType,
          operationType,
          supported: Object.keys(adapter.definition.operationSchemas)
        }
      );
    }
    return adapter;
  }
}

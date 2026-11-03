/** Software protocol v2: asynchronous, explicit resource shape, opaque revisions. */
export type ResourceTarget =
  | { kind: "utf8-file"; path: string }
  | { kind: "binary-file"; path: string; mediaType: string }
  | { kind: "project"; root: string; entryPoints: string[] }
  | { kind: "remote"; connectionId: string; objectId: string };
export type ResourceContent =
  | { kind: "utf8-file"; text: string }
  | { kind: "binary-file"; bytes: Uint8Array; mediaType: string }
  | { kind: "project"; entries: { path: string; revision: string; mediaType: string }[] }
  | { kind: "remote"; value: unknown; schema: string };
export interface SoftwareSnapshot {
  revision: string;
  content: ResourceContent;
}
export interface SoftwareOperation {
  id: string;
  baseRevision: string;
  type: string;
  payload: unknown;
}
export interface SoftwareProvider {
  id: string;
  protocolVersion: 2;
  resourceKinds: ResourceTarget["kind"][];
  read(target: ResourceTarget, signal?: AbortSignal): Promise<SoftwareSnapshot>;
  apply(
    target: ResourceTarget,
    operation: SoftwareOperation,
    signal?: AbortSignal
  ): Promise<SoftwareSnapshot>;
  close?(): Promise<void>;
}
export class SoftwareProtocolError extends Error {
  constructor(
    readonly code: "unsupported_resource" | "revision_conflict" | "invalid_operation",
    message: string,
    readonly currentRevision?: string
  ) {
    super(message);
  }
}

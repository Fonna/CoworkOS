import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { relative, isAbsolute, sep } from "node:path";
import { atomicWrite } from "../applications/fs-utils.js";
import { withFileLock } from "../storage/file-lock.js";
import {
  SoftwareProtocolError,
  type ResourceTarget,
  type SoftwareProvider,
  type SoftwareOperation,
  type SoftwareSnapshot
} from "./contracts.js";
const revision = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Binary adapter for explicitly authorized local roots. Not registered in the TXT UI. */
export class BinaryFileProvider implements SoftwareProvider {
  readonly id = "local-binary";
  readonly protocolVersion = 2;
  readonly resourceKinds = ["binary-file"] as ResourceTarget["kind"][];
  constructor(
    private readonly roots: string[],
    private readonly maxBytes = 16 * 1024 * 1024
  ) {}
  private async file(target: ResourceTarget): Promise<string> {
    if (target.kind !== "binary-file")
      throw new SoftwareProtocolError("unsupported_resource", "Binary file required");
    const file = await realpath(target.path);
    const roots = await Promise.all(this.roots.map((root) => realpath(root)));
    if (
      !roots.some((root) => {
        const rel = relative(root, file);
        return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
      })
    )
      throw new Error("File is outside authorized roots");
    if (!(await stat(file)).isFile()) throw new Error("Resource is not a file");
    return file;
  }
  async read(target: ResourceTarget, signal?: AbortSignal): Promise<SoftwareSnapshot> {
    signal?.throwIfAborted();
    const file = await this.file(target);
    if ((await stat(file)).size > this.maxBytes) throw new Error("Binary resource exceeds size limit");
    const bytes = await readFile(file, { signal });
    if (bytes.byteLength > this.maxBytes) throw new Error("Binary resource exceeds size limit");
    return {
      revision: revision(bytes),
      content: {
        kind: "binary-file",
        bytes,
        mediaType: target.kind === "binary-file" ? target.mediaType : "application/octet-stream"
      }
    };
  }
  async apply(
    target: ResourceTarget,
    operation: SoftwareOperation,
    signal?: AbortSignal
  ): Promise<SoftwareSnapshot> {
    const file = await this.file(target);
    return withFileLock(`${file}.atria-v2`, async () => {
      signal?.throwIfAborted();
      const current = await this.read(target, signal);
      if (current.revision !== operation.baseRevision)
        throw new SoftwareProtocolError("revision_conflict", "Binary file changed", current.revision);
      if (
        operation.type !== "binary.replace" ||
        !(operation.payload instanceof Uint8Array) ||
        operation.payload.byteLength > this.maxBytes
      )
        throw new SoftwareProtocolError("invalid_operation", "Expected bounded binary.replace bytes");
      signal?.throwIfAborted();
      await atomicWrite(file, operation.payload, { mode: (await stat(file)).mode & 0o777 });
      return this.read(target, signal);
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, readdir, rename, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "../../applications/fs-utils.js";
import type { ResourceTarget, SoftwareOperation, SoftwareProvider, SoftwareSnapshot } from "../contracts.js";
import { SoftwareProtocolError } from "../contracts.js";
import {
  BLENDER_LIMITS,
  document,
  edits,
  emptyScene,
  invalid,
  jsonValue,
  parameters,
  pythonSource,
  record,
  renderOptions,
  scene,
  timeout,
  token,
  type BlenderDocument,
  type BlenderScene
} from "./model.js";
import { runBlender, readJobFile } from "./engine.js";
import { BLENDER_COMPUTE_LIMITS } from "./compute-limits.js";

const files = {
  "scene.blend": "application/x-blender",
  "preview.glb": "model/gltf-binary",
  "render.png": "image/png"
};
type FileName = keyof typeof files;
interface Receipt {
  document: BlenderDocument;
  scene: BlenderScene;
  hashes: Record<FileName, string>;
}
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const receiptRevision = (receipt: Receipt) =>
  createHash("sha256")
    .update(canonical({ ...receipt, document: { ...receipt.document, snapshot: null } }))
    .digest("hex")
    .slice(0, 32);

/** v2 project driver creates immutable native snapshots; the workbench manifest commits their pointer. */
export class BlenderProjectProvider implements SoftwareProvider {
  readonly id = "blender";
  readonly protocolVersion = 2 as const;
  readonly resourceKinds: ResourceTarget["kind"][] = ["project"];
  private readonly root: string;
  private readonly workspace: string;
  constructor(workspaceRoot: string) {
    this.workspace = resolve(workspaceRoot);
    this.root = join(this.workspace, "applications", "blender", "projects");
  }
  target(doc: BlenderDocument): ResourceTarget {
    return {
      kind: "project",
      root: join(this.root, token(doc.projectId)),
      entryPoints: doc.snapshot ? [`snapshots/${token(doc.snapshot)}/scene.blend`] : []
    };
  }
  private decode(target: ResourceTarget): { projectId: string; snapshot: string | null } {
    if (target.kind !== "project")
      throw new SoftwareProtocolError("unsupported_resource", "Blender 需要工程资源");
    const projectId = token(relative(this.root, resolve(target.root)));
    if (resolve(target.root) !== join(this.root, projectId)) throw invalid("工程越出 Blender 应用目录");
    if (!target.entryPoints.length) return { projectId, snapshot: null };
    if (target.entryPoints.length !== 1) throw invalid("无效工程入口");
    const matched = /^snapshots\/([a-f0-9]{32})\/scene\.blend$/.exec(target.entryPoints[0]);
    if (!matched) throw invalid("无效工程快照入口");
    return { projectId, snapshot: matched[1] };
  }
  private async checked(path: string, create = false): Promise<string> {
    await mkdir(this.workspace, { recursive: true });
    let current = await realpath(this.workspace);
    for (const part of relative(this.workspace, path).split(sep)) {
      if (!part || part === "..") throw invalid("不安全的工程路径");
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw invalid("Blender 工程目录不能是符号链接");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (create) {
          try {
            await mkdir(current);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
            if ((await lstat(current)).isSymbolicLink()) throw invalid("Blender 工程目录不能是符号链接");
          }
        } else throw invalid("Blender 快照已不存在，请恢复工程备份");
      }
    }
    return current;
  }
  private async receipt(projectId: string, snapshot: string): Promise<Receipt> {
    const directory = await this.checked(join(this.root, token(projectId), "snapshots", token(snapshot)));
    const value = record(
      JSON.parse((await this.file(directory, "snapshot.json", 2_000_000)).toString("utf8"))
    );
    const doc = document(value.document);
    if (doc.projectId !== projectId || doc.snapshot !== snapshot) throw invalid("工程快照身份不一致");
    const inputHashes = record(value.hashes),
      hashes = {} as Record<FileName, string>;
    for (const name of Object.keys(files) as FileName[]) {
      if (typeof inputHashes[name] !== "string" || !/^[a-f0-9]{64}$/.test(inputHashes[name]))
        throw invalid("快照校验记录无效");
      hashes[name] = inputHashes[name];
    }
    const receipt = { document: doc, scene: scene(value.scene), hashes };
    if (receiptRevision(receipt) !== snapshot) throw invalid("Blender 快照报告已被外部修改，校验失败");
    return receipt;
  }
  private async file(directory: string, name: string, limit = BLENDER_LIMITS.fileBytes): Promise<Buffer> {
    const path = join(directory, name),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit)
      throw invalid("工程文件无效或超过预算");
    return await readFile(path);
  }
  async bytes(doc: BlenderDocument, name: FileName): Promise<Buffer> {
    if (!doc.snapshot) throw invalid("尚未生成 Blender 场景");
    const receipt = await this.receipt(doc.projectId, doc.snapshot);
    const directory = await this.checked(join(this.root, doc.projectId, "snapshots", doc.snapshot));
    const bytes = await this.file(directory, name);
    if (hash(bytes) !== receipt.hashes[name]) throw invalid("Blender 快照已被外部修改，原工程未覆盖");
    return bytes;
  }
  async inspect(doc: BlenderDocument): Promise<BlenderScene> {
    return doc.snapshot ? (await this.receipt(doc.projectId, doc.snapshot)).scene : emptyScene();
  }
  async verify(doc: BlenderDocument): Promise<void> {
    if (doc.snapshot)
      await Promise.all((Object.keys(files) as FileName[]).map((name) => this.bytes(doc, name)));
  }
  async read(target: ResourceTarget, signal?: AbortSignal): Promise<SoftwareSnapshot> {
    signal?.throwIfAborted();
    const { projectId, snapshot } = this.decode(target);
    if (!snapshot) return { revision: "empty", content: { kind: "project", entries: [] } };
    const receipt = await this.receipt(projectId, snapshot);
    return {
      revision: snapshot,
      content: {
        kind: "project",
        entries: (Object.keys(files) as FileName[]).map((name) => ({
          path: `snapshots/${snapshot}/${name}`,
          revision: receipt.hashes[name],
          mediaType: files[name]
        }))
      }
    };
  }
  async apply(
    target: ResourceTarget,
    operation: SoftwareOperation,
    signal?: AbortSignal
  ): Promise<SoftwareSnapshot> {
    signal?.throwIfAborted();
    const base = this.decode(target);
    if (operation.baseRevision !== (base.snapshot ?? "empty"))
      throw new SoftwareProtocolError("revision_conflict", "Blender 工程版本冲突", base.snapshot ?? "empty");
    const payload = record(operation.payload),
      doc = document(payload.document);
    if (doc.projectId !== base.projectId || doc.snapshot !== base.snapshot)
      throw invalid("候选工程与读取版本不一致");
    if (!["blender.python", "blender.edit", "blender.import"].includes(operation.type))
      throw new SoftwareProtocolError("invalid_operation", "不支持此 Blender 操作");
    const requestedEdits = operation.type === "blender.edit" ? edits(payload.edits) : undefined;
    if (payload.resetScene !== undefined && typeof payload.resetScene !== "boolean")
      throw invalid("resetScene 需要布尔值");
    const source =
      operation.type === "blender.python" ? pythonSource(payload.source ?? doc.source) : doc.source;
    if (
      operation.type === "blender.import" &&
      (!(payload.body instanceof Uint8Array) ||
        !payload.body.length ||
        payload.body.length > 64 * 1024 * 1024)
    )
      throw invalid("导入 .blend 文件应为 1 字节至 64 MiB");
    const inputBlend =
      operation.type === "blender.import"
        ? payload.body
        : doc.snapshot
          ? await this.bytes(doc, "scene.blend")
          : undefined;
    const snapshots = await this.checked(join(this.root, doc.projectId, "snapshots"), true);
    // History retains all committed snapshots. Refuse before exceeding the per-project storage budget.
    let size = 0;
    for (const entry of await readdir(snapshots, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      for (const name of Object.keys(files)) size += (await lstat(join(snapshots, entry.name, name))).size;
    }
    if (size > 1024 * 1024 * 1024 - 3 * BLENDER_LIMITS.fileBytes)
      throw invalid("Blender 工程历史已接近 1 GiB，请导出备份并创建新工程");
    let snapshot = "";
    await runBlender(
      {
        operation:
          operation.type === "blender.python"
            ? "python"
            : operation.type === "blender.import"
              ? "import"
              : "edit",
        source,
        parameters: doc.parameters,
        edits: requestedEdits,
        resetScene: payload.resetScene ?? false,
        inputBlend
      },
      timeout(payload.timeoutSeconds),
      async (directory, result) => {
        const report = scene(result),
          buffers = await Promise.all(
            (Object.keys(files) as FileName[]).map((name) =>
              readJobFile(directory, name, BLENDER_LIMITS.fileBytes)
            )
          );
        signal?.throwIfAborted();
        const candidate = join(snapshots, `.pending-${randomUUID()}`);
        await mkdir(candidate);
        try {
          const hashes = {} as Record<FileName, string>;
          for (const [index, name] of (Object.keys(files) as FileName[]).entries()) {
            hashes[name] = hash(buffers[index]);
            await atomicWrite(join(candidate, name), buffers[index], { mode: 0o444 });
          }
          const receipt: Receipt = { document: { ...doc, snapshot: null }, scene: report, hashes };
          snapshot = receiptRevision(receipt);
          receipt.document.snapshot = snapshot;
          await atomicWrite(join(candidate, "snapshot.json"), JSON.stringify(receipt), { mode: 0o444 });
          signal?.throwIfAborted();
          await rename(candidate, join(snapshots, snapshot));
          // Windows cannot fsync directory handles. Each snapshot file is already flushed
          // by atomicWrite; retain directory-entry durability on hosts that support it.
          if (process.platform !== "win32") {
            const handle = await open(snapshots, "r");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
        } catch (error) {
          await rm(candidate, { recursive: true, force: true });
          throw error;
        }
        return undefined;
      },
      signal
    );
    return this.read(this.target({ ...doc, snapshot }), signal);
  }
  async prepare(
    doc: BlenderDocument,
    type: "blender.python" | "blender.edit" | "blender.import",
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ document: BlenderDocument; scene: BlenderScene }> {
    const result = await this.apply(
      this.target(doc),
      {
        id: randomUUID(),
        baseRevision: doc.snapshot ?? "empty",
        type,
        payload: { ...payload, document: doc }
      },
      signal
    );
    const receipt = await this.receipt(doc.projectId, result.revision);
    return { document: receipt.document, scene: receipt.scene };
  }
  async render(
    doc: BlenderDocument,
    options: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<Buffer> {
    const normalized = renderOptions(options);
    return runBlender(
      {
        operation: "render",
        inputBlend: await this.bytes(doc, "scene.blend"),
        renderOptions: normalized
      },
      timeout(options.timeoutSeconds, BLENDER_COMPUTE_LIMITS.renderTimeoutSeconds),
      (directory) => readJobFile(directory, "render.png", 16 * 1024 * 1024),
      signal
    );
  }
  async query(doc: BlenderDocument, options: Record<string, unknown>, signal?: AbortSignal) {
    const source = pythonSource(options.source),
      values = parameters(options.parameters);
    return runBlender(
      {
        operation: "query",
        inputBlend: await this.bytes(doc, "scene.blend"),
        source,
        parameters: { ...doc.parameters, ...values }
      },
      timeout(options.timeoutSeconds, BLENDER_COMPUTE_LIMITS.queryTimeoutSeconds),
      async (_directory, result) => ({
        value: jsonValue(result.value),
        diagnostics: typeof result.diagnostics === "string" ? result.diagnostics.slice(0, 4096) : ""
      }),
      signal
    );
  }
}

const copy = (value) => structuredClone(value);
const id = () => `blender_${crypto.randomUUID().replaceAll("-", "")}`;

/** Drafts survive conflicts and interrupted requests; retries retain the same operation ID. */
export class BlenderDocumentSession {
  constructor({ api, taskId, resourceId, storage = globalThis.sessionStorage, changed = () => {} }) {
    Object.assign(this, { api, taskId, resourceId, storage, changed });
    this.key = `atria:blender:${resourceId}`;
    this.edits = {};
    this.objectDrafts = {};
    this.dirty = false;
    this.busy = false;
    this.error = "";
    this.epoch = 0;
  }
  accept(read) {
    this.resource = read.resource;
    this.revision = read.resource.revision;
    this.model = copy(read.snapshot.content);
    this.saved = copy(this.model);
    this.selection = read.selection;
    this.parameterDraft = undefined;
    this.objectDrafts = {};
  }
  persist() {
    try {
      if (this.dirty || this.pending)
        this.storage?.setItem(
          this.key,
          JSON.stringify({
            model: this.model,
            revision: this.revision,
            edits: this.edits,
            objectDrafts: this.objectDrafts,
            pending: this.pending,
            parameterDraft: this.parameterDraft
          })
        );
      else this.storage?.removeItem(this.key);
    } catch {
      this.error ||= "无法备份草稿，请保存后再离开";
    }
  }
  updateDirty() {
    this.dirty =
      this.parameterDraft !== undefined ||
      Object.keys(this.objectDrafts).length > 0 ||
      Object.keys(this.edits).length > 0 ||
      JSON.stringify(this.model) !== JSON.stringify(this.saved);
    this.persist();
    this.changed();
  }
  async load() {
    this.accept(await this.api.readResource(this.taskId, this.resourceId));
    try {
      const draft = JSON.parse(this.storage?.getItem(this.key) || "null");
      if (
        draft?.model?.version === 1 &&
        draft.model.projectId === this.model.projectId &&
        typeof draft.model.source === "string" &&
        draft.model.source.length <= 256000 &&
        Number.isSafeInteger(draft.revision)
      ) {
        this.model = draft.model;
        this.revision = draft.revision;
        this.edits = draft.edits ?? {};
        this.objectDrafts = draft.objectDrafts ?? {};
        this.pending = draft.pending;
        if (typeof draft.parameterDraft === "string" && draft.parameterDraft.length <= 64000)
          this.parameterDraft = draft.parameterDraft;
        this.dirty = true;
        if (this.revision !== this.resource.revision)
          this.error = "工程已更新，本地草稿已保留。请备份后重新载入，或重试未确认的保存。";
      }
    } catch {
      this.error = "草稿记录无法读取，已加载保存版本";
    }
    this.changed();
  }
  editSource(source, parameters = this.model.parameters) {
    if (this.busy || this.pending) throw new Error("请先完成或重试当前保存");
    this.model = { ...this.model, source, parameters };
    this.error = "";
    this.updateDirty();
  }
  editObject(edit) {
    if (this.busy || this.pending) throw new Error("请先完成或重试当前保存");
    this.edits[edit.id] = { ...this.edits[edit.id], ...edit };
    this.error = "";
    this.updateDirty();
  }
  editParameters(text) {
    if (this.busy || this.pending) throw new Error("请先完成或重试当前保存");
    this.parameterDraft = text;
    try {
      if (text.length > 64000) throw new Error("参数超过 64000 字符预算");
      const value = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数需要 JSON 对象");
      this.model = { ...this.model, parameters: value };
      this.parameterDraft = undefined;
      this.error = "";
    } catch (error) {
      this.error = `参数格式无效，当前输入已保留：${error.message}`;
    }
    this.updateDirty();
  }
  editObjectInput({ id, key, value, edit, error, unchanged = false }) {
    if (this.busy || this.pending) throw new Error("请先完成或重试当前保存");
    if (error) {
      this.objectDrafts[id] ??= {};
      this.objectDrafts[id][key] = { value, error };
      this.error = `${error}，当前输入已保留`;
    } else {
      if (this.objectDrafts[id]) {
        delete this.objectDrafts[id][key];
        if (!Object.keys(this.objectDrafts[id]).length) delete this.objectDrafts[id];
      }
      if (unchanged) {
        for (const field of Object.keys(edit)) delete this.edits[id]?.[field];
        if (this.edits[id] && Object.keys(this.edits[id]).length <= 1) delete this.edits[id];
      } else this.edits[id] = { ...this.edits[id], id, ...edit };
      this.error = "";
    }
    this.updateDirty();
  }
  async perform(kind, body, signal) {
    this.pending ??= { kind, body: { ...body, operationId: id(), baseRevision: this.revision } };
    this.persist();
    const pending = this.pending;
    const result =
      pending.kind === "source"
        ? await this.api.applyOperation(this.taskId, this.resourceId, pending.body)
        : await this.api.executeResourceCommand(this.taskId, this.resourceId, pending.body, signal);
    const read = await this.api.readResource(this.taskId, this.resourceId);
    // Only discard the part confirmed by the server. A source save can precede object edits.
    if (pending.kind === "source") {
      const edits = this.edits;
      this.accept(read);
      this.edits = edits;
    } else {
      this.accept(read);
      this.edits = {};
    }
    this.pending = null;
    this.error = "";
    this.updateDirty();
    return result;
  }
  async guarded(action) {
    if (this.busy) return false;
    this.busy = true;
    this.epoch++;
    this.changed();
    this.controller = new AbortController();
    try {
      await action(this.controller.signal);
      return true;
    } catch (error) {
      this.error =
        error.name === "AbortError"
          ? "任务已取消。工程状态将重新核对，草稿已保留。"
          : error.code === "revision_conflict"
            ? "版本冲突：草稿已保留，请下载草稿备份后重新载入。"
            : error.message;
      if (["revision_conflict", "invalid_operation", "operation_precondition_failed"].includes(error.code))
        this.pending = null;
      this.persist();
      return false;
    } finally {
      this.busy = false;
      this.controller = null;
      this.changed();
    }
  }
  async saveParts(signal) {
    if (this.parameterDraft !== undefined) throw new Error("请修正参数 JSON 后再保存，当前输入已保留");
    if (Object.keys(this.objectDrafts).length) throw new Error("请修正对象属性后再保存，当前输入已保留");
    if (this.pending) await this.perform(this.pending.kind, this.pending.body, signal);
    if (JSON.stringify(this.model) !== JSON.stringify(this.saved))
      await this.perform(
        "source",
        {
          appType: "blender",
          operationType: "blender.document.edit",
          payload: { source: this.model.source, parameters: this.model.parameters }
        },
        signal
      );
    if (Object.keys(this.edits).length)
      await this.perform(
        "command",
        { command: "blender_apply_operations", params: { edits: Object.values(this.edits) } },
        signal
      );
  }
  save() {
    return this.guarded(async (signal) => {
      await this.saveParts(signal);
      if (this.resource.sourceFile && this.api.saveSourceFile) {
        const { resource } = await this.api.saveSourceFile(this.taskId, this.resourceId, this.revision);
        this.resource = resource;
        this.error = "";
      }
    });
  }
  run({ resetScene = false, timeoutSeconds = 120 } = {}) {
    return this.guarded(async (signal) => {
      const recoveringRun = this.pending?.body?.command === "blender_run_python";
      await this.saveParts(signal);
      if (recoveringRun) return;
      await this.perform(
        "command",
        { command: "blender_run_python", params: { resetScene, timeoutSeconds } },
        signal
      );
    });
  }
  cancel() {
    this.controller?.abort();
  }
  importFile(file) {
    return this.guarded(async (signal) => {
      if (!/\.blend$/i.test(file.name) || file.size < 1 || file.size > 64 * 1024 * 1024)
        throw new Error("请选择不超过 64 MiB 的 .blend 文件，并先在 Blender 中打包贴图和本地化链接对象");
      await this.saveParts(signal);
      await this.api.importNativeResource(this.taskId, this.resourceId, file, this.revision, id(), signal);
      this.accept(await this.api.readResource(this.taskId, this.resourceId));
      this.edits = {};
      this.updateDirty();
    });
  }
  async refresh() {
    if (this.busy || this.pending) return false;
    const epoch = this.epoch,
      revision = this.revision;
    try {
      const read = await this.api.readResource(this.taskId, this.resourceId);
      if (this.busy || this.pending || epoch !== this.epoch || revision !== this.revision) return false;
      if (this.error.startsWith("读取失败：")) this.error = "";
      if (this.dirty) {
        if (read.resource.revision !== this.revision) this.error = "工程已被更新，本地草稿已保留。";
      } else if (read.resource.revision >= this.revision) this.accept(read);
      this.changed();
      return true;
    } catch (error) {
      if (epoch === this.epoch && !this.busy) {
        this.error = `读取失败：${error.message}`;
        this.changed();
      }
      return false;
    }
  }
  reload() {
    return this.guarded(async () => {
      const read = await this.api.readResource(this.taskId, this.resourceId);
      this.accept(read);
      this.edits = {};
      this.pending = null;
      this.dirty = false;
      this.error = "";
      this.persist();
    });
  }
  undo() {
    return this.guarded(async (signal) => {
      await this.saveParts(signal);
      await this.api.undo(this.taskId, this.resourceId);
      this.accept(await this.api.readResource(this.taskId, this.resourceId));
      this.edits = {};
      this.updateDirty();
    });
  }
}

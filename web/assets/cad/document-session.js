import { CAD_APP, normalizeModel } from "./generated/model.js";
import { CAD_COMPUTE_LIMITS } from "./generated/program.js";
const copy = (value) => JSON.parse(JSON.stringify(value));
/** Revision-aware CAD drafts and idempotent retry, independent of DOM and geometry. */
export class CadDocumentSession {
  constructor({
    api,
    taskId,
    resourceId,
    storage = globalThis.sessionStorage,
    changed = () => {},
    normalize = normalizeModel,
    operationType = "cad.replace",
    payloadKey = "model"
  }) {
    Object.assign(this, { api, taskId, resourceId, storage, changed, normalize, operationType, payloadKey });
    this.key = `atria:cad:${resourceId}`;
    this.dirty = false;
    this.busy = false;
    this.error = "";
    this.refreshEpoch = 0;
    this.refreshPaused = false;
  }
  persist() {
    try {
      if (this.dirty || this.pending)
        this.storage?.setItem(
          this.key,
          JSON.stringify({ model: this.model, revision: this.revision, pending: this.pending })
        );
      else this.storage?.removeItem(this.key);
    } catch {
      this.error ||= "浏览器无法备份草稿，请保存后再离开";
    }
  }
  async load() {
    const read = await this.api.readResource(this.taskId, this.resourceId);
    this.accept(read);
    try {
      const draft = JSON.parse(this.storage?.getItem(this.key) || "null");
      if (
        draft?.model &&
        (Array.isArray(draft.model.parts) ||
          (this.operationType === "cad.program.replace" &&
            draft.model.version === 2 &&
            typeof draft.model.source === "string" &&
            new TextEncoder().encode(draft.model.source).byteLength <= CAD_COMPUTE_LIMITS.maxSourceBytes))
      ) {
        this.model = copy(draft.model);
        this.revision = draft.revision;
        this.pending = draft.pending;
        this.dirty = true;
        if (draft.revision !== read.resource.revision && !draft.pending)
          this.error = "版本冲突：已保留本地草稿，请下载备份或重新载入";
      }
    } catch {
      this.error = "草稿记录无法读取，已加载保存版本";
    }
    this.changed();
  }
  accept(read) {
    const model = this.normalize(read.snapshot.content);
    this.resource = read.resource;
    this.model = copy(model);
    this.revision = read.resource.revision;
    this.operations = read.operations ?? [];
    this.selection = read.selection;
  }
  edit(model) {
    if (this.busy || this.pending) throw new Error("请先重试当前保存，再继续编辑");
    this.model = copy(model);
    this.dirty = true;
    this.error = "";
    this.persist();
    this.changed();
  }
  captureDraft() {
    return { model: copy(this.model), dirty: this.dirty, error: this.error, revision: this.revision };
  }
  restoreDraft(draft) {
    if (this.busy || this.pending || draft.revision !== this.revision)
      throw new Error("保存状态已变化，无法取消当前操作");
    this.model = copy(draft.model);
    this.dirty = draft.dirty;
    this.error = draft.error;
    this.persist();
    this.changed();
  }
  pauseRefresh() {
    this.refreshPaused = true;
    this.refreshEpoch++;
  }
  resumeRefresh() {
    this.refreshPaused = false;
  }
  async save() {
    if (this.saving) return this.saving;
    this.saving = this.saveDocument().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  async saveDocument() {
    if ((this.dirty || this.pending) && !(await this.commit())) return false;
    if (!this.resource?.sourceFile || !this.api.saveSourceFile) return true;
    this.busy = true;
    this.changed();
    try {
      const { resource } = await this.api.saveSourceFile(this.taskId, this.resourceId, this.revision);
      this.resource = resource;
      this.error = "";
      return true;
    } catch (error) {
      this.error = error.message;
      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async commit() {
    try {
      const model = this.normalize(this.model);
      this.pending ??= {
        operationId: `cad_${crypto.randomUUID().replaceAll("-", "")}`,
        appType: CAD_APP,
        operationType: this.operationType,
        baseRevision: this.revision,
        payload: { [this.payloadKey]: model }
      };
      this.persist();
      this.busy = true;
      this.changed();
      await this.api.applyOperation(this.taskId, this.resource.resourceId, this.pending);
      // Re-read after a deduplicated retry: its original snapshot may predate a collaborator's edit.
      const read = await this.api.readResource(this.taskId, this.resource.resourceId);
      this.accept(read);
      this.pending = null;
      this.dirty = false;
      this.error = "";
      this.persist();
      return true;
    } catch (error) {
      this.error =
        error.code === "revision_conflict" ? "版本冲突：本地草稿已保留，请下载备份或重新载入" : error.message;
      // Validation failures are confirmed before any commit: allow correcting the draft.
      // Network failures retain the operation ID until a deduplicated retry resolves it.
      if (["revision_conflict", "invalid_operation"].includes(error.code)) this.pending = null;
      this.persist();
      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async refresh() {
    if (this.busy || this.pending || this.refreshPaused) return false;
    const revision = this.revision;
    const epoch = this.refreshEpoch;
    try {
      const read = await this.api.readResource(this.taskId, this.resource.resourceId);
      // A poll started before a save must never roll its successful result back.
      if (
        this.busy ||
        this.pending ||
        this.refreshPaused ||
        epoch !== this.refreshEpoch ||
        revision !== this.revision
      )
        return false;
      if (this.error.startsWith("读取失败：")) this.error = "";
      if (this.dirty) {
        if (read.resource.revision !== this.revision)
          this.error = "版本冲突：本地草稿已保留，请下载备份或重新载入";
      } else if (read.resource.revision >= this.revision) this.accept(read);
      this.changed();
      return true;
    } catch (error) {
      if (this.refreshPaused || epoch !== this.refreshEpoch) return false;
      this.error = `读取失败：${error.message}，当前模型已保留`;
      this.changed();
      return false;
    }
  }
  async reload() {
    if (this.busy) return;
    this.busy = true;
    this.changed();
    try {
      // Fetch before dropping the draft: a failed reload must not destroy it.
      const read = await this.api.readResource(this.taskId, this.resource.resourceId);
      this.accept(read);
      this.pending = null;
      this.dirty = false;
      this.error = "";
      this.persist();
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async undo() {
    if (!(await this.save())) return false;
    this.busy = true;
    this.changed();
    try {
      await this.api.undo(this.taskId, this.resource.resourceId);
      this.accept(await this.api.readResource(this.taskId, this.resource.resourceId));
      this.error = "";
      return true;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}

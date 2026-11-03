const copy = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Local drafts and versioned saves; network retries retain their operation ID. */
export class PresentationSession {
  constructor({ api, taskId, resourceId, storage = globalThis.localStorage, changed = () => {} }) {
    Object.assign(this, { api, taskId, resourceId, storage, changed });
    this.key = `atria:pptist:${resourceId}`;
    this.dirty = false;
    this.busy = false;
    this.error = "";
    this.epoch = 0;
    // Only authoritative replacements reset the editor's undo/redo history.
    // Acknowledging our own save may still normalize the document in place.
    this.viewVersion = 0;
  }
  persist() {
    try {
      if (this.dirty || this.pending)
        this.storage?.setItem(
          this.key,
          JSON.stringify({ document: this.document, revision: this.revision, pending: this.pending })
        );
      else this.storage?.removeItem(this.key);
    } catch {
      this.error ||= "本机草稿空间不足，请保存或下载备份后再离开";
    }
  }
  accept(read) {
    this.resource = read.resource;
    this.revision = read.resource.revision;
    this.document = copy(read.snapshot.content);
    this.saved = copy(this.document);
    this.operations = read.operations ?? [];
  }
  async load() {
    this.accept(await this.api.readResource(this.taskId, this.resourceId));
    try {
      const draft = JSON.parse(this.storage?.getItem(this.key) || "null");
      if (draft?.document?.version === 1 && Array.isArray(draft.document.slides)) {
        this.document = draft.document;
        this.pending = draft.pending;
        this.dirty = true;
        if (draft.revision !== this.revision && !this.pending)
          this.error = "版本冲突：本地草稿已保留，请下载备份或重新载入";
        this.revision = draft.revision;
      }
    } catch {
      this.error = "本机草稿无法读取，已加载保存版本";
    }
    this.viewVersion++;
    this.changed();
  }
  edit(document) {
    if (same(document, this.document)) return;
    this.epoch++;
    this.document = copy(document);
    this.dirty = !same(this.document, this.saved);
    this.persist();
    this.changed();
  }
  async save() {
    if (this.saving) return this.saving;
    if (!this.dirty && !this.pending) return true;
    this.saving = this.commit().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  async commit() {
    this.pending ??= {
      operationId: `pptist_${crypto.randomUUID().replaceAll("-", "")}`,
      appType: "pptist",
      operationType: "pptist.replace",
      baseRevision: this.revision,
      payload: { document: copy(this.document) }
    };
    const submitted = copy(this.pending.payload.document);
    this.busy = true;
    this.epoch++;
    this.persist();
    this.changed();
    try {
      const outcome = await this.api.applyOperation(this.taskId, this.resourceId, this.pending);
      const read = await this.api.readResource(this.taskId, this.resourceId);
      const newerDraft = !same(this.document, submitted),
        draft = this.document;
      this.accept(read);
      if (read.resource.revision !== outcome.resource.revision && !newerDraft) this.viewVersion++;
      this.pending = null;
      this.error = "";
      this.dirty = false;
      if (newerDraft) {
        this.document = draft;
        this.dirty = true;
        if (read.resource.revision !== outcome.resource.revision) {
          this.revision = outcome.resource.revision;
          this.error = "版本冲突：保存期间文档有其他修改，本地草稿已保留";
        }
      }
      return true;
    } catch (error) {
      this.error =
        error.code === "revision_conflict" ? "版本冲突：本地草稿已保留，请下载备份或重新载入" : error.message;
      if (
        [
          "revision_conflict",
          "invalid_operation",
          "resource_too_large",
          "operation_precondition_failed"
        ].includes(error.code)
      )
        this.pending = null;
      return false;
    } finally {
      this.busy = false;
      this.epoch++;
      this.persist();
      this.changed();
    }
  }
  async refresh() {
    if (this.busy || this.pending) return false;
    const epoch = this.epoch;
    try {
      const read = await this.api.readResource(this.taskId, this.resourceId);
      if (epoch !== this.epoch || this.busy || this.pending) return false;
      if (this.error.startsWith("读取失败：")) this.error = "";
      if (this.dirty) {
        if (read.resource.revision !== this.revision)
          this.error = "版本冲突：本地草稿已保留，请下载备份或重新载入";
      } else if (read.resource.revision >= this.revision) {
        if (!same(read.snapshot.content, this.document)) this.viewVersion++;
        this.accept(read);
      }
      this.changed();
      return true;
    } catch (e) {
      if (epoch === this.epoch) {
        this.error = `读取失败：${e.message}`;
        this.changed();
      }
      return false;
    }
  }
  async reload() {
    if (this.busy) return;
    this.busy = true;
    this.epoch++;
    this.changed();
    try {
      this.accept(await this.api.readResource(this.taskId, this.resourceId));
      this.viewVersion++;
      this.pending = null;
      this.dirty = false;
      this.error = "";
      this.persist();
    } finally {
      this.busy = false;
      this.epoch++;
      this.changed();
    }
  }
}

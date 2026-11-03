import { minimalReplace, operationId, shouldKeepDraft } from "./text-edit.js";

/**
 * @typedef {import('../../../../src/applications/types.js').WorkspaceResource} Resource
 * @typedef {import('../../../../src/applications/types.js').AppOperationEvent} Operation
 * @typedef {{resource: Resource, snapshot?: {content?: unknown}, operations?: Operation[]}} ReadResult
 * @typedef {{resource: Resource, snapshot?: {content?: unknown}, event: Operation}} WriteResult
 * @typedef {{operationId: string, appType: string, operationType: string, baseRevision: number, appInstanceId?: string, payload: {from: number, to: number, text: string}}} EditRequest
 * @typedef {{loaded: boolean, serverContent: string, serverRevision: number, draftContent: string,
 *   resource: Partial<Resource>, operations: Operation[], saving: boolean, undoing: boolean,
 *   conflict: {message: string} | null, error: string | null}} DocumentState
 * @typedef {{read: () => Promise<ReadResult>, write: (operation: EditRequest) => Promise<WriteResult>, undo: () => Promise<WriteResult>, saveSource?: (revision: number) => Promise<{resource: Resource}>}} DocumentTransport
 */

const remoteConflictMessage = "CoworkOS 或另一处改动已经更新了这份文档，你的草稿没有被覆盖。";

/**
 * Owns document synchronization without DOM, timers or global application state.
 * Only this session advances the server baseline. The view reads snapshots and
 * sends intents, so a different editor surface can keep the same save contract.
 */
export class TextDocumentSession {
  /** @type {DocumentState} */
  #state = {
    loaded: false,
    serverContent: "",
    serverRevision: 0,
    draftContent: "",
    resource: {},
    operations: [],
    saving: false,
    undoing: false,
    conflict: null,
    error: null
  };
  /** @type {Promise<boolean> | undefined} */
  #pendingSave;
  /** @type {{operation: EditRequest, content: string} | undefined} */
  #inFlight;
  /** @type {{operation: EditRequest, content: string} | undefined} */
  #unconfirmedWrite;
  #disposed = false;

  /**
   * @param {{transport: DocumentTransport, appInstanceId?: string,
   *   onChange?: (next: Readonly<DocumentState>, previous: Readonly<DocumentState>) => void,
   *   onCommitted?: () => void}} options
   */
  constructor({ transport, appInstanceId, onChange, onCommitted }) {
    this.transport = transport;
    this.appInstanceId = appInstanceId;
    this.onChange = onChange;
    this.onCommitted = onCommitted;
  }

  /** @returns {Readonly<DocumentState>} */
  get state() {
    return this.#state;
  }
  get dirty() {
    return this.#state.draftContent !== this.#state.serverContent;
  }
  get phase() {
    const state = this.#state;
    return state.conflict
      ? "conflict"
      : state.error
        ? "error"
        : !state.loaded
          ? "loading"
          : state.undoing
            ? "undoing"
            : state.saving
              ? "saving"
              : this.dirty
                ? "dirty"
                : "clean";
  }

  /** @param {string} content */
  edit(content) {
    if (!this.#disposed) this.#update({ draftContent: content, error: null });
  }

  /** @param {{discardDraft?: boolean}} [options] */
  async load({ discardDraft = false } = {}) {
    const read = await this.transport.read();
    const previous = this.#state;
    if (this.#disposed || (previous.loaded && read.resource.revision < previous.serverRevision)) return;
    const keep = shouldKeepDraft({ ...previous, discardDraft });
    const content = typeof read.snapshot?.content === "string" ? read.snapshot.content : "";
    const ownWrite = this.#inFlight ?? this.#unconfirmedWrite;
    const ownEdit =
      ownWrite &&
      read.resource.revision === ownWrite.operation.baseRevision + 1 &&
      content === ownWrite.content;
    if (discardDraft) this.#unconfirmedWrite = undefined;
    this.#update({
      loaded: true,
      resource: read.resource,
      operations: read.operations ?? [],
      serverContent: content,
      serverRevision: read.resource.revision,
      error: null,
      ...(!keep
        ? { draftContent: content, conflict: null }
        : read.resource.revision !== previous.serverRevision && !ownEdit
          ? { conflict: { message: remoteConflictMessage } }
          : {})
    });
    this.onCommitted?.();
  }

  /** All callers await one drain, including typing that arrives during a write. */
  save() {
    if (this.#pendingSave) return this.#pendingSave;
    this.#pendingSave = this.#drain().finally(() => {
      this.#pendingSave = undefined;
    });
    return this.#pendingSave;
  }

  /** @returns {Promise<boolean>} */
  async #drain() {
    while (this.dirty || this.#unconfirmedWrite) {
      const operation = this.pendingOperation();
      if (!operation) return false;
      const sending = this.#unconfirmedWrite?.content ?? this.#state.draftContent;
      this.#inFlight = { operation, content: sending };
      this.#update({ saving: true, error: null });
      try {
        const result = await this.transport.write(operation);
        if (this.#disposed) return false;
        this.#unconfirmedWrite = undefined;
        // A newer event/read can land before this response. Never roll back its revision.
        if (result.resource.revision >= this.#state.serverRevision) {
          this.#acceptWrite(result, sending);
        }
        this.onCommitted?.();
      } catch (error) {
        if (this.#disposed) return false;
        const failure = /** @type {Error & {code?: string}} */ (error);
        if (failure.code === "source_file_write_failed")
          this.#unconfirmedWrite = { operation, content: sending };
        if (["revision_conflict", "operation_precondition_failed"].includes(failure.code ?? "")) {
          this.#unconfirmedWrite = undefined;
          try {
            await this.load();
          } catch {
            /* retain the draft even if the refresh also fails */
          }
          this.#update({ conflict: { message: remoteConflictMessage } });
        } else this.#update({ error: `保存失败：${failure.message}` });
        return false;
      } finally {
        this.#inFlight = undefined;
        this.#update({ saving: false });
      }
      if (this.#state.conflict) return false;
    }
    if (
      !this.#disposed &&
      !this.#state.conflict &&
      this.#state.resource.sourceFile &&
      this.transport.saveSource
    ) {
      this.#update({ saving: true, error: null });
      try {
        const { resource } = await this.transport.saveSource(this.#state.serverRevision);
        if (this.#disposed) return false;
        this.#update({ resource, error: null });
      } catch (error) {
        this.#update({ error: `保存原文件失败：${/** @type {Error} */ (error).message}` });
        return false;
      } finally {
        this.#update({ saving: false });
      }
      if (this.dirty) return this.#drain();
    }
    return !this.#disposed && !this.#state.conflict;
  }

  async undo() {
    if (this.#state.undoing || this.#state.conflict) return;
    if (this.#pendingSave) await this.#pendingSave;
    if (this.#disposed || this.#state.conflict || this.#state.undoing) return;
    this.#update({ undoing: true, error: null });
    try {
      const result = await this.transport.undo();
      if (this.#disposed || result.resource.revision < this.#state.serverRevision) return;
      const keep = this.dirty;
      this.#acceptWrite(result, this.#state.serverContent);
      this.#update(
        keep
          ? { conflict: { message: "已撤销保存的修改；你的未保存草稿已保留，请选择如何合并。" } }
          : { draftContent: this.#state.serverContent }
      );
      this.onCommitted?.();
    } catch (error) {
      this.#update({ error: `撤销失败：${/** @type {Error} */ (error).message}` });
    } finally {
      this.#update({ undoing: false });
    }
  }

  async merge() {
    // A rejected in-flight write may still be refreshing the latest baseline.
    // Let it finish before clearing its conflict for the user's explicit merge.
    if (this.#pendingSave) await this.#pendingSave;
    this.#update({ conflict: null, error: null });
    return this.save();
  }

  /** Rename changes metadata, not the revision or the draft. @param {Resource} resource */
  rename(resource) {
    this.#update({ resource });
  }

  /** The same request can be reused for an unload beacon without duplicating history. */
  pendingOperation() {
    const state = this.#state;
    if (
      this.#disposed ||
      !state.loaded ||
      state.conflict ||
      state.undoing ||
      (!this.dirty && !this.#unconfirmedWrite)
    )
      return null;
    if (this.#inFlight) return this.#inFlight.operation;
    if (this.#unconfirmedWrite) return this.#unconfirmedWrite.operation;
    const patch = minimalReplace(state.serverContent, state.draftContent);
    if (!patch) return null;
    return {
      operationId: operationId(),
      appType: "text-editor",
      operationType: "text.replace",
      baseRevision: state.serverRevision,
      appInstanceId: this.appInstanceId,
      payload: patch
    };
  }

  dispose() {
    this.#disposed = true;
  }

  /** @param {WriteResult} result @param {string} fallback */
  #acceptWrite(result, fallback) {
    const operations = this.#state.operations.filter((event) => event.eventId !== result.event.eventId);
    this.#update({
      serverContent: typeof result.snapshot?.content === "string" ? result.snapshot.content : fallback,
      serverRevision: result.resource.revision,
      resource: result.resource,
      operations: [...operations, result.event].slice(-100),
      error: null
    });
  }

  /** @param {Partial<DocumentState>} patch */
  #update(patch) {
    if (this.#disposed) return;
    const previous = this.#state;
    this.#state = { ...previous, ...patch };
    this.onChange?.(this.#state, previous);
  }
}

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  contextInputSchema,
  appendContextChange,
  contextSettingsSchema,
  contextValidity,
  PersonalContextError,
  type ContextBasis,
  type ContextDocument,
  type ContextInput,
  type ContextRecord
} from "../domain/personal-context.js";
import { PersonalContextStore } from "./personal-context-store.js";

const hostRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1).max(500),
    taskId: z.string().min(1).max(500),
    runId: z.string().min(1).max(500),
    messageId: z.string().min(1).max(500),
    operationId: z.string().min(1).max(500),
    receivedAt: z.string().datetime({ offset: true }),
    text: z.string().max(6000),
    purpose: z.string().trim().min(1).max(200),
    permissions: z.array(z.enum(["read", "save", "update", "delete", "settings"])).max(5),
    visibility: z.array(z.enum(["task", "project", "user"])).max(3),
    projectDirectory: z.string().min(1).max(500).optional(),
    sensitiveConsent: z.boolean().default(false),
    consentUntil: z.string().datetime({ offset: true }).optional()
  })
  .strict();
export type ContextHostRequest = z.input<typeof hostRequestSchema>;
type Host = z.infer<typeof hostRequestSchema>;
export interface ContextAssessment {
  statement: "self_report" | "uncertain" | "hypothetical" | "third_party";
  sensitive: boolean;
  authorized: boolean;
}
const assessmentSchema = z
  .object({
    statement: z.enum(["self_report", "uncertain", "hypothetical", "third_party"]),
    sensitive: z.boolean(),
    authorized: z.boolean()
  })
  .strict();
interface ContextServiceOptions {
  /** Must use trusted user-message evidence, never model-supplied authorization flags. */
  assess: (input: Readonly<ContextInput>, host: Readonly<ContextHostRequest>) => Promise<ContextAssessment>;
  now?: () => number;
  /** Live host pause/authorization check; absence disables execution permits. */
  canExecute?: (host: Readonly<ContextHostRequest>) => Promise<boolean>;
}
export interface ContextExecutionPermit {
  readonly id: string;
}
interface PermitState extends ContextBasis {
  snapshotRevision: number;
  refs: { id: string; revision: number }[];
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requireBasis(doc: ContextDocument, basis: ContextBasis): void {
  if (doc.epoch !== basis.epoch || doc.generation !== basis.generation)
    throw new PersonalContextError("conflict");
}

/** Internal host API, not a model-facing tool or a natural-language authorization classifier. */
export class PersonalContextService {
  constructor(
    readonly store: PersonalContextStore,
    private readonly options: ContextServiceOptions
  ) {}

  async openRequest(input: ContextHostRequest): Promise<PersonalContextRequest> {
    const host = hostRequestSchema.parse(structuredClone(input));
    host.workspaceRoot = resolve(host.workspaceRoot);
    if (host.projectDirectory) host.projectDirectory = resolve(host.projectDirectory);
    const basis = await this.store.transaction((doc) => {
      const key = hash([host.workspaceRoot, host.taskId, host.messageId]);
      let stamp = doc.requests.find((request) => request.key === key);
      if (!stamp) {
        stamp = { key, generation: doc.generation };
        doc.requests.push(stamp);
      }
      return { epoch: doc.epoch, generation: stamp.generation };
    });
    return new PersonalContextRequest(this.store, host, basis, this.options);
  }

  /** Reference-only outbox. No scheduling, goal creation or Inbox delivery occurs here. */
  async pendingChanges(): Promise<ContextDocument["events"]> {
    const doc = await this.store.read();
    return doc.settings.enabled ? doc.events : [];
  }

  async acknowledgeChange(eventId: string, basis: ContextBasis): Promise<boolean> {
    z.string().uuid().parse(eventId);
    return this.store.transaction((doc) => {
      requireBasis(doc, basis);
      const before = doc.events.length;
      doc.events = doc.events.filter((event) => event.eventId !== eventId);
      return doc.events.length !== before;
    });
  }
}

export class PersonalContextRequest {
  private readonly permits = new WeakMap<ContextExecutionPermit, PermitState>();
  constructor(
    private readonly store: PersonalContextStore,
    private readonly host: Host,
    private readonly basis: ContextBasis,
    private readonly options: ContextServiceOptions
  ) {}

  private now(): number {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isFinite(value)) throw new PersonalContextError("permission_denied");
    return value;
  }
  private requirePermission(action: Host["permissions"][number]): void {
    if (
      !this.host.permissions.includes(action) ||
      (this.host.consentUntil && Date.parse(this.host.consentUntil) <= this.now())
    )
      throw new PersonalContextError("permission_denied");
  }
  private inScope(record: ContextRecord): boolean {
    if (!this.host.visibility.includes(record.visibility)) return false;
    const scope = record.scope;
    return (
      scope.visibility === "user" ||
      (scope.visibility === "project" && scope.projectDirectory === this.host.projectDirectory) ||
      (scope.visibility === "task" &&
        scope.workspaceRoot === this.host.workspaceRoot &&
        scope.taskId === this.host.taskId)
    );
  }
  private readable(doc: ContextDocument, record: ContextRecord): boolean {
    return (
      this.inScope(record) &&
      record.purpose === this.host.purpose &&
      (!record.consentUntil || Date.parse(record.consentUntil) > this.now()) &&
      (!record.sensitive || doc.settings.sensitiveEnabled || this.host.sensitiveConsent)
    );
  }
  private find(doc: ContextDocument, id: string): ContextRecord {
    const record = doc.records.find((item) => item.id === id);
    if (!record) throw new PersonalContextError("not_found");
    if (!this.readable(doc, record)) throw new PersonalContextError("permission_denied");
    return record;
  }
  private scope(input: ContextInput): ContextRecord["scope"] {
    if (!this.host.visibility.includes(input.visibility)) throw new PersonalContextError("permission_denied");
    if (input.visibility === "project") {
      if (!this.host.projectDirectory) throw new PersonalContextError("permission_denied");
      return { visibility: "project", projectDirectory: this.host.projectDirectory };
    }
    return input.visibility === "user"
      ? { visibility: "user" }
      : { visibility: "task", workspaceRoot: this.host.workspaceRoot, taskId: this.host.taskId };
  }
  private async assess(input: ContextInput): Promise<ContextAssessment> {
    if (!this.host.text.includes(input.quote)) throw new PersonalContextError("source_rejected");
    const assessment = assessmentSchema.parse(
      await this.options.assess(structuredClone(input), structuredClone(this.host))
    );
    if (["hypothetical", "third_party"].includes(assessment.statement))
      throw new PersonalContextError("source_rejected");
    if (!assessment.authorized) throw new PersonalContextError("permission_denied");
    return assessment;
  }
  private key(): string {
    return hash([this.host.workspaceRoot, this.host.taskId, this.host.messageId, this.host.operationId]);
  }
  private replay(doc: ContextDocument, digest: string): { id: string; revision: number } | undefined {
    const old = doc.receipts.find((item) => item.key === this.key());
    if (!old) return undefined;
    if (old.digest !== digest || old.generation !== doc.generation)
      throw new PersonalContextError("conflict");
    return { id: old.id, revision: old.revision };
  }
  private event(
    doc: ContextDocument,
    record: { id: string; revision: number },
    reason: "created" | "updated" | "deleted"
  ): void {
    appendContextChange(doc, {
      eventId: randomUUID(),
      contextId: record.id,
      revision: record.revision,
      reason,
      createdAt: new Date(this.now()).toISOString(),
      epoch: doc.epoch,
      generation: doc.generation
    });
  }
  private receipt(doc: ContextDocument, digest: string, result: { id: string; revision: number }): void {
    doc.receipts.push({ key: this.key(), digest, ...result, generation: doc.generation });
  }

  async save(raw: ContextInput): Promise<{ id: string; revision: number }> {
    return this.write(undefined, undefined, raw);
  }
  async update(
    id: string,
    expectedRevision: number,
    raw: ContextInput
  ): Promise<{ id: string; revision: number }> {
    z.string().uuid().parse(id);
    z.number().int().positive().parse(expectedRevision);
    return this.write(id, expectedRevision, raw);
  }
  private async write(
    id: string | undefined,
    expectedRevision: number | undefined,
    raw: ContextInput
  ): Promise<{ id: string; revision: number }> {
    const action = id ? "update" : "save";
    this.requirePermission(action);
    const input = contextInputSchema.parse(raw);
    const scope = this.scope(input);
    const assessment = await this.assess(input);
    const digest = hash([action, id, expectedRevision, input]);
    return this.store.transaction((doc) => {
      requireBasis(doc, this.basis);
      this.requirePermission(action);
      if (assessment.sensitive && !doc.settings.sensitiveEnabled && !this.host.sensitiveConsent)
        throw new PersonalContextError("permission_denied");
      const replay = this.replay(doc, digest);
      if (replay) return replay;
      const previous = id ? this.find(doc, id) : undefined;
      if (previous && previous.revision !== expectedRevision) throw new PersonalContextError("conflict");
      if (
        previous &&
        (previous.kind !== input.kind || JSON.stringify(previous.scope) !== JSON.stringify(scope))
      )
        throw new PersonalContextError("permission_denied");
      const at = new Date(this.now()).toISOString();
      const record: ContextRecord = {
        ...input,
        id: id ?? randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        scope,
        sensitive: assessment.sensitive,
        evidenceStatus: assessment.statement === "uncertain" ? "uncertain" : "reported",
        purpose: this.host.purpose,
        consentUntil: this.host.consentUntil,
        source: {
          workspaceRoot: this.host.workspaceRoot,
          taskId: this.host.taskId,
          runId: this.host.runId,
          messageId: this.host.messageId,
          receivedAt: this.host.receivedAt
        },
        createdAt: previous?.createdAt ?? at,
        updatedAt: at
      };
      if (previous) doc.records[doc.records.indexOf(previous)] = record;
      else doc.records.push(record);
      doc.snapshotRevision++;
      this.event(doc, record, previous ? "updated" : "created");
      const result = { id: record.id, revision: record.revision };
      this.receipt(doc, digest, result);
      return result;
    });
  }

  async query(ids: string[]): Promise<{
    records: { record: ContextRecord; validity: ReturnType<typeof contextValidity> }[];
    enabled: boolean;
  }> {
    this.requirePermission("read");
    const selected = z.array(z.string().uuid()).max(20).parse(ids);
    const doc = await this.store.read();
    if (!doc.settings.enabled) return { enabled: false, records: [] };
    requireBasis(doc, this.basis);
    const records = selected.flatMap((id) => {
      const record = doc.records.find((item) => item.id === id);
      return record && this.readable(doc, record)
        ? [{ record, validity: contextValidity(record, this.now()) }]
        : [];
    });
    return { enabled: true, records };
  }

  async configure(patch: Partial<ContextDocument["settings"]>): Promise<void> {
    this.requirePermission("settings");
    const changes = contextSettingsSchema.partial().parse(patch);
    await this.store.transaction((doc) => {
      requireBasis(doc, this.basis);
      this.requirePermission("settings");
      doc.settings = { ...doc.settings, ...changes };
      doc.generation++;
      doc.snapshotRevision++;
      // Events contain references only. A future dispatcher must recheck current settings.
      for (const event of doc.events) event.generation = doc.generation;
    });
  }

  async forget(id: string, expectedRevision: number): Promise<void> {
    this.requirePermission("delete");
    z.string().uuid().parse(id);
    z.number().int().positive().parse(expectedRevision);
    await this.store.transaction((doc) => {
      requireBasis(doc, this.basis);
      this.requirePermission("delete");
      const record = doc.records.find((item) => item.id === id);
      if (!record) throw new PersonalContextError("not_found");
      if (!this.inScope(record)) throw new PersonalContextError("permission_denied");
      if (record.revision !== expectedRevision) throw new PersonalContextError("conflict");
      doc.records = doc.records.filter((item) => item.id !== id);
      doc.events = doc.events.filter((item) => item.contextId !== id);
      doc.generation++;
      doc.snapshotRevision++;
      for (const event of doc.events) event.generation = doc.generation;
      // A global generation barrier makes prior receipts unusable without retaining old content hashes.
      doc.receipts = [];
      this.event(doc, { id, revision: expectedRevision + 1 }, "deleted");
    });
  }

  private async requireExecution(): Promise<void> {
    this.requirePermission("read");
    if (!this.options.canExecute || !(await this.options.canExecute(structuredClone(this.host))))
      throw new PersonalContextError("permission_denied");
  }
  async prepareExecution(ids: string[]): Promise<ContextExecutionPermit> {
    await this.requireExecution();
    const selected = z.array(z.string().uuid()).min(1).max(20).parse(ids);
    const doc = await this.store.read();
    requireBasis(doc, this.basis);
    if (!doc.settings.enabled) throw new PersonalContextError("permission_denied");
    const refs = selected.map((id) => {
      const record = this.find(doc, id);
      if (contextValidity(record, this.now()) !== "current") throw new PersonalContextError("inactive");
      return { id, revision: record.revision };
    });
    const permit = Object.freeze({ id: randomUUID() });
    this.permits.set(permit, {
      epoch: doc.epoch,
      generation: doc.generation,
      snapshotRevision: doc.snapshotRevision,
      refs
    });
    return permit;
  }
  async validateExecution(permit: ContextExecutionPermit): Promise<void> {
    await this.requireExecution();
    const state = this.permits.get(permit);
    if (!state) throw new PersonalContextError("permission_denied");
    const doc = await this.store.read();
    requireBasis(doc, state);
    if (!doc.settings.enabled || state.snapshotRevision !== doc.snapshotRevision)
      throw new PersonalContextError("conflict");
    for (const ref of state.refs) {
      const record = this.find(doc, ref.id);
      if (record.revision !== ref.revision) throw new PersonalContextError("conflict");
      if (contextValidity(record, this.now()) !== "current") throw new PersonalContextError("inactive");
    }
  }
}

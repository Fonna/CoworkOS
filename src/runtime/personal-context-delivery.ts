import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  contextValidity,
  PersonalContextError,
  type ContextBasis,
  type ContextDocument,
  type ContextRecord
} from "../domain/personal-context.js";
import type { InboxMessage } from "../domain/types.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { PersonalContextStore } from "./personal-context-store.js";
import { InboxStore } from "./scheduler.js";
import { monitoringPrograms } from "./monitoring-control.js";
import { routeGoalMessage } from "./goal-routing.js";

const segment = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\\/]/.test(value) && ![".", ".."].includes(value));
const hostSchema = z.object({ workspaceRoot: z.string().min(1), taskId: segment, runId: segment });
type Host = z.infer<typeof hostSchema>;
type Link = ContextDocument["links"][number];
const noticeSchema = z
  .object({
    type: z.literal("personal_context.changed"),
    linkId: z.string().uuid(),
    contextId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    epoch: z.string().uuid(),
    generation: z.number().int().nonnegative(),
    reason: z.enum(["created", "updated", "deleted"]),
    programId: z.string().optional()
  })
  .strict();

function belongs(link: Link, host: Host): boolean {
  return (
    link.workspaceRoot === resolve(host.workspaceRoot) &&
    link.taskId === host.taskId &&
    link.runId === host.runId
  );
}
function visible(
  doc: ContextDocument,
  record: ContextRecord,
  host: Host,
  projectDirectory?: string
): boolean {
  const scope = record.scope;
  return (
    doc.settings.enabled &&
    record.purpose === "personal_planning" &&
    (!record.sensitive || doc.settings.sensitiveEnabled) &&
    (!record.consentUntil || Date.parse(record.consentUntil) > Date.now()) &&
    (scope.visibility === "user" ||
      (scope.visibility === "task" &&
        scope.workspaceRoot === resolve(host.workspaceRoot) &&
        scope.taskId === host.taskId) ||
      (scope.visibility === "project" &&
        !!projectDirectory &&
        scope.projectDirectory === resolve(projectDirectory)))
  );
}
function publicFact(record: ContextRecord) {
  const { source: _source, quote: _quote, scope: _scope, consentUntil: _consent, ...fact } = record;
  return { ...fact, validity: contextValidity(record, Date.now()) };
}

/** Explicit read dependencies, reference-only outbox fanout and scoped recovery. No new scheduler. */
export class PersonalContextDelivery {
  constructor(
    readonly store = new PersonalContextStore(),
    private readonly hooks: { afterEnqueue?: () => void | Promise<void> } = {}
  ) {}

  private async owner(raw: Host) {
    const host = hostSchema.parse(raw);
    host.workspaceRoot = resolve(host.workspaceRoot);
    const task = await new LocalWorkspaceStore(host.workspaceRoot).readTask(host.taskId);
    if (["completed", "cancelled", "failed"].includes(task.status) || task.archived)
      throw new PersonalContextError("inactive");
    if (task.activeRunId !== host.runId) throw new PersonalContextError("conflict");
    return { host, task };
  }

  async follow(
    raw: Host,
    id: string,
    revision: number,
    programId?: string,
    basis?: ContextBasis
  ): Promise<{ linked: string }> {
    z.string().uuid().parse(id);
    z.number().int().positive().parse(revision);
    const { host, task } = await this.owner(raw);
    const programs = await monitoringPrograms(host.workspaceRoot, host.taskId);
    if (
      (programId && !programs.some((p) => p.programId === programId && p.status !== "completed")) ||
      (!programId && programs.some((p) => p.goal))
    )
      throw new PersonalContextError("permission_denied");
    await this.store.transaction((doc) => {
      if (basis && (basis.epoch !== doc.epoch || basis.generation !== doc.generation))
        throw new PersonalContextError("conflict");
      const record = doc.records.find((r) => r.id === id);
      if (!record) throw new PersonalContextError("not_found");
      if (record.revision !== revision) throw new PersonalContextError("conflict");
      if (!visible(doc, record, host, task.projectDirectory))
        throw new PersonalContextError("permission_denied");
      const previous = doc.links.find(
        (l) => belongs(l, host) && l.contextId === id && l.programId === programId
      );
      const link = {
        linkId: previous?.linkId ?? randomUUID(),
        contextId: id,
        revision,
        ...host,
        programId,
        projectDirectory: task.projectDirectory,
        epoch: doc.epoch,
        generation: doc.generation
      };
      if (previous) Object.assign(previous, link);
      else doc.links.push(link);
    });
    return { linked: id };
  }

  async unfollow(raw: Host, id: string): Promise<{ unlinked: string }> {
    const { host } = await this.owner(raw);
    z.string().uuid().parse(id);
    await this.store.transaction((doc) => {
      const removed = new Set(
        doc.links.filter((l) => belongs(l, host) && l.contextId === id).map((l) => l.linkId)
      );
      doc.links = doc.links.filter((l) => !removed.has(l.linkId));
      for (const event of doc.events) event.targets = event.targets.filter((target) => !removed.has(target));
    });
    return { unlinked: id };
  }

  /** Restored work may read only its previously registered references; it gets no write authorization. */
  async current(raw: Host) {
    let doc = await this.store.readExisting();
    if (!doc || !doc.settings.enabled) return [];
    if (!doc.links.some((l) => belongs(l, raw))) return [];
    const { host, task } = await this.owner(raw);
    const programs = await monitoringPrograms(host.workspaceRoot, host.taskId);
    doc = await this.store.readExisting();
    if (!doc || !doc.settings.enabled) return [];
    const current = doc;
    return current.links
      .filter((l) => belongs(l, host) && l.epoch === current.epoch && l.generation === current.generation)
      .filter(
        (l) =>
          routeGoalMessage(
            programs,
            task.monitoring?.scope === "background",
            this.notice(current, l, 0, l.contextId)
          ) === "deliver"
      )
      .flatMap((link) => {
        const record = current.records.find((r) => r.id === link.contextId);
        return record && visible(current, record, host, task.projectDirectory) ? [publicFact(record)] : [];
      });
  }

  private notice(
    doc: ContextDocument,
    link: Link,
    revision: number,
    eventId: string,
    reason: "created" | "updated" | "deleted" = "updated"
  ): InboxMessage {
    const messageId = `personal-context:${eventId}:${link.linkId}`;
    return {
      messageId,
      eventId,
      recipientAgentId: "main",
      kind: "external_event",
      state: "ready",
      priority: 5,
      createdAt: new Date().toISOString(),
      payload: {
        type: "personal_context.changed",
        linkId: link.linkId,
        contextId: link.contextId,
        revision,
        reason,
        epoch: doc.epoch,
        generation: doc.generation,
        ...(link.programId ? { programId: link.programId } : {})
      }
    };
  }

  /** Called from the existing cheap poll cycle. A durable Inbox enqueue is the outbox acknowledgement boundary. */
  async runTask(raw: Host): Promise<void> {
    const doc = await this.store.readExisting();
    if (!doc || !doc.settings.enabled) return;
    const unaddressed = new Set(doc.events.filter((e) => !e.targets.length).map((e) => e.eventId));
    if (unaddressed.size)
      await this.store.transaction((current) => {
        current.events = current.events.filter((e) => !unaddressed.has(e.eventId) || e.targets.length > 0);
      });
    if (!doc.links.some((l) => belongs(l, raw))) return;
    const { host, task } = await this.owner(raw);
    const programs = await monitoringPrograms(host.workspaceRoot, host.taskId);
    for (const event of doc.events) {
      for (const linkId of event.targets) {
        const link = doc.links.find((l) => l.linkId === linkId);
        if (!link || !belongs(link, host)) continue;
        const message = this.notice(doc, link, event.revision, event.eventId, event.reason);
        const route = routeGoalMessage(programs, task.monitoring?.scope === "background", message);
        if (route === "hold") continue;
        const latest = await this.store.read();
        const exists = latest.events.some((e) => e.eventId === event.eventId && e.targets.includes(linkId));
        if (!exists) continue;
        if (route === "deliver" && (await this.accepts(host, message.payload))) {
          await new InboxStore(
            join(host.workspaceRoot, host.taskId, "runs", host.runId, "agents/main/inbox-store.json")
          ).enqueue(message);
          await this.hooks.afterEnqueue?.();
        }
        await this.store.transaction((current) => {
          const pending = current.events.find((e) => e.eventId === event.eventId);
          if (pending) pending.targets = pending.targets.filter((id) => id !== linkId);
        });
      }
    }
    // Unaddressed legacy events never trigger work. Do not remove events added after this read.
    const inspected = new Set(doc.events.map((e) => e.eventId));
    await this.store.transaction((current) => {
      current.events = current.events.filter((e) => !inspected.has(e.eventId) || e.targets.length > 0);
    });
  }

  /** Recheck after dequeue too: a queued event cannot revive a deleted/disabled/old-Run dependency. */
  async accepts(raw: Host, payload: unknown): Promise<boolean> {
    const parsed = noticeSchema.safeParse(payload);
    if (!parsed.success) return false;
    const doc = await this.store.readExisting();
    const notice = parsed.data;
    if (!doc || !doc.settings.enabled || doc.epoch !== notice.epoch || doc.generation !== notice.generation)
      return false;
    const link = doc.links.find(
      (l) => l.linkId === notice.linkId && l.contextId === notice.contextId && belongs(l, raw)
    );
    if (!link || link.epoch !== doc.epoch || link.programId !== notice.programId) return false;
    try {
      const { host, task } = await this.owner(raw);
      const record = doc.records.find((r) => r.id === notice.contextId);
      if (notice.reason === "deleted") return !record && link.generation === doc.generation - 1;
      return (
        link.generation === doc.generation &&
        !!record &&
        record.revision === notice.revision &&
        visible(doc, record, host, task.projectDirectory)
      );
    } catch (error) {
      if (error instanceof PersonalContextError && ["conflict", "inactive"].includes(error.code))
        return false;
      throw error;
    }
  }
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  contextBasisSchema,
  contextSettingsSchema,
  contextValidity,
  PersonalContextError
} from "../domain/personal-context.js";
import { PersonalContextStore } from "./personal-context-store.js";

export const contextManagementChangeSchema = z
  .object({
    basis: contextBasisSchema,
    snapshotRevision: z.number().int().nonnegative(),
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("settings"), settings: contextSettingsSchema.partial() }).strict(),
      z
        .object({
          action: z.enum(["cancel", "end", "forget"]),
          id: z.string().uuid(),
          revision: z.number().int().positive()
        })
        .strict()
    ])
  })
  .strict();
/** Explicit local-user management surface; never register this capability with a model. */
export class PersonalContextManagement {
  constructor(readonly store = new PersonalContextStore()) {}
  async overview() {
    const doc = await this.store.read();
    return {
      basis: { epoch: doc.epoch, generation: doc.generation },
      snapshotRevision: doc.snapshotRevision,
      settings: doc.settings,
      records: doc.records.map((record) => ({
        id: record.id,
        revision: record.revision,
        kind: record.kind,
        status: record.status,
        title: record.title,
        content: record.content,
        visibility: record.visibility,
        sensitive: record.sensitive,
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        timeZone: record.timeZone,
        validUntil: record.validUntil,
        reviewAt: record.reviewAt,
        validity: contextValidity(record, Date.now())
      }))
    };
  }
  async change(raw: unknown): Promise<void> {
    const input = contextManagementChangeSchema.parse(raw);
    await this.store.transaction((doc) => {
      if (
        doc.epoch !== input.basis.epoch ||
        doc.generation !== input.basis.generation ||
        doc.snapshotRevision !== input.snapshotRevision
      )
        throw new PersonalContextError("conflict");
      const change = input.change;
      if (change.action === "settings") {
        doc.settings = { ...doc.settings, ...change.settings };
        doc.generation++;
      } else {
        const record = doc.records.find((record) => record.id === change.id);
        if (!record) throw new PersonalContextError("not_found");
        if (record.revision !== change.revision) throw new PersonalContextError("conflict");
        if (change.action === "forget") {
          doc.records = doc.records.filter((item) => item.id !== record.id);
          doc.events = doc.events.filter((event) => event.contextId !== record.id);
          doc.generation++;
          doc.receipts = [];
        } else {
          if (
            (change.action === "cancel" && record.kind !== "arrangement") ||
            ["ended", "cancelled"].includes(record.status)
          )
            throw new PersonalContextError("inactive");
          record.status = change.action === "cancel" ? "cancelled" : "ended";
          record.revision++;
          record.updatedAt = new Date().toISOString();
        }
        doc.events.push({
          eventId: randomUUID(),
          contextId: record.id,
          revision: change.action === "forget" ? record.revision + 1 : record.revision,
          reason: change.action === "forget" ? "deleted" : "updated",
          createdAt: new Date().toISOString(),
          epoch: doc.epoch,
          generation: doc.generation
        });
      }
      doc.snapshotRevision++;
      for (const event of doc.events) event.generation = doc.generation;
    });
  }
}

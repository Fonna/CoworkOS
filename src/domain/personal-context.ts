import { z } from "zod";

export const PERSONAL_CONTEXT_LIMITS = {
  records: 200,
  events: 256,
  receipts: 512,
  requests: 1024,
  links: 400,
  bytes: 2_097_152
};
export type PersonalContextErrorCode =
  | "conflict"
  | "permission_denied"
  | "source_rejected"
  | "assessment_invalid"
  | "request_not_relevant"
  | "invalid_request"
  | "write_attempts_exhausted"
  | "not_found"
  | "inactive"
  | "capacity"
  | "storage_invalid";
export class PersonalContextError extends Error {
  constructor(readonly code: PersonalContextErrorCode) {
    super(
      `Personal context: ${code}` +
        (code === "conflict"
          ? ". This request no longer matches current settings, record versions or a prior operation. No write from this call was committed. Do not infer that a record was deleted or cancelled. Ask the user to resend their request after settings are settled; do not automatically retry the write."
          : code === "assessment_invalid"
            ? ". The independent validation response was incomplete or invalid. No record was saved by this call. Report only this validation failure without exposing its raw response; do not infer a date-range restriction or disabled registration channel, and do not repeatedly retry the write to bypass validation."
            : code === "request_not_relevant"
              ? ". The current user message was not recognized as a personal planning or overview request. No records were returned. This does not mean settings are disabled, permission was revoked or records are missing. Ask which personal arrangements or states the user wants to review."
              : code === "invalid_request"
                ? ". Invalid tool arguments. temporary_state describes a personal condition: status active/ended, validUntil or reviewAt required, startsAt/endsAt/timeZone forbidden. arrangement describes an intended action/event: status tentative/confirmed/cancelled/ended, times optional; include timeZone only for known times, endsAt requires a later instant than startsAt. All timestamps need ISO 8601 with Z or an offset. Never invent dates/times to satisfy validation. One corrected proposal is allowed; if still invalid, stop writing and ask for missing facts."
                : code === "write_attempts_exhausted"
                  ? ". Personal-context writes are blocked for this user message after repeated invalid arguments or a failed authorization/commit. No write from this call was committed. Stop calling save/update/forget, including with changed kind, title or visibility. Explain the failure or ask a focused question; a fresh user message is required. This tool does not schedule reminders."
                  : "")
    );
  }
}
const identity = z.string().trim().min(1).max(500);
const timestamp = z.string().datetime({ offset: true });
const version = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const contextBasisSchema = z.object({ epoch: z.string().uuid(), generation: version }).strict();
export type ContextBasis = z.infer<typeof contextBasisSchema>;
export const contextScopeSchema = z.discriminatedUnion("visibility", [
  z.object({ visibility: z.literal("user") }).strict(),
  z.object({ visibility: z.literal("project"), projectDirectory: identity }).strict(),
  z.object({ visibility: z.literal("task"), workspaceRoot: identity, taskId: identity }).strict()
]);
const timeZone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone");
export const contextInputSchema = z
  .object({
    kind: z
      .enum(["temporary_state", "arrangement"])
      .describe(
        "temporary_state: a personal condition, not a task. arrangement: a plan, intended action or event, including an intention to ask someone about participation."
      ),
    status: z
      .enum(["active", "tentative", "confirmed", "cancelled", "ended"])
      .describe(
        "temporary_state allows only active/ended; arrangement allows only tentative/confirmed/cancelled/ended. Intention or undecided participation is tentative."
      ),
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(2000),
    visibility: z.enum(["task", "project", "user"]),
    quote: z.string().trim().min(1).max(1000),
    observedAt: timestamp,
    validFrom: timestamp.optional(),
    validUntil: timestamp.optional(),
    reviewAt: timestamp
      .optional()
      .describe("Known time to recheck a fact; not a reminder trigger. Do not guess a clock time."),
    startsAt: timestamp
      .optional()
      .describe(
        "Arrangement only. Exact known event start instant; omit when only a date/season or vague evening is known."
      ),
    endsAt: timestamp
      .optional()
      .describe("Arrangement only. Requires known startsAt and must be later; omit if unknown."),
    timeZone: timeZone
      .optional()
      .describe("Arrangement only. Required with startsAt/endsAt; forbidden for temporary_state.")
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom))
      issue("Invalid validity interval");
    if (value.kind === "temporary_state") {
      if (!["active", "ended"].includes(value.status) || value.startsAt || value.endsAt || value.timeZone)
        issue(
          "temporary_state requires active/ended and forbids startsAt, endsAt and timeZone; use arrangement for an intended action/event"
        );
      if (!value.validUntil && !value.reviewAt) issue("Temporary states require expiry or review time");
    } else {
      if (value.status === "active") issue("Invalid arrangement status");
      if ((value.startsAt || value.endsAt) && !value.timeZone) issue("Arrangement times require time zone");
      if (value.endsAt && (!value.startsAt || Date.parse(value.endsAt) <= Date.parse(value.startsAt)))
        issue("Invalid arrangement interval");
    }
  });
export type ContextInput = z.infer<typeof contextInputSchema>;

export const contextRecordSchema = contextInputSchema
  .safeExtend({
    id: z.string().uuid(),
    revision: version.refine((v) => v > 0),
    scope: contextScopeSchema,
    sensitive: z.boolean(),
    evidenceStatus: z.enum(["reported", "uncertain"]),
    purpose: z.string().trim().min(1).max(200),
    consentUntil: timestamp.optional(),
    source: z
      .object({
        workspaceRoot: identity,
        taskId: identity,
        runId: identity,
        messageId: identity,
        receivedAt: timestamp
      })
      .strict(),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .superRefine((value, ctx) => {
    if (value.visibility !== value.scope.visibility)
      ctx.addIssue({ code: "custom", message: "Scope and visibility differ" });
  });
export type ContextRecord = z.infer<typeof contextRecordSchema>;
export const contextSettingsSchema = z
  .object({
    enabled: z.boolean(),
    registrationEnabled: z.boolean(),
    sensitiveEnabled: z.boolean()
  })
  .strict();
export const contextEventSchema = z
  .object({
    eventId: z.string().uuid(),
    contextId: z.string().uuid(),
    revision: version,
    reason: z.enum(["created", "updated", "deleted"]),
    createdAt: timestamp,
    epoch: z.string().uuid(),
    generation: version,
    targets: z.array(z.string().uuid()).max(PERSONAL_CONTEXT_LIMITS.links)
  })
  .strict();
export const contextReceiptSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    id: z.string().uuid(),
    revision: version,
    generation: version
  })
  .strict();
export const contextDocumentSchema = z
  .object({
    version: z.literal(2),
    epoch: z.string().uuid(),
    generation: version,
    snapshotRevision: version,
    settings: contextSettingsSchema,
    links: z
      .array(
        z
          .object({
            linkId: z.string().uuid(),
            contextId: z.string().uuid(),
            revision: version,
            workspaceRoot: identity,
            taskId: identity,
            runId: identity,
            programId: identity.optional(),
            projectDirectory: identity.optional(),
            epoch: z.string().uuid(),
            generation: version
          })
          .strict()
      )
      .max(PERSONAL_CONTEXT_LIMITS.links),
    records: z.array(contextRecordSchema).max(PERSONAL_CONTEXT_LIMITS.records),
    events: z.array(contextEventSchema).max(PERSONAL_CONTEXT_LIMITS.events),
    receipts: z.array(contextReceiptSchema).max(PERSONAL_CONTEXT_LIMITS.receipts),
    requests: z
      .array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), generation: version }).strict())
      .max(PERSONAL_CONTEXT_LIMITS.requests)
  })
  .strict()
  .superRefine((doc, ctx) => {
    for (const keys of [
      doc.records.map((r) => r.id),
      doc.events.map((e) => e.eventId),
      doc.receipts.map((r) => r.key),
      doc.requests.map((r) => r.key),
      doc.links.map((r) => r.linkId)
    ])
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({ code: "custom", message: "Duplicate context identity" });
  });
export type ContextDocument = z.infer<typeof contextDocumentSchema>;
/** Fact and recipient intent share the same atomic snapshot; events carry no private body. */
export function appendContextChange(
  doc: ContextDocument,
  event: Omit<z.input<typeof contextEventSchema>, "targets">
): void {
  doc.events.push({
    ...event,
    targets: doc.links
      .filter(
        (link) =>
          link.contextId === event.contextId &&
          link.epoch === doc.epoch &&
          (link.generation === doc.generation ||
            (event.reason === "deleted" && link.generation === doc.generation - 1))
      )
      .map((link) => link.linkId)
  });
}
export type ContextValidity = "current" | "inactive" | "expired" | "not_yet_valid" | "needs_review";
export function contextValidity(record: ContextRecord, now: number): ContextValidity {
  if (["cancelled", "ended"].includes(record.status)) return "inactive";
  if (record.consentUntil && Date.parse(record.consentUntil) <= now) return "expired";
  if (record.validUntil && Date.parse(record.validUntil) <= now) return "expired";
  if (record.validFrom && Date.parse(record.validFrom) > now) return "not_yet_valid";
  if (record.evidenceStatus === "uncertain" || record.status === "tentative") return "needs_review";
  if (record.reviewAt && Date.parse(record.reviewAt) <= now) return "needs_review";
  if (record.endsAt && Date.parse(record.endsAt) <= now) return "needs_review";
  if (!record.endsAt && record.startsAt && Date.parse(record.startsAt) <= now) return "needs_review";
  return "current";
}

import { z } from "zod";

export const USER_MEMORY_MAX_CHARS = 2000;
export const USER_MEMORY_MAX_CONTEXT_CHARS = 6000;
export const USER_MEMORY_CANDIDATE_TTL_MS = 30 * 86_400_000;

export const userMemoryLearningOptionsSchema = z
  .object({
    model: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/)
      .optional(),
    maxTokens: z.number().int().min(256).max(4096).default(2048),
    maxRequestsPerHour: z.number().int().min(2).max(24).default(6)
  })
  .strict();
export type UserMemoryLearningOptions = z.infer<typeof userMemoryLearningOptionsSchema>;

/** Private, bounded proposals. These are never foreground memory until independently supported. */
export const userMemoryCandidateSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum(["remember", "update"]),
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(500),
    category: z.literal("preference"),
    scope: z.enum(["user", "project"]),
    projectDirectory: z.string().min(1).optional(),
    supports: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(3),
    firstSeenAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if ((candidate.scope === "project") !== Boolean(candidate.projectDirectory))
      ctx.addIssue({ code: "custom", message: "Project candidates require a project directory." });
    if (candidate.action === "update" && (!candidate.id || !candidate.revision))
      ctx.addIssue({ code: "custom", message: "Update candidates require an identity and revision." });
    if (new Set(candidate.supports).size !== candidate.supports.length)
      ctx.addIssue({ code: "custom", message: "Candidate support must come from distinct Tasks." });
  });
export type UserMemoryCandidate = z.infer<typeof userMemoryCandidateSchema>;

export const userMemoryEntrySchema = z
  .object({
    id: z.string().uuid(),
    content: z.string().trim().min(1).max(USER_MEMORY_MAX_CHARS),
    category: z.enum(["preference", "background", "constraint"]),
    scope: z.enum(["user", "project"]),
    projectDirectory: z.string().min(1).optional(),
    source: z
      .object({
        taskId: z.string().min(1),
        runId: z.string().min(1),
        quote: z.string().trim().min(1).max(2000),
        origin: z.enum(["explicit", "automatic", "settings"]).optional()
      })
      .strict(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.scope === "project") !== Boolean(entry.projectDirectory))
      ctx.addIssue({
        code: "custom",
        message: "Project memory must have a project directory; user memory must not."
      });
  });

export const userMemoryDocumentSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    learningEnabled: z.boolean().default(false),
    learningOptions: userMemoryLearningOptionsSchema.default(() => ({
      maxTokens: 2048,
      maxRequestsPerHour: 6
    })),
    learningRequests: z.array(z.number().finite().nonnegative()).max(24).default([]),
    generation: z.number().int().nonnegative().default(0),
    evidenceGeneration: z.number().int().nonnegative().default(0),
    processed: z.array(z.string()).max(200).default([]),
    candidates: z.array(userMemoryCandidateSchema).max(20).default([]),
    pending: z
      .array(
        z
          .object({
            id: z.string(),
            taskId: z.string(),
            runId: z.string(),
            projectDirectory: z.string().optional(),
            text: z.string().max(6000),
            sources: z
              .array(z.object({ runId: z.string(), text: z.string().max(6000) }).strict())
              .max(8)
              .default([]),
            availableAt: z.number(),
            generation: z.number().int().nonnegative(),
            active: z.boolean().default(false),
            activeOwnerPid: z.number().int().positive().optional(),
            attempts: z.number().int().nonnegative().default(0),
            lastError: z.literal("extraction_failed").optional(),
            exclusions: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    content: z.string().max(USER_MEMORY_MAX_CHARS),
                    quote: z.string().max(2000),
                    runIds: z.array(z.string()).max(8)
                  })
                  .strict()
              )
              .max(200)
              .default([])
          })
          .strict()
      )
      .max(30)
      .default([]),
    entries: z.array(userMemoryEntrySchema)
  })
  .strict()
  .superRefine((document, ctx) => {
    if (new Set(document.entries.map((entry) => entry.id)).size !== document.entries.length)
      ctx.addIssue({ code: "custom", message: "Duplicate user memory identity" });
  });

export type UserMemoryEntry = z.infer<typeof userMemoryEntrySchema>;
export type UserMemoryDocument = z.infer<typeof userMemoryDocumentSchema>;

export const memoryLearningChangeSchema = z
  .object({
    action: z.enum(["remember", "update"]),
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(USER_MEMORY_MAX_CHARS),
    category: z.enum(["preference", "background", "constraint"]),
    scope: z.enum(["user", "project"]),
    quote: z.string().trim().min(1).max(2000),
    durability: z.enum(["persistent", "temporary", "uncertain"]),
    evidence: z.enum(["direct", "observed"]).optional()
  })
  .strict();
export type MemoryLearningChange = z.infer<typeof memoryLearningChangeSchema>;
export type MemoryLearningInput = UserMemoryDocument["pending"][number];

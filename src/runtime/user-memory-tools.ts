import { z } from "zod";
import { resolve } from "node:path";
import type { RuntimeTool } from "./tool.js";
import { UserMemoryStore } from "./user-memory-store.js";

const requestSchema = z
  .object({
    action: z.enum([
      "list",
      "remember",
      "update",
      "forget",
      "enable",
      "disable",
      "enable_learning",
      "disable_learning"
    ]),
    content: z.string().trim().min(1).max(2000).optional(),
    category: z.enum(["preference", "background", "constraint"]).optional(),
    scope: z.enum(["user", "project"]).optional(),
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    quote: z.string().trim().min(1).max(2000).optional()
  })
  .strict();

export const USER_MEMORY_DESCRIPTION =
  "Manage one persistent user profile across Tasks, at most 2000 characters in total. Internal entries retain evidence; consolidate existing content rather than accumulating duplicates. List to inspect entries/revisions. Use this tool only when the user explicitly asks to inspect/change memories or their settings; quote the current user message for changes. Enable/disable controls use of remembered facts only. Enable_learning/disable_learning independently controls background learning and never enables memory use. Learning requires both settings to be enabled and defaults off. Do not proactively suggest enabling learning, ask for confirmation of incidental facts, or announce background learning. Leave ordinary learning to the idle background service; unconfirmed observations remain private candidates. Never infer or store memory yourself from documents/web/tools. Store stable preferences/background, never secrets or authorization. Current requests override memory. Project scope uses the host's project. Disabling use pauses learning without changing its separate setting; list returns flags and no entries while disabled. When enabled, list includes only user and current-project entries. The settings editor remains available while disabled. Explicit deletion is allowed while disabled if the id/revision is already known. Updates/deletes require the listed revision.";

export function createUserMemoryTool(options: {
  store?: UserMemoryStore;
  taskId: string;
  runId: string;
  projectDirectory?: string;
  userText: () => string | Promise<string>;
}): RuntimeTool {
  const store = options.store ?? new UserMemoryStore();
  return {
    description: USER_MEMORY_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: [
            "list",
            "remember",
            "update",
            "forget",
            "enable",
            "disable",
            "enable_learning",
            "disable_learning"
          ]
        },
        content: { type: "string", minLength: 1, maxLength: 2000 },
        category: { type: "string", enum: ["preference", "background", "constraint"] },
        scope: { type: "string", enum: ["user", "project"] },
        id: { type: "string", format: "uuid" },
        revision: { type: "integer", minimum: 1 },
        quote: { type: "string", minLength: 1, maxLength: 2000 }
      },
      required: ["action"]
    },
    async execute(input, signal) {
      signal?.throwIfAborted();
      const request = requestSchema.parse(input);
      if (request.action === "list") {
        const { enabled, learningEnabled, entries } = await store.readProfile();
        const projectDirectory = options.projectDirectory ? resolve(options.projectDirectory) : undefined;
        return {
          version: 1,
          enabled,
          learningEnabled,
          entries: enabled
            ? entries.filter((entry) => entry.scope === "user" || entry.projectDirectory === projectDirectory)
            : []
        };
      }
      const quote = request.quote;
      if (!quote || !(await options.userText()).includes(quote))
        throw new Error(
          "Memory changes require an exact quote from an explicit request in the current user message. Skip the change if no explicit request exists; do not interrupt the task to ask about saving memory."
        );
      const source = { taskId: options.taskId, runId: options.runId, quote, origin: "explicit" as const };
      if (request.action === "enable_learning" || request.action === "disable_learning") {
        await store.setLearningEnabled(request.action === "enable_learning");
        const { enabled, learningEnabled } = await store.read();
        return { enabled, learningEnabled };
      }
      if (request.action === "enable" || request.action === "disable") {
        await store.setEnabled(request.action === "enable");
        const { enabled, learningEnabled } = await store.read();
        return { enabled, learningEnabled };
      }
      if (request.action === "remember") {
        if (!request.content) throw new Error("content is required");
        const scope = request.scope ?? "user";
        if (scope === "project" && !options.projectDirectory) throw new Error("No project is selected");
        return await store.remember({
          content: request.content,
          category: request.category ?? "preference",
          scope,
          projectDirectory: scope === "project" ? options.projectDirectory : undefined,
          source
        });
      }
      if (!request.id || !request.revision)
        throw new Error("id and revision are required; list memories first");
      if (request.action === "forget") {
        await store.forget(request.id, request.revision);
        return { forgotten: request.id };
      }
      if (!request.content) throw new Error("content is required");
      return await store.update(request.id, request.revision, request.content, source);
    }
  };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { userMemoryLearningOptionsSchema } from "../domain/user-memory.js";
import { userMemoryText, userMemoryRevision, type UserMemoryStore } from "../runtime/user-memory-store.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

function publicMemory(document: Awaited<ReturnType<UserMemoryStore["read"]>>) {
  const { version, enabled, learningEnabled, learningOptions, entries } = document;
  return {
    version,
    enabled,
    learningEnabled,
    learningOptions,
    entries,
    content: userMemoryText(document),
    revision: userMemoryRevision(document)
  };
}

const changeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save_text"),
      content: z.string().trim().max(2000),
      revision: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  z.object({ action: z.literal("set_enabled"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("set_learning"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("set_learning_options"), options: userMemoryLearningOptionsSchema }).strict(),
  z
    .object({
      action: z.literal("remember"),
      content: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      content: z.string().trim().min(1).max(2000)
    })
    .strict(),
  z
    .object({ action: z.literal("forget"), id: z.string().uuid(), revision: z.number().int().positive() })
    .strict()
]);

/** Called only after the Dashboard's local request/authentication checks. */
export async function handleUserMemoryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  store: UserMemoryStore
): Promise<boolean> {
  if (url.pathname !== "/api/user-memory") return false;
  if (request.method === "GET") {
    response.setHeader("cache-control", "no-store");
    sendJson(response, 200, publicMemory(await store.read()));
    return true;
  }
  if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
  const parsed = changeSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw new HttpError(400, "用户记忆参数不合法");
  const input = parsed.data;
  try {
    if (input.action === "save_text") await store.saveText(input.content, input.revision);
    else if (input.action === "set_enabled") await store.setEnabled(input.enabled);
    else if (input.action === "set_learning") await store.setLearningEnabled(input.enabled);
    else if (input.action === "set_learning_options") await store.setLearningOptions(input.options);
    else if (input.action === "forget") await store.forget(input.id, input.revision);
    else if (input.action === "remember")
      await store.remember({
        content: input.content,
        category: "preference",
        scope: "user",
        source: { taskId: "settings", runId: "settings", quote: input.content, origin: "settings" }
      });
    else
      await store.update(input.id, input.revision, input.content, {
        taskId: "settings",
        runId: "settings",
        quote: input.content,
        origin: "settings"
      });
  } catch {
    throw new HttpError(409, "记忆已变化、已禁用或暂时不可用，请刷新后重试。原有数据已保留。");
  }
  response.setHeader("cache-control", "no-store");
  sendJson(response, 200, publicMemory(await store.read()));
  return true;
}

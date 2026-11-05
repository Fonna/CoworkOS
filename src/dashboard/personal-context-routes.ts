import type { IncomingMessage, ServerResponse } from "node:http";
import { PersonalContextError } from "../domain/personal-context.js";
import {
  contextManagementChangeSchema,
  type PersonalContextManagement
} from "../runtime/personal-context-management.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";

/** Called after the shared local Host/Origin/session boundary. */
export async function handlePersonalContextRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: PersonalContextManagement
): Promise<boolean> {
  if (url.pathname !== "/api/personal-context") return false;
  if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "Method not allowed");
  try {
    if (request.method === "POST") {
      const input = contextManagementChangeSchema.safeParse(await readJsonBody(request));
      if (!input.success) throw new HttpError(400, "情境参数不合法");
      await service.change(input.data);
    }
    response.setHeader("cache-control", "no-store");
    sendJson(response, 200, await service.overview());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = error instanceof PersonalContextError ? error.code : "unavailable";
    throw new HttpError(
      code === "storage_invalid" || code === "unavailable" ? 503 : 409,
      `情境暂不可用（${code}），已有数据已保留。请刷新后重试。`
    );
  }
  return true;
}

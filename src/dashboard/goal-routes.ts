import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson, HttpError } from "./http.js";
import { GoalConflictError } from "../domain/goal.js";
import type { createGoalService } from "./goal-service.js";

export async function handleGoalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  goals: ReturnType<typeof createGoalService>,
  scheduler: unknown
): Promise<boolean> {
  if (
    url.pathname !== "/api/goals" &&
    url.pathname !== "/api/goals/activity" &&
    !/^\/api\/tasks\/[^/]+\/goals(?:\/|$)/.test(url.pathname)
  )
    return false;
  try {
    if (url.pathname === "/api/goals/activity") {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "method not allowed" });
        return true;
      }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error("invalid offset");
      sendJson(
        response,
        200,
        await goals.feed(
          offset,
          url.searchParams.get("unread") === "1",
          url.searchParams.get("taskId") ?? undefined
        )
      );
      return true;
    }
    if (url.pathname === "/api/goals") {
      if (request.method === "GET") sendJson(response, 200, { goals: await goals.all(), scheduler });
      else if (request.method === "POST") {
        const { sourceTaskId, ...input } = await readJsonBody(request);
        if (sourceTaskId !== undefined && typeof sourceTaskId !== "string")
          throw new Error("invalid sourceTaskId");
        sendJson(response, 201, await goals.create(sourceTaskId, input));
      } else sendJson(response, 405, { error: "method not allowed" });
      return true;
    }
    const match = url.pathname.match(
      /^\/api\/tasks\/([^/]+)\/goals(?:\/([^/]+)(?:\/(control|activity|notifications\/([^/]+)\/read))?)?$/
    );
    if (!match) throw new HttpError(404, "not found");
    const taskId = decodeURIComponent(match[1]);
    const programId = match[2] && decodeURIComponent(match[2]);
    if (request.method === "GET" && !programId)
      sendJson(response, 200, { goals: await goals.all(taskId), scheduler });
    else if (request.method === "GET" && programId && match[3] === "activity") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid offset");
      sendJson(response, 200, await goals.activity(taskId, programId, offset));
    } else if (request.method === "GET" && programId && !match[3])
      sendJson(response, 200, await goals.get(taskId, programId));
    else if (request.method === "POST" && programId && match[3] === "control")
      sendJson(response, 200, await goals.control(taskId, programId, await readJsonBody(request)));
    else if (request.method === "POST" && programId && match[4])
      sendJson(response, 200, await goals.readNotification(taskId, programId, decodeURIComponent(match[4])));
    else sendJson(response, 405, { error: "method not allowed" });
    return true;
  } catch (error) {
    if (error instanceof GoalConflictError) throw new HttpError(409, error.message);
    throw error;
  }
}

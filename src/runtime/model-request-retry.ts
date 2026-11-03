import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validMainRequestExecutionScope,
  type MainRequestExecutionScope
} from "./main-request-execution-scope.js";

export interface RetryModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

/** Private recovery data, separate from the redacted diagnostic request archive. */
export interface ModelRequestRetry {
  version: 1;
  taskId: string;
  runId: string;
  requestId: string;
  state: "pending" | "failed" | "interrupted" | "completed";
  model: RetryModel;
  endpoint: string;
  body: string;
  context: unknown;
  systemPrompt: string;
  tools: { name: string; description: string; parameters: unknown }[];
  sessionId?: string;
  retriedRequestId?: string;
  /** Older version-1 snapshots remain readable, but cannot safely be replayed. */
  executionScope?: MainRequestExecutionScope;
}

export const modelRequestRetryPath = (workspace: string, taskId: string) =>
  join(workspace, taskId, "sessions", "main", "retry-request.json");

export async function readModelRequestRetry(path: string): Promise<ModelRequestRetry | undefined> {
  let value: ModelRequestRetry;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("失败请求归档无法读取，原始记录已保留。", { cause: error });
  }
  if (
    value?.version !== 1 ||
    typeof value.taskId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.requestId !== "string" ||
    !["pending", "failed", "interrupted", "completed"].includes(value.state) ||
    typeof value.body !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.model?.id !== "string" ||
    typeof value.model?.provider !== "string" ||
    typeof value.model?.reasoning !== "boolean" ||
    !Array.isArray(value.model?.input) ||
    !value.model.input.every((input) => ["text", "image"].includes(input)) ||
    !Number.isSafeInteger(value.model?.contextWindow) ||
    value.model.contextWindow < 1 ||
    !Number.isSafeInteger(value.model?.maxTokens) ||
    value.model.maxTokens < 1 ||
    typeof value.model?.baseUrl !== "string" ||
    !["openai-completions", "openai-responses"].includes(value.model?.api) ||
    typeof value.systemPrompt !== "string" ||
    !Array.isArray(value.tools) ||
    !value.tools.every(
      (tool) =>
        typeof tool?.name === "string" &&
        typeof tool.description === "string" &&
        tool.parameters &&
        typeof tool.parameters === "object"
    ) ||
    !value.context ||
    typeof value.context !== "object" ||
    !Array.isArray((value.context as { messages?: unknown }).messages) ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.executionScope !== undefined && !validMainRequestExecutionScope(value.executionScope))
  )
    throw new Error("失败请求归档不完整，原始记录已保留。");
  try {
    const request = JSON.parse(value.body);
    if (!request || typeof request !== "object" || Array.isArray(request) || request.model !== value.model.id)
      throw new Error();
    const endpoint = new URL(value.endpoint);
    const base = new URL(value.model.baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.origin !== base.origin)
      throw new Error();
  } catch {
    throw new Error("失败请求归档不完整，原始记录已保留。");
  }
  return value;
}

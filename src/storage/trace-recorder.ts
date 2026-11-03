import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { now, type Event } from "../domain/types.js";

export interface TraceRecord {
  traceId: string;
  kind: "model_request" | "model_response" | "tool_start" | "tool_end" | "runtime";
  taskId: string;
  runId: string;
  agentId?: string;
  payload: unknown;
  occurredAt?: string;
}

/** Append-only, replay-friendly trace sink. Secret-looking fields are redacted. */
export class TraceRecorder {
  constructor(private readonly filePath: string) {}

  get modelRequestPath(): string {
    return this.filePath.replace(/\.jsonl$/, "") + "-requests.jsonl";
  }

  async record(record: TraceRecord): Promise<void> {
    const event: Event = {
      eventId: record.traceId,
      type: `trace.${record.kind}`,
      taskId: record.taskId,
      runId: record.runId,
      agentId: record.agentId,
      occurredAt: record.occurredAt ?? now(),
      payload: redact(compactTracePayload(record.payload))
    };
    const line = `${JSON.stringify(event)}\n`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, line, "utf8");
  }
}

/** Pi includes the entire accumulated response twice with every delta. Store
 * the delta once; message_end still preserves the complete final message.
 * This transforms only the disk record, never model context or live events. */
function compactTracePayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "message_update")
    return value;
  const { message: _snapshot, assistantMessageEvent, ...rest } = value as Record<string, unknown>;
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") return value;
  const { partial: _partial, ...delta } = assistantMessageEvent as Record<string, unknown>;
  return { ...rest, assistantMessageEvent: delta };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = /key|token|secret|authorization|password/i.test(key) ? "[REDACTED]" : redact(child);
  }
  return output;
}

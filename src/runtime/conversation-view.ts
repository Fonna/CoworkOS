import { readQueuedUserTurn } from "./queued-user-turn.js";
export interface ConversationMessage {
  id?: string;
  interjected?: boolean;
  delivery?: "steer" | "followUp";
  pending?: boolean;
  role: "user" | "assistant";
  content: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
}

/** Pi persists session entries; the UI consumes role/content messages. */
export function conversationMessages(entries: unknown): ConversationMessage[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap<ConversationMessage>((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry.type === "message" ? entry.message : entry;
    if (
      message?.customType === "cowork-user-message" &&
      (message.role === "custom" || message.type === "custom_message") &&
      typeof message.details?.message === "string"
    ) {
      const delivery = message.details.delivery === "followUp" ? "followUp" : "steer";
      // Pi's saved custom entries use ISO strings; delivered runtime messages
      // use epoch numbers. Keep both in the history's numeric time domain.
      const timestamp =
        typeof message.timestamp === "string" ? Date.parse(message.timestamp) : message.timestamp;
      return [
        {
          id: message.details._coworkInbox?.messageId || entry.id,
          role: "user" as const,
          content: message.details.message,
          timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
          interjected: delivery === "steer",
          delivery,
          pending: false
        }
      ];
    }
    if (!message || !["user", "assistant"].includes(message.role)) return [];
    const queued = message.role === "user" ? readQueuedUserTurn(message.content) : undefined;
    return [
      {
        id: queued?.messageId || entry.id,
        role: message.role,
        content: queued?.text ?? message.content,
        timestamp: message.timestamp,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage
      }
    ];
  });
}

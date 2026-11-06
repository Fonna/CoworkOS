import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mainInputPath, readMainInput } from "../../dist/src/runtime/main-continuation.js";
import { readQueuedUserTurn } from "../../dist/src/runtime/queued-user-turn.js";
import type { ContextChatSource } from "../../dist/src/runtime/personal-context-chat.js";
import { personalContextAnswer } from "../../dist/src/runtime/personal-context-answer.js";

/** Authorization comes from durable real user entries, never a projected compaction summary. */
export async function personalContextSource(
  ctx: ExtensionContext,
  host: { workspaceRoot: string; taskId: string; runId: string; dashboard: boolean }
): Promise<ContextChatSource | undefined> {
  // Tool/custom envelopes select an identity only. Ignore their answer text:
  // the host reads the actual human answer and verifies the original Run.
  for (const item of [...ctx.sessionManager.getBranch()].reverse()) {
    if (item.type !== "message") continue;
    const message = item.message;
    if (message.role === "user") break;
    const candidate = message as unknown as {
      role: string;
      toolName?: string;
      customType?: string;
      isError?: boolean;
      details?: { requestId?: unknown; status?: string; type?: string };
    };
    if (
      (candidate.role === "toolResult" && candidate.toolName === "askhuman") ||
      candidate.customType === "cowork-human-answer"
    ) {
      if (
        candidate.isError ||
        (candidate.role === "toolResult"
          ? candidate.details?.status !== "answered"
          : candidate.details?.type !== "human.answer")
      )
        return;
      if (typeof candidate.details?.requestId !== "string") return;
      return personalContextAnswer(host, candidate.details.requestId);
    }
  }
  const entry = ctx.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "user");
  if (entry?.type !== "message" || entry.message.role !== "user") return;
  const content = entry.message.content;
  const raw =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  const text = readQueuedUserTurn(raw)?.text ?? raw;
  const input = await readMainInput(mainInputPath(host.workspaceRoot, host.taskId, host.runId));
  const matches = input && (readQueuedUserTurn(input.prompt)?.text ?? input.prompt) === text;
  const userText = matches
    ? input.source === "composer"
      ? (input.body ?? (input.attachmentIds?.length || input.textAttachments?.length ? "" : text))
      : ""
    : host.dashboard
      ? ""
      : text;
  if (!userText || userText.length > 6000) return;
  return {
    messageId:
      matches && input.messageId ? input.messageId : `pi:${ctx.sessionManager.getSessionId()}:${entry.id}`,
    receivedAt: new Date(matches ? input.submittedAt : entry.message.timestamp).toISOString(),
    text: userText
  };
}

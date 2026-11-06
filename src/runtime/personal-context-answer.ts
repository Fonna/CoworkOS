import { HumanRequestStore } from "./human.js";
import { LocalWorkspaceStore } from "../workspace/workspace-store.js";
import { PersonalContextStore } from "./personal-context-store.js";
import { personalContextSourceBasis } from "./personal-context-service.js";
import type { ContextChatSource } from "./personal-context-chat.js";

/** The envelope identifies a candidate; only the durable human record supplies evidence. */
export async function personalContextAnswer(
  host: { workspaceRoot: string; taskId: string; runId: string },
  requestId: string,
  store = new PersonalContextStore()
): Promise<ContextChatSource | undefined> {
  if (!/^[a-zA-Z0-9._-]{1,500}$/.test(requestId) || [".", ".."].includes(requestId)) return;
  const request = await new HumanRequestStore(host.workspaceRoot).read(host.taskId, requestId);
  if (
    request.status !== "answered" ||
    request.superseded ||
    request.requestId !== requestId ||
    request.taskId !== host.taskId ||
    request.runId !== host.runId ||
    typeof request.answer !== "string" ||
    !request.answer.trim() ||
    request.answer.length > 6000 ||
    typeof request.answeredAt !== "string" ||
    !Number.isFinite(Date.parse(request.answeredAt))
  )
    return;
  const task = await new LocalWorkspaceStore(host.workspaceRoot).readTask(host.taskId);
  if (
    task.activeRunId !== host.runId ||
    task.archived ||
    ["completed", "cancelled", "failed"].includes(task.status)
  )
    return;
  const messageId = `human:${request.requestId}`;
  // Existing stamps are immutable. Re-reading an answer must not rewrite the
  // snapshot at every model hook or rebind it after a settings generation change.
  if (!(await store.readExisting())) return;
  const basis = await personalContextSourceBasis(store, { ...host, messageId });
  return { messageId, receivedAt: request.answeredAt, text: request.answer, basis, kind: "human_answer" };
}

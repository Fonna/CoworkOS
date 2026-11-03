import { createHash } from "node:crypto";
import {
  USER_MEMORY_CANDIDATE_TTL_MS,
  type MemoryLearningChange,
  type UserMemoryDocument
} from "../domain/user-memory.js";

/** Inspect the whole source, so a first-person quote cannot escape a third-party wrapper. */
function excludedSource(text: string): boolean {
  return /(?:朋友|同事|客户|同学|家人|父亲|母亲|老板|他(?:的|说)|她(?:的|说)|他们|她们|扮演|角色|假设|假如|模拟|故事|小说|引用|转述|举例|例如|改写|重写|润色|代写|自我介绍|人设|台词|简历|这次|此次|本次|这回|今天|暂时|临时|仅这|仅本|\b(?:friend|colleague|client|customer|someone|pretend|role.?play|imagine|suppose|fiction|fictional|quote|example|rewrite|rephrase|polish|biography|bio|introduction|persona|today|temporarily)\b|\b(?:write|draft|speak)\s+for\b|\b(?:he|she|they)\s+(?:says?|said|prefers?|likes?)\b|\bfor this\b|\bthis (?:time|task|request)\b)/i.test(
    text
  );
}

/** A deliberately narrow shortcut: only an explicit stable self-description or project convention. */
export function directMemoryEvidence(change: MemoryLearningChange, sourceText: string): boolean {
  if (excludedSource(sourceText)) return false;
  const sentence = change.quote.trim().replace(/^(?:补充一句[，,:：]\s*)/, "");
  const source = sourceText.trim().replace(/^(?:补充一句[，,:：]\s*)/, "");
  // The quote must start at a real source boundary, rather than inside attributed or conditional text.
  const position = sourceText.indexOf(change.quote);
  if (position < 0 || (position > 0 && !/[\n。！？.!?]\s*$/.test(sourceText.slice(0, position))))
    return false;
  const stable =
    change.scope === "project"
      ? /^(?:(?:本项目|这个项目|我们的项目|项目)(?:一直|长期|统一|默认|约定|固定|始终|通常)|(?:this|our) project (?:always |normally |consistently |uses |requires |follows ))/i
      : /^(?:我(?:平时|一直|通常|习惯|长期|一贯|以后|日常|经常)|我(?:的)?(?:日常工作|工作|职业|名字|姓名|专业|母语|常用语言|研究方向|职位|所在行业)(?:主要)?(?:是|为)|我(?:是一名|是个|从事)|I (?:usually |always |generally |normally |consistently |work as )|my (?:name|job|profession|native language|occupation|role) is )/i;
  // A task/writing instruction followed by a first-person passage has ambiguous ownership.
  return stable.test(source) && stable.test(sentence);
}

export function memoryCandidateKey(change: MemoryLearningChange, projectDirectory?: string): string {
  const content = change.content.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256")
    .update(
      JSON.stringify([
        change.action,
        change.action === "update" ? change.id : undefined,
        change.action === "update" ? change.revision : undefined,
        change.scope,
        projectDirectory,
        change.category,
        content
      ])
    )
    .digest("hex");
}

export function pruneMemoryCandidates(document: UserMemoryDocument, now = Date.now()): void {
  document.candidates = document.candidates.filter(
    (candidate) => Date.parse(candidate.firstSeenAt) > now - USER_MEMORY_CANDIDATE_TTL_MS
  );
}

/** Mutates only the transaction's document. A failed capacity check persists none of this evidence. */
export function admitMemoryChange(
  document: UserMemoryDocument,
  change: MemoryLearningChange,
  sourceText: string,
  taskId: string,
  projectDirectory?: string,
  now = Date.now()
): { admitted: boolean; key: string } {
  const key = memoryCandidateKey(change, projectDirectory);
  if (change.content.length > 500 || excludedSource(sourceText)) return { admitted: false, key };
  if (change.evidence === "direct") return { admitted: directMemoryEvidence(change, sourceText), key };
  // Inferred identity/background or constraints are never promoted through repetition.
  if (change.category !== "preference") return { admitted: false, key };
  const support = createHash("sha256").update(taskId).digest("hex");
  const timestamp = new Date(now).toISOString();
  let candidate = document.candidates.find((item) => item.key === key);
  if (!candidate) {
    candidate = {
      key,
      action: change.action,
      ...(change.action === "update" ? { id: change.id, revision: change.revision } : {}),
      content: change.content,
      category: "preference",
      scope: change.scope,
      projectDirectory,
      supports: [support],
      firstSeenAt: timestamp,
      updatedAt: timestamp
    };
    document.candidates.push(candidate);
  } else if (!candidate.supports.includes(support)) {
    candidate.supports = [...candidate.supports, support].slice(-3);
    candidate.updatedAt = timestamp;
  }
  document.candidates = document.candidates.slice(-20);
  return { admitted: candidate.supports.length >= 3, key };
}

export function clearMemoryCandidates(
  document: UserMemoryDocument,
  scope: "user" | "project",
  projectDirectory?: string
): void {
  document.candidates = document.candidates.filter(
    (candidate) => candidate.scope !== scope || candidate.projectDirectory !== projectDirectory
  );
}

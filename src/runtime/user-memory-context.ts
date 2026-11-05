import { estimateContextTokens, estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

/**
 * Memory and project knowledge are optional request context. Never compact or trim the
 * conversation to make room for it: omit the whole section when the host's
 * remaining input budget cannot accommodate it.
 */
export function optionalContextSectionWithinBudget(
  messages: AgentMessage[],
  section: "user_memory" | "project_experience" | "project_skills" | "personal_context",
  memory: string,
  budget: { contextWindow: number; reserveTokens: number; maxTokens: number }
): AgentMessage[] {
  const withoutMemory = messages.map((message) =>
    message.role === "system" ? { ...message, sections: { ...message.sections, [section]: "" } } : message
  );
  if (!memory) return withoutMemory;
  const withMemory = withoutMemory.map((message) =>
    message.role === "system" ? { ...message, sections: { ...message.sections, [section]: memory } } : message
  );
  // The harness estimator can use earlier provider usage, which cannot account
  // for an edited system section. Also estimate the complete current request,
  // including its system prompt and tool schemas, then charge the memory delta
  // against whichever base estimate is larger. Earlier usage may still include
  // old memory; retaining that overestimate is safer than reclaiming unknown tokens.
  const tokensForMessage = (message: AgentMessage) =>
    message.role === "system" ||
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult"
      ? estimateMessageTokens(message)
      : estimateTokens(message);
  const baseTokens = withoutMemory.reduce((tokens, message) => tokens + tokensForMessage(message), 0);
  const nextTokens = withMemory.reduce((tokens, message) => tokens + tokensForMessage(message), 0);
  const estimated =
    Math.max(baseTokens, estimateContextTokens(withoutMemory).tokens) + nextTokens - baseTokens;
  const limit = budget.contextWindow - Math.max(budget.reserveTokens, budget.maxTokens);
  return Number.isFinite(limit) && estimated <= limit ? withMemory : withoutMemory;
}

export function userMemoryWithinContextBudget(
  messages: AgentMessage[],
  memory: string,
  budget: { contextWindow: number; reserveTokens: number; maxTokens: number }
): AgentMessage[] {
  return optionalContextSectionWithinBudget(messages, "user_memory", memory, budget);
}

export function personalContextWithinBudget(
  messages: AgentMessage[],
  context: string,
  budget: { contextWindow: number; reserveTokens: number; maxTokens: number }
): AgentMessage[] {
  const projected = optionalContextSectionWithinBudget(messages, "personal_context", context, budget);
  if (
    !context ||
    projected.some((message) => message.role === "system" && message.sections?.personal_context)
  )
    return projected;
  return optionalContextSectionWithinBudget(
    projected,
    "personal_context",
    "Personal context omitted for input budget. This is not evidence that no arrangements exist. Query manage_personal_context before planning; report incomplete checking if context is still unavailable.",
    budget
  );
}

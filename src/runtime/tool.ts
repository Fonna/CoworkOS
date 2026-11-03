/** Minimal runtime tool contract shared by PiSession and built-in tools. */
export interface RuntimeTool {
  /** Only explicitly independent reads may overlap; other tools stay ordered. */
  executionMode?: "sequential" | "parallel";
  /** Optional model-facing metadata for adapters with dynamic tools. */
  description?: string;
  parameters?: unknown;
  execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

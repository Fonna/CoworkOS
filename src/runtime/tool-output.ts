import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export const DEFAULT_TOOL_RESPONSE_CHARS = 16_000;

/** Bound model-visible text; retain native images, error metadata and original details. */
export function limitToolContent(
  content: (TextContent | ImageContent)[],
  maxChars?: number
): (TextContent | ImageContent)[] {
  if (maxChars === undefined) return content;
  const texts = content.filter((block) => block.type === "text");
  if (texts.reduce((sum, block) => sum + block.text.length, 0) <= maxChars) return content;
  let remaining = maxChars;
  let count = texts.length;
  return content.map((block) => {
    if (block.type !== "text") return block;
    const budget = Math.min(block.text.length, Math.floor(remaining / count));
    remaining -= budget;
    count--;
    return { ...block, text: truncateToolText(block.text, budget) };
  });
}

export function truncateToolText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  let head = Math.floor(available / 2);
  let tail = text.length - (available - head);
  // Do not split a surrogate pair at either retained boundary.
  if (/^[\uDC00-\uDFFF]$/.test(text[head] ?? "")) head--;
  if (/^[\uDC00-\uDFFF]$/.test(text[tail] ?? "")) tail++;
  return text.slice(0, head) + marker + text.slice(tail);
}

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export interface WorkspaceTextPage {
  content: string;
  truncated: boolean;
  offset: number;
  nextOffset?: number;
  size: number;
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;
const characterBytes = (byte: number): number => byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;

/** Read one bounded page. Offsets are bytes; an offset inside a UTF-8 character
 * is aligned backward and reported in the result. A budget below four bytes
 * may be exceeded only to return the first complete character and make progress. */
export async function readWorkspaceText(path: string, maxBytes: number, offset = 0): Promise<WorkspaceTextPage> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative byte offset");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("workspace text read requires a file");
    const size = info.size;
    const requestedOffset = Math.min(offset, size);
    if (requestedOffset === size) return { content: "", truncated: false, offset: requestedOffset, size };
    const position = Math.max(0, requestedOffset - 3);
    const buffer = Buffer.allocUnsafe(Math.min(size - position, maxBytes + 7));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, position + length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const requestedStart = requestedOffset - position;
    if (length <= requestedStart) return { content: "", truncated: false, offset: requestedOffset, size };
    let start = requestedStart;
    while (start > 0 && isContinuation(buffer[start])) start -= 1;
    // Malformed bytes are decoded normally; only valid-looking multibyte
    // sequences may change the requested offset.
    if (start + characterBytes(buffer[start]) <= requestedStart) start = requestedStart;
    let end = Math.min(length, start + maxBytes);
    if (end < length && isContinuation(buffer[end])) {
      while (end > start && isContinuation(buffer[end])) end -= 1;
      if (end === start) end = Math.min(length, start + characterBytes(buffer[start]));
    }
    const nextOffset = position + end;
    const truncated = nextOffset < size;
    return { content: buffer.subarray(start, end).toString("utf8"), truncated, offset: position + start, ...(truncated ? { nextOffset } : {}), size };
  } finally {
    await file.close();
  }
}

const SEARCH_CHUNK_BYTES = 64 * 1024;
const CONTEXT_BEFORE_BYTES = 240;
// Reserve room for explicit truncation markers within the 1,000-byte result.
const CONTEXT_CONTENT_BYTES = 960;

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && isContinuation(bytes[end])) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && isContinuation(bytes[start])) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function searchTail(value: string, characters: number): string {
  let start = Math.max(0, value.length - characters);
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

// Lowercasing may expand a character (for example İ). Map a match position
// back to the original text so the returned context still contains the match.
function sourceIndex(value: string, lowercaseIndex: number): number {
  let folded = 0;
  let original = 0;
  for (const character of value) {
    const width = character.toLowerCase().length;
    if (folded + width > lowercaseIndex) return original;
    folded += width;
    original += character.length;
  }
  return original;
}

/** Search every line without retaining a whole file or a whole JSONL record.
 * Matching is case-insensitive and returns at most one context per line. */
export async function searchWorkspaceText(path: string, query: string, maxMatches: number): Promise<Array<{ line: number; text: string }>> {
  if (!query) throw new Error("workspace text search requires a query");
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 0) throw new Error("maxMatches must be a non-negative integer");
  const matches: Array<{ line: number; text: string }> = [];
  if (maxMatches === 0) return matches;
  const needle = query.toLowerCase();
  const decoder = new StringDecoder("utf8");
  let line = 1;
  let tail = "";
  let consumed = 0;
  let context: string | undefined;
  let prefixTruncated = false;
  let emitted = false;
  let pendingCR = "";

  const emit = (suffixTruncated: boolean) => {
    if (context === undefined || emitted) return;
    const truncated = prefixTruncated || suffixTruncated;
    matches.push({ line, text: `${prefixTruncated ? "… " : ""}${context}${suffixTruncated ? " …" : ""}${truncated ? " [truncated]" : ""}` });
    emitted = true;
    context = undefined;
    tail = "";
  };

  const consume = (part: string, endLine: boolean, atEOF = false) => {
    let segment = pendingCR + part;
    pendingCR = "";
    if (endLine && segment.endsWith("\r")) segment = segment.slice(0, -1);
    else if (!endLine && !atEOF && segment.endsWith("\r")) { pendingCR = "\r"; segment = segment.slice(0, -1); }
    if (!emitted) {
      if (context !== undefined) {
        const rest = context + segment;
        context = utf8Prefix(rest, CONTEXT_CONTENT_BYTES);
        if (context.length < rest.length) emit(true);
      } else {
        const window = tail + segment;
        const index = window.toLowerCase().indexOf(needle);
        if (index >= 0) {
          const originalIndex = sourceIndex(window, index);
          const before = window.slice(0, originalIndex);
          const prefix = utf8Suffix(before, CONTEXT_BEFORE_BYTES);
          prefixTruncated = consumed > tail.length || prefix.length < before.length;
          const rest = prefix + window.slice(originalIndex);
          context = utf8Prefix(rest, CONTEXT_CONTENT_BYTES);
          if (context.length < rest.length) emit(true);
          tail = "";
        } else tail = searchTail(window, needle.length + CONTEXT_BEFORE_BYTES + 2);
      }
    }
    consumed += segment.length;
    if (endLine) {
      emit(false);
      line += 1;
      tail = "";
      consumed = 0;
      context = undefined;
      prefixTruncated = false;
      emitted = false;
    }
  };

  const consumeChunk = (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; end = chunk.indexOf("\n", start)) {
      consume(chunk.slice(start, end), true);
      if (matches.length >= maxMatches) return;
      start = end + 1;
    }
    if (start < chunk.length) consume(chunk.slice(start), false);
  };

  for await (const bytes of createReadStream(path, { highWaterMark: SEARCH_CHUNK_BYTES })) {
    consumeChunk(decoder.write(bytes));
    if (matches.length >= maxMatches) return matches;
  }
  consumeChunk(decoder.end());
  if (matches.length < maxMatches) {
    // A lone final CR is file content; CRLF has already been removed above.
    consume("", false, true);
    emit(false);
  }
  return matches;
}

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveTaskArtifact } from "../workspace/artifact-store.js";

const previewBytes = 256 * 1024;

/** Serve only files physically present in the Task's final artifacts directory. */
export async function serveArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    workspaceRoot: string;
    taskId: string;
    relativePath: string;
    raw?: boolean;
    download?: boolean;
  }
): Promise<void> {
  const { absolutePath, stat, artifact } = await resolveTaskArtifact(input);
  const mimeType = artifact.mimeType ?? "application/octet-stream";
  const text =
    mimeType.startsWith("text/") ||
    ["application/json", "application/x-ndjson", "application/xml", "application/javascript"].includes(
      mimeType
    );
  let previewKind =
    mimeType === "application/pdf"
      ? "pdf"
      : mimeType.startsWith("image/")
        ? "image"
        : text
          ? "text"
          : "download";
  const endpoint = `/api/tasks/${encodeURIComponent(input.taskId)}/artifact?path=${encodeURIComponent(input.relativePath)}`;
  const version = artifact.sha256;
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (input.raw || input.download) {
      const rawMime = mimeType === "text/html" ? "text/plain; charset=utf-8" : mimeType;
      const filename = encodeURIComponent(basename(input.relativePath)).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      );
      const headers: Record<string, string | number> = {
        "content-type": rawMime,
        "content-disposition": `${input.download || previewKind === "download" ? "attachment" : "inline"}; filename*=UTF-8''${filename}`,
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "cache-control": "no-cache",
        etag: `"${version}"`
      };
      if (mimeType === "image/svg+xml")
        headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
      let start = 0,
        end = stat.size - 1,
        status = 200;
      const ifRange = request.headers["if-range"];
      const sameRangeVersion =
        !ifRange ||
        (typeof ifRange === "string" &&
          (ifRange === headers.etag ||
            (Number.isFinite(Date.parse(ifRange)) &&
              Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ifRange) / 1000))));
      if (request.headers.range && sameRangeVersion) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
          end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        }
        if (
          !range ||
          !(range[1] || range[2]) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= stat.size
        ) {
          response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
          response.end();
          return;
        }
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
      }
      headers["content-length"] = Math.max(0, end - start + 1);
      response.writeHead(status, headers);
      if (stat.size === 0) {
        response.end();
        return;
      }
      await pipeline(handle.createReadStream({ start, end, autoClose: false }), response);
      return;
    }
    let content: string | undefined;
    let truncated = false;
    if (previewKind === "text") {
      const buffer = Buffer.alloc(Math.min(stat.size, previewBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      if (data.includes(0)) previewKind = "download";
      else {
        truncated = stat.size > bytesRead;
        // Stream decoding leaves an incomplete trailing UTF-8 codepoint out of
        // a bounded preview; the full original bytes remain downloadable.
        content = new TextDecoder().decode(data, { stream: truncated });
      }
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache"
    });
    response.end(
      JSON.stringify({
        path: input.relativePath,
        size: stat.size,
        mimeType,
        previewKind,
        content,
        truncated,
        version,
        rawUrl: `${endpoint}&raw=1`,
        downloadUrl: `${endpoint}&download=1`
      })
    );
  } finally {
    await handle.close();
  }
}

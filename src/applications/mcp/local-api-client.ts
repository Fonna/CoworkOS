import { request } from "node:http";

/** Native session authentication for owned local subprocesses; never exposed to tools or the renderer. */
export function localApiHeaders(): Record<string, string> {
  return process.env.COWORK_API_TOKEN ? { "x-atria-token": process.env.COWORK_API_TOKEN } : {};
}

/** Native HTTP avoids fetch's implicit header deadline shortening a long MCP computation. */
export function postLocalApiJson(
  url: string,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  signal?.throwIfAborted();
  const address = new URL(url);
  if (address.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))
    throw new Error("应用 API 必须使用本机 HTTP 地址");
  return new Promise((done, reject) => {
    const child = request(address, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...localApiHeaders() }
    });
    const timer = setTimeout(() => child.destroy(new Error("应用 MCP 请求超时")), timeoutMs);
    child.once("error", reject);
    child.once("close", () => clearTimeout(timer));
    child.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        done(new Response(Buffer.concat(chunks).toString("utf8"), { status: response.statusCode ?? 500 }));
      });
    });
    child.end(body);
  });
}

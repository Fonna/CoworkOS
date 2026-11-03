import { createHttpTransport, proxyEnvironment, type HttpProxyConfig } from "./http-transport.js";

/** Provider discovery is optional; a failed catalog retains the selected model. */
export async function availableModelIds(
  input: HttpProxyConfig & {
    model: string;
    baseUrl?: string;
    apiKey?: string;
  }
): Promise<string[]> {
  const fallback = [input.model];
  if (!input.baseUrl || !input.apiKey) return fallback;
  const transport = createHttpTransport(proxyEnvironment(input));
  try {
    const root = input.baseUrl.replace(/\/+$/, "");
    const response = await transport.fetch(`${root.endsWith("/v1") ? root : `${root}/v1`}/models`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error"
    });
    if (!response.ok) return fallback;
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; supported_endpoint_types?: unknown }>;
    };
    if (!Array.isArray(body.data)) return fallback;
    const ids = body.data
      .filter((entry) => {
        const endpoints = entry?.supported_endpoint_types;
        return !Array.isArray(endpoints) || endpoints.length === 0 || endpoints.includes("openai");
      })
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id));
    return [...new Set([...fallback, ...ids])];
  } catch {
    return fallback;
  } finally {
    await transport.close();
  }
}

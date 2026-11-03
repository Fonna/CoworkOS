import { Client, EnvHttpProxyAgent, Pool, fetch as proxyFetch, type Dispatcher } from "undici";
import { EventEmitter } from "node:events";
import type { ProviderStreams } from "@earendil-works/pi-ai";

export interface HttpProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

const LOCAL_BYPASS = "localhost,127.0.0.1,::1";
const PROXY_FIELDS = [
  ["httpProxy", "HTTP_PROXY", "http_proxy"],
  ["httpsProxy", "HTTPS_PROXY", "https_proxy"],
  ["noProxy", "NO_PROXY", "no_proxy"]
] as const;

/** Standard environment variables win over machine/project configuration. */
export function proxyEnvironment(
  config: HttpProxyConfig = {},
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const resolved = { ...env };
  for (const [field, upper, lower] of PROXY_FIELDS) {
    const value = config[field];
    if (value !== undefined) {
      if (typeof value !== "string" || /[\r\n\0]/.test(value))
        throw new Error(`${field} must be a single-line string`);
      if (field !== "noProxy" && value.trim()) {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new Error(`${field} must be an HTTP(S) proxy URL`);
        }
        if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
          throw new Error(`${field} must be an HTTP(S) proxy URL without a query or fragment`);
      }
      if (resolved[upper] === undefined && resolved[lower] === undefined) resolved[upper] = value;
    }
  }
  if (resolved.http_proxy || resolved.HTTP_PROXY || resolved.https_proxy || resolved.HTTPS_PROXY) {
    // Pi's interactive host installs a global dispatcher. Its trusted local
    // Dashboard/MCP traffic must stay on the machine even behind a proxy.
    const bypass = resolved.no_proxy ?? resolved.NO_PROXY;
    const entries = [
      ...new Set([...(bypass?.split(/[,\s]+/).filter(Boolean) ?? []), ...LOCAL_BYPASS.split(",")])
    ];
    resolved.NO_PROXY = entries.includes("*") ? "*" : entries.join(",");
    if (resolved.no_proxy !== undefined) resolved.no_proxy = resolved.NO_PROXY;
  }
  return resolved;
}

/** Executable hosts apply settings before constructing any model or tool. */
export function applyProxyEnvironment(config: HttpProxyConfig): void {
  const env = proxyEnvironment(config);
  for (const [, upper, lower] of PROXY_FIELDS) {
    if (env[upper] !== undefined) process.env[upper] = env[upper];
    if (env[lower] !== undefined) process.env[lower] = env[lower];
  }
}

function listen<T extends Dispatcher>(dispatcher: T): T {
  // The body reader still reports stream errors. Avoid a second unhandled
  // EventEmitter error when abort destroys a CONNECT tunnel mid-stream.
  EventEmitter.prototype.on.call(dispatcher, "error", () => {});
  return dispatcher;
}

/** One owner per session/request; no global dispatcher or private SDK path. */
export function createHttpTransport(env: NodeJS.ProcessEnv = process.env) {
  const settings = proxyEnvironment({}, env);
  const httpProxy = settings.http_proxy ?? settings.HTTP_PROXY;
  const httpsProxy = settings.https_proxy ?? settings.HTTPS_PROXY;
  proxyEnvironment({ httpProxy, httpsProxy }, {});
  const directFetch = globalThis.fetch;
  let dispatcher: EnvHttpProxyAgent | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!httpProxy && !httpsProxy) return directFetch(input, init);
    dispatcher ??= listen(
      new EnvHttpProxyAgent({
        httpProxy,
        httpsProxy,
        noProxy: settings.no_proxy ?? settings.NO_PROXY,
        proxyTunnel: true,
        clientFactory: (origin, options) => listen(new Client(origin, options)),
        factory: (origin, options) =>
          listen(
            new Pool(origin, {
              ...options,
              factory: (clientOrigin, clientOptions) => listen(new Client(clientOrigin, clientOptions))
            })
          )
      })
    );
    // Use the same Undici implementation for fetch and its dispatcher.
    try {
      return (await proxyFetch(
        input as Parameters<typeof proxyFetch>[0],
        {
          ...init,
          dispatcher
        } as Parameters<typeof proxyFetch>[1]
      )) as unknown as Response;
    } catch {
      if (init?.signal?.aborted) throw new DOMException("HTTP request cancelled", "AbortError");
      // Proxy URLs may contain credentials; never forward Undici's error cause.
      throw new TypeError("HTTP proxy fetch failed");
    }
  };
  return {
    fetch,
    async close(): Promise<void> {
      const current = dispatcher;
      dispatcher = undefined;
      await current?.destroy();
    }
  };
}

/** Apply transport outside request recording so traces retain the actual proxy fetch. */
export function withHttpTransport(
  streams: ProviderStreams,
  transport: ReturnType<typeof createHttpTransport>
): ProviderStreams {
  return {
    ...streams,
    stream: (model, context, options) =>
      streams.stream(model, context, {
        ...options,
        fetch: options?.fetch ?? transport.fetch
      }),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, {
        ...options,
        fetch: options?.fetch ?? transport.fetch
      })
  };
}

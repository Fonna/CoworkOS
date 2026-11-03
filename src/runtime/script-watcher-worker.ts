import { pathToFileURL } from "node:url";
import { fetchPublicUrl, searchPublicWeb, type ScriptWatcherContext } from "./script-watcher.js";
import type { WebToolOptions } from "../tools/web-tools.js";

process.once(
  "message",
  async (input: {
    entrypoint: string;
    watcherId: string;
    task: string;
    sources: string[];
    previousState: unknown;
    timeoutMs: number;
    web?: WebToolOptions;
  }) => {
    try {
      const module = (await import(pathToFileURL(input.entrypoint).href)) as {
        default?: (context: ScriptWatcherContext) => unknown;
        check?: (context: ScriptWatcherContext) => unknown;
      };
      const check = module.check ?? module.default;
      if (typeof check !== "function") throw new Error("watcher rule must export default or check(context)");
      let state = input.previousState;
      const context: ScriptWatcherContext = {
        ...input,
        readState: async () => state,
        writeState: async (value) => {
          state = value;
        },
        fetchUrl: (url) => fetchPublicUrl(url, input.timeoutMs),
        searchWeb: (query) => searchPublicWeb(query, input.web, input.timeoutMs)
      };
      const result = await check(context);
      const envelope = Array.isArray(result)
        ? { events: result, state }
        : { state, ...(result && typeof result === "object" ? result : {}) };
      if (Buffer.byteLength(JSON.stringify(envelope)) > 1_048_576)
        throw new Error("watcher result exceeds 1 MiB");
      process.send?.({ result: envelope });
    } catch (error) {
      process.send?.({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
    }
  }
);

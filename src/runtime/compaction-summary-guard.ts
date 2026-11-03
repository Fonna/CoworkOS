import {
  contentText,
  lazyStream,
  type AssistantMessageEvent,
  type ProviderStreams
} from "@earendil-works/pi-ai";
import { compactionSummaryContext, isNativeSummaryContext } from "./compaction-summary-policy.js";

/** Wrap outside recording so provider evidence and token usage remain unchanged. */
export function guardCompactionSummaries(streams: ProviderStreams): ProviderStreams {
  const wrap =
    (method: "stream" | "streamSimple"): ProviderStreams["streamSimple"] =>
    (model, context, options) => {
      if (!isNativeSummaryContext(context)) return streams[method](model, context, options);
      const prepared = compactionSummaryContext(context);

      return lazyStream(model, async () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
          for await (const event of streams[method](model, prepared, options)) {
            if (
              event.type === "done" &&
              event.message.stopReason === "stop" &&
              !contentText(event.message.content).trim()
            ) {
              // Preserve content, usage and provider metadata. Throwing here would
              // make lazyStream replace them with a synthetic zero-usage error.
              yield {
                type: "error",
                reason: "error",
                error: {
                  ...event.message,
                  stopReason: "error",
                  errorMessage: "Context summarization returned no non-whitespace text"
                }
              };
            } else yield event;
          }
        }
      }));
    };
  return { ...streams, stream: wrap("stream"), streamSimple: wrap("streamSimple") };
}

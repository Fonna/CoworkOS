import type { SessionBeforeCompactEvent, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CompactionFailureBackoff,
  compactionFingerprint
} from "../../dist/src/runtime/compaction-failure-backoff.js";

/** Only suppress repeated automatic requests; Pi still owns summary retries and commits. */
export class MainCompactionRetry {
  private readonly backoff: CompactionFailureBackoff;
  private active?: { fingerprint: string; signal: AbortSignal };
  private skipped = false;

  constructor(backoff = new CompactionFailureBackoff()) {
    this.backoff = backoff;
  }

  before(
    event: SessionBeforeCompactEvent,
    sessionId: string,
    model: Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl"> | undefined
  ): { cancel: true } | undefined {
    const preparation = event.preparation;
    const fingerprint = compactionFingerprint({
      sessionId,
      model: model && { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl },
      firstKeptEntryId: preparation.firstKeptEntryId,
      previousSummary: preparation.previousSummary,
      messagesToSummarize: preparation.messagesToSummarize,
      turnPrefixMessages: preparation.turnPrefixMessages,
      isSplitTurn: preparation.isSplitTurn
    });
    // The native cancellation event for a skipped request must not extend its cooldown.
    this.active = undefined;
    this.skipped = event.reason === "threshold" && this.backoff.shouldSkip(fingerprint);
    if (this.skipped) return { cancel: true };
    this.active = { fingerprint, signal: event.signal };
    return undefined;
  }

  /** True only for our cooldown cancellation, so pending manual requests remain scheduled. */
  failed(event: SessionCompactFailedEvent): boolean {
    const active = this.active;
    this.active = undefined;
    const skipped = this.skipped;
    this.skipped = false;
    if (skipped) return true;
    if (!active || event.aborted || active.signal.aborted || !event.errorMessage?.trim()) return false;
    // This hook fires only after Pi's retries for the native summary attempt settle.
    this.backoff.recordFailure(active.fingerprint);
    return false;
  }

  succeeded(): void {
    const active = this.active;
    this.active = undefined;
    this.skipped = false;
    if (active) this.backoff.recordSuccess(active.fingerprint);
  }
}

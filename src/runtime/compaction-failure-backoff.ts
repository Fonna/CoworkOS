import { createHash } from "node:crypto";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
const MAX_FAILED_INPUTS = 32;

/** Session-local cooldowns for repeated failures of the same summary input. */
export class CompactionFailureBackoff {
  private readonly failures = new Map<string, { count: number; retryAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  shouldSkip(fingerprint: string): boolean {
    const failure = this.failures.get(fingerprint);
    return failure !== undefined && this.now() < failure.retryAt;
  }

  recordFailure(fingerprint: string): void {
    const count = Math.min((this.failures.get(fingerprint)?.count ?? 0) + 1, RETRY_DELAYS_MS.length);
    this.failures.delete(fingerprint);
    this.failures.set(fingerprint, {
      count,
      retryAt: this.now() + RETRY_DELAYS_MS[count - 1]
    });
    if (this.failures.size > MAX_FAILED_INPUTS) this.failures.delete(this.failures.keys().next().value!);
  }

  recordSuccess(fingerprint: string): void {
    this.failures.delete(fingerprint);
  }
}

/** Hash stable coverage and model data; do not include a freshly generated wrapper or retained tail. */
export function compactionFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
}

import { setTimeout as delay } from "node:timers/promises";

/** Task/tool-set-local credentials, never returned in model-visible metadata. */
export class WebKeyPool {
  private readonly keys: string[];
  private cursor = 0;
  private readonly availableAt = new Map<string, number>();
  private readonly rejected = new Set<string>();

  constructor(
    keys: readonly string[],
    private readonly service: string
  ) {
    if (
      !Array.isArray(keys) ||
      keys.some((key) => typeof key !== "string" || !key.trim() || /[\r\n\0]/.test(key))
    )
      throw new Error(`${service} keys must be non-empty single-line strings`);
    this.keys = [...new Set(keys.map((key) => key.trim()))];
  }

  reject(key: string): void {
    this.rejected.add(key);
  }

  cooldown(key: string, milliseconds: number): void {
    this.availableAt.set(key, Date.now() + Math.min(60_000, Math.max(0, milliseconds)));
  }

  async acquire(signal: AbortSignal): Promise<string> {
    for (;;) {
      signal.throwIfAborted();
      let nextAvailable = Infinity;
      for (let offset = 0; offset < this.keys.length; offset++) {
        const index = (this.cursor + offset) % this.keys.length;
        const key = this.keys[index];
        if (this.rejected.has(key)) continue;
        const available = this.availableAt.get(key) ?? 0;
        if (available <= Date.now()) {
          this.cursor = (index + 1) % this.keys.length;
          return key;
        }
        nextAvailable = Math.min(nextAvailable, available);
      }
      if (nextAvailable === Infinity) throw new Error(`${this.service} has no usable configured API key`);
      await delay(Math.max(1, nextAvailable - Date.now()), undefined, { signal });
    }
  }
}

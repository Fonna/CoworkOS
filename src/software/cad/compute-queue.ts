import { CAD_COMPUTE_LIMITS } from "./compute-limits.js";

interface WaitingJob {
  start(): void;
}

interface QueueLimits {
  maxConcurrent: number;
  maxQueued: number;
  maxQueueWaitMs: number;
}

/** Waiting has its own deadline; admitted jobs receive their full compute budget. */
export class CadComputeQueue {
  private running = 0;
  private readonly waiting: WaitingJob[] = [];

  constructor(private readonly limits: QueueLimits = CAD_COMPUTE_LIMITS) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.running < this.limits.maxConcurrent) {
      this.running++;
      return this.lease();
    }
    if (this.waiting.length >= this.limits.maxQueued)
      throw new Error("CAD 计算队列已满，请稍后重试；源码已保留");
    return new Promise<() => void>((resolve, reject) => {
      const remove = () => {
        const index = this.waiting.indexOf(job);
        if (index >= 0) this.waiting.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        remove();
        reject(new Error("CAD 计算已取消；源码已保留"));
      };
      const job = {
        start: () => {
          remove();
          resolve(this.lease());
        }
      };
      const timer = setTimeout(() => {
        remove();
        reject(new Error("CAD 计算排队超时，请稍后重试；源码已保留"));
      }, this.limits.maxQueueWaitMs);
      this.waiting.push(job);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private lease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.start();
      else this.running--;
    };
  }
}

import {
  CoordinatorRuntime,
  type CoordinatorRecoveryInput,
  type SubagentDispatchResult
} from "./coordinator-runtime.js";

export interface WorkerOptions extends CoordinatorRecoveryInput {
  pollMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  onCycle?: (results: SubagentDispatchResult[]) => void | Promise<void>;
}

/**
 * Independent recovery/dispatch loop for a Task Run. Main does not need to
 * remain alive: the Worker periodically reclaims expired leases and lets the
 * Coordinator atomically claim queued work. Multiple Workers are safe because
 * the queue claim is protected by the durable file lock.
 */
export class CoordinatorWorker {
  private stopped = false;
  private readonly coordinator: CoordinatorRuntime;

  constructor(coordinator = new CoordinatorRuntime()) {
    this.coordinator = coordinator;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(input: WorkerOptions): Promise<void> {
    const pollMs = Math.max(250, input.pollMs ?? 2_000);
    while (!this.stopped && !input.signal?.aborted) {
      const results = await this.coordinator.recoverRun(input);
      await input.onCycle?.(results);
      if (input.once) return;
      await wait(pollMs, input.signal);
    }
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

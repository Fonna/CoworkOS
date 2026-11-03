/**
 * Periodic polls share the pending refresh; user refreshes replace a stale read.
 * A deliberate `follow` survives coalescing.
 */
export function createTabRefresh({ read, apply, onError }) {
  let pending;
  let requested = false;
  let followNext = false;

  async function drain() {
    while (requested) {
      requested = false;
      const follow = followNext;
      followNext = false;
      try {
        const result = await read();
        if (requested) {
          followNext ||= follow;
          continue;
        }
        await apply(result, { follow });
      } catch (error) {
        if (requested) {
          followNext ||= follow;
          continue;
        }
        await onError?.(error);
      }
    }
  }

  return function refresh({ follow = false, poll = false } = {}) {
    // A slow read still represents the latest poll. Superseding it every tick
    // would discard every response when the server is slower than the interval.
    if (poll && pending) return pending;
    requested = true;
    followNext ||= follow;
    pending ??= drain().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

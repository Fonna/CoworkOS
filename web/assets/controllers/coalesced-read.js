/** One read per key, with one follow-up for mutations arriving mid-read. */
export function createCoalescedRead(read) {
  const pending = new Map();
  return function request(key, { poll = false } = {}) {
    const current = pending.get(key);
    if (current) {
      if (!poll) current.again = true;
      return current.promise;
    }
    const entry = { again: false, promise: undefined };
    pending.set(key, entry);
    entry.promise = (async () => {
      let nextPoll = poll;
      try {
        do {
          entry.again = false;
          await read(key, { poll: nextPoll, isCurrent: () => !entry.again });
          nextPoll = false;
        } while (entry.again);
      } finally {
        pending.delete(key);
      }
    })();
    return entry.promise;
  };
}

/** Per-window backoff; foreground changes and explicit actions bypass it. */
export function createRevisionSchedule({ now = () => Date.now() } = {}) {
  const entries = new Map();
  let foreground;
  return {
    due(tabs, activeId, force = false) {
      const ids = new Set(tabs.map((tab) => tab.appInstanceId));
      for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
      if (foreground !== activeId) {
        foreground = activeId;
        if (entries.has(activeId)) entries.get(activeId).next = 0;
      }
      return [...ids].filter((id) => force || !entries.has(id) || entries.get(id).next <= now());
    },
    observe(id, version) {
      const previous = entries.get(id);
      const base = id === foreground ? 500 : 5000;
      const delay =
        previous?.version === version
          ? Math.min(Math.max(base, previous.delay * 2), id === foreground ? 4000 : 15000)
          : base;
      entries.set(id, { version, delay, next: now() + delay });
    },
    invalidate(id) {
      if (entries.has(id)) entries.get(id).next = 0;
    }
  };
}

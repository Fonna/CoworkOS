/** One debounced edit, addressed in UTF-16 units like the runtime adapter.
 * @param {string} before @param {string} after
 */
export function minimalReplace(before, after) {
  if (before === after) return null;
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix])
    suffix += 1;
  return { from: prefix, to: before.length - suffix, text: after.slice(prefix, after.length - suffix) };
}

/** Decide against the old baseline, before a remote read replaces it.
 * @param {{loaded: boolean, draftContent: string, serverContent: string, discardDraft?: boolean}} input
 */
export function shouldKeepDraft({ loaded, draftContent, serverContent, discardDraft = false }) {
  return !discardDraft && loaded && draftContent !== serverContent;
}

export function operationId() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `op_${String(random).replace(/-/g, "").slice(0, 32)}`;
}

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

// Poll twice at the requested Harness cadence before accepting new content.
const CONFIG = { stableChecks: 2, maxBytes: 1_048_576 };
export default createWatcher(CONFIG);

export function createWatcher({ stableChecks = 2, maxBytes = 1_048_576 } = {}) {
  return async function check(context) {
    if (
      !Number.isSafeInteger(stableChecks) ||
      stableChecks < 1 ||
      stableChecks > 100 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 16_777_216
    )
      throw new Error("invalid resource configuration");
    const source = context.sources[0];
    if (typeof source !== "string" || source.length > 512 || !isAbsolute(source))
      throw new Error("resource path must be absolute and <= 512 characters");
    let snapshot = { version: "missing", observation: "missing", bytes: 0 };
    let handle;
    try {
      if (!(await stat(source)).isFile()) throw new Error("resource is not a regular file");
      handle = await open(source, "r");
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("resource is not a regular file");
      if (before.size > maxBytes) throw new Error("resource exceeds maxBytes");
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const { bytesRead } = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
      }
      const after = await handle.stat();
      if (
        bytes > maxBytes ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytes !== after.size
      ) {
        throw new Error("resource changed during observation or exceeds maxBytes");
      }
      snapshot = {
        version: hash(buffer.subarray(0, bytes)),
        observation: `${after.size}:${after.mtimeMs}`,
        bytes
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
    const key = hash(JSON.stringify([source, stableChecks, maxBytes]));
    const previous = context.previousState?.key === key ? context.previousState : undefined;
    const candidate = `${snapshot.version}:${snapshot.observation}`;
    const state = {
      key,
      accepted: previous?.accepted ?? snapshot.version,
      candidate,
      count: previous?.candidate === candidate ? Math.min(stableChecks, previous.count + 1) : 1,
      sequence: previous?.sequence ?? 0
    };
    if (!previous || snapshot.version === state.accepted || state.count < stableChecks)
      return { events: [], state };
    const oldVersion = state.accepted;
    state.accepted = snapshot.version;
    const type =
      snapshot.version === "missing"
        ? "resource.deleted"
        : oldVersion === "missing"
          ? "resource.created"
          : "resource.changed";
    return {
      events: [
        {
          source,
          type,
          priority: 2,
          dedupeKey: hash(`${key}:${++state.sequence}`),
          payload: {
            path: source,
            previousVersion: oldVersion,
            version: snapshot.version,
            bytes: snapshot.bytes
          }
        }
      ],
      state
    };
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

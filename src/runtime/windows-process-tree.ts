import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const pending = new WeakMap<ChildProcess, Promise<void>>();

/** Stop the owned live root and its descendants before the root's identity is lost. */
export function terminateWindowsProcessTree(child: ChildProcess): Promise<void> {
  const existing = pending.get(child);
  if (existing) return existing;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const operation = (async () => {
    try {
      await execute(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 10000 }
      );
    } catch {
      // A natural exit may race taskkill. Never target the old PID again.
      if (child.exitCode === null && child.signalCode === null)
        throw new Error("Unable to terminate the owned Windows process tree");
    }
  })();
  pending.set(child, operation);
  return operation;
}

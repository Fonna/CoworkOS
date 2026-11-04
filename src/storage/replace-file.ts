import { rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Atomic replacement, allowing bounded transient Windows sharing conflicts. */
export async function replaceFile(temporary: string, path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      // Never unlink the destination: readers must see a complete old/new file.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt >= 8)
        throw error;
      await delay(Math.min(10 * 2 ** attempt, 100));
    }
  }
}

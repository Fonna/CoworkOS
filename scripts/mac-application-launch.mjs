import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, resolve } from "node:path";

const run = promisify(execFile);

export async function launchMacApplication(executable, { args = [], env = process.env, cwd } = {}) {
  const bundle = resolve(executable, "../../..");
  if (
    !isAbsolute(executable) ||
    !bundle.endsWith(".app") ||
    dirname(executable) !== join(bundle, "Contents/MacOS")
  )
    throw new Error("Mac App 入口必须是应用包内的绝对可执行路径。");
  // Direct exec inherits Terminal/IDE TCC responsibility even when detached.
  // LaunchServices gives the App its own identity and passes env to that instance.
  // Use the exact bundle path: multiple worktrees share the development bundle ID.
  try {
    await run("/usr/bin/open", ["-n", "-a", bundle, "--args", ...args], { env, cwd, timeout: 30_000 });
  } catch {
    throw new Error("macOS 未能启动 App，请检查应用入口后重试。");
  }
}

import {
  packagedComponentDirectory,
  selectedComponentDirectory,
  componentDisabled
} from "../components/paths.js";
import { spawn, execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { blenderRuntimeDirectory } from "./runtime-path.js";
import { invalid, record } from "./model.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runner = fileURLToPath(new URL("./runner.py", import.meta.url));
const active = new Set<number>();
const kill = (pid: number, signal: NodeJS.Signals = "SIGKILL") => {
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
};
process.once("exit", () => {
  for (const pid of active) kill(pid);
});
export async function blenderExecutable(): Promise<string> {
  if (componentDisabled("blender")) throw invalid("Blender 组件已停用；请在设置的应用组件中启用");
  const selected = selectedComponentDirectory("blender");
  const packaged = packagedComponentDirectory("blender");
  const candidates = process.env.COWORK_BLENDER_EXECUTABLE
    ? [resolve(process.env.COWORK_BLENDER_EXECUTABLE)]
    : packaged
      ? [join(packaged, "Blender.app/Contents/MacOS/Blender")]
      : [
          ...(selected ? [join(selected, "Blender.app/Contents/MacOS/Blender")] : []),
          join(blenderRuntimeDirectory(), "Blender.app/Contents/MacOS/Blender"),
          join(root, ".tools/blender-runtime/Blender.app/Contents/MacOS/Blender"),
          join(root, ".tools/blender-runtime/Blender.app/Contents/MacOS/blender"),
          "/Applications/Blender.app/Contents/MacOS/Blender",
          "/Applications/Blender.app/Contents/MacOS/blender"
        ];
  for (const path of candidates) {
    try {
      await access(path, 1);
      return await realpath(path);
    } catch {
      /* try next installation */
    }
  }
  throw invalid("Blender 内置组件暂不可用，请在设置的应用组件中启用或修复安装");
}
export async function blenderStatus(): Promise<{
  available: boolean;
  executable?: string;
  message?: string;
}> {
  if (process.platform !== "darwin") return { available: false, message: "Blender 执行隔离目前支持 macOS" };
  try {
    return { available: true, executable: await blenderExecutable() };
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : String(error) };
  }
}
/** Native bpy executes only inside an OS-isolated job, never the Node process or user's Blender. */
export async function runBlender<T>(
  request: Record<string, unknown>,
  timeoutMs: number,
  consume: (directory: string, result: Record<string, unknown>) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  if (process.platform !== "darwin") throw invalid("Blender 执行隔离目前支持 macOS");
  const executable = await blenderExecutable();
  const runtime = await realpath(dirname(dirname(executable)));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atria-blender-")));
  const quote = (value: string) => JSON.stringify(value);
  const profile = `(version 1)
    (deny default)
    (allow process-exec (literal ${quote(executable)}))
    (allow sysctl-read)
    (allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo")
      (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent")
      (global-name "com.apple.PowerManagement.control") (global-name "com.apple.trustd.agent")
      (global-name "com.apple.CoreServices.coreservicesd") (global-name "com.apple.MTLCompilerService"))
    (allow iokit-get-properties)
    (allow iokit-open (iokit-user-client-class "IOGPUDeviceUserClient") (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOAccelerationUserClient"))
    (allow file-read-metadata)
    (allow file-read* (literal "/") (subpath ${quote(runtime)}) (literal ${quote(runner)}) (subpath ${quote(directory)})
      (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System/Library") (subpath "/Library/Apple") (subpath "/Library/Fonts")
      (subpath "/System/Cryptexes") (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/private/var/db/dyld")
      (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
    (allow file-write* (subpath ${quote(directory)}) (literal "/dev/null"))`;
  try {
    // The caller supplies native bytes through a checked read; paths never enter Python from model input.
    const input = request.inputBlend;
    if (input instanceof Uint8Array) await writeFile(join(directory, "input.blend"), input);
    const wire = { ...request, inputBlend: input instanceof Uint8Array, directory };
    await writeFile(join(directory, "request.json"), JSON.stringify(wire));
    const result = await new Promise<Record<string, unknown>>((done, reject) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          executable,
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--threads",
          "2",
          "--python-exit-code",
          "1",
          "--python",
          runner,
          "--",
          join(directory, "request.json")
        ],
        {
          cwd: directory,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            TMPDIR: directory,
            BLENDER_USER_RESOURCES: directory,
            LANG: "en_US.UTF-8",
            OMP_NUM_THREADS: "2"
          }
        }
      );
      if (child.pid) active.add(child.pid);
      let log = "",
        failure: Error | undefined,
        sampling = false;
      const stop = (message: string) => {
        failure ??= invalid(message);
        if (child.pid) kill(child.pid);
      };
      const abort = () => stop("Blender 任务已取消，已保存工程未改变");
      const timer = setTimeout(() => stop("Blender 任务超时，已保存工程未改变"), timeoutMs);
      const memory = setInterval(() => {
        if (sampling || !child.pid) return;
        sampling = true;
        execFile("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (_error, output) => {
          sampling = false;
          if (child.exitCode === null && child.signalCode === null && Number(output.trim()) > 2 * 1024 * 1024)
            stop("Blender 超出 2 GiB 内存预算");
        });
      }, 1000);
      const output = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-16_384);
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", async (code, exitSignal) => {
        clearTimeout(timer);
        clearInterval(memory);
        signal?.removeEventListener("abort", abort);
        if (child.pid) {
          active.delete(child.pid);
          kill(child.pid);
        }
        if (failure) {
          reject(failure);
          return;
        }
        try {
          const response = record(
            JSON.parse(await readJobFile(directory, "result.json", 2_000_000).then((b) => b.toString("utf8")))
          );
          if (code !== 0 || response.ok !== true)
            throw invalid(
              `Blender 执行失败：${response.error ?? exitSignal ?? code}${typeof response.diagnostics === "string" ? `\n${response.diagnostics.slice(0, 4096)}` : ""}`
            );
          done(record(response.result));
        } catch (error) {
          const crash = await readJobFile(directory, "blender.crash.txt", 1_000_000)
            .then((b) => b.toString().slice(0, 6000))
            .catch(() => "");
          reject(
            error instanceof Error && error.message.includes("Blender 执行失败")
              ? error
              : invalid(`Blender 进程失败 (${exitSignal ?? code})：${log.slice(-4096)}${crash}`)
          );
        }
      });
    });
    signal?.throwIfAborted();
    return await consume(directory, result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function readJobFile(directory: string, name: string, maxBytes: number): Promise<Buffer> {
  const path = join(directory, name),
    info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes)
    throw invalid(`Blender 输出 ${name} 无效或超过预算`);
  return await readFile(path);
}

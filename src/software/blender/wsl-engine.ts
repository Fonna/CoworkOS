import { execFile, spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { invalid, record } from "./model.js";

const execute = promisify(execFile);
const broker = fileURLToPath(new URL("../../security/wsl-blender-job.py", import.meta.url));
const runner = fileURLToPath(new URL("./runner.py", import.meta.url));

function configuration() {
  const distro = process.env.COWORK_BLENDER_WSL_DISTRO;
  const executable = process.env.COWORK_BLENDER_WSL_EXECUTABLE;
  if (!distro || !executable || /[\0\r\n]/.test(distro + executable) || !executable.startsWith("/"))
    throw invalid(
      "Windows Blender 需要配置 COWORK_BLENDER_WSL_DISTRO 和 Linux 绝对路径 COWORK_BLENDER_WSL_EXECUTABLE"
    );
  return { distro, executable };
}

async function linuxPath(distro: string, path: string): Promise<string> {
  const { stdout } = await execute("wsl.exe", ["-d", distro, "--exec", "/usr/bin/wslpath", "-u", path], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 64_000
  });
  const converted = stdout.trim();
  if (!converted.startsWith("/") || /[\0\r\n]/.test(converted)) throw invalid("WSL 文件路径转换失败");
  return converted;
}

export async function wslBlenderStatus(): Promise<{
  available: boolean;
  executable?: string;
  version?: string;
  message?: string;
}> {
  try {
    const { distro, executable } = configuration();
    const script = await linuxPath(distro, broker);
    const { stdout } = await execute(
      "wsl.exe",
      ["-d", distro, "--exec", "/usr/bin/python3", script, "--runtime", executable, "--probe"],
      { timeout: 20_000, windowsHide: true, maxBuffer: 64_000 }
    );
    const status = record(JSON.parse(stdout));
    if (status.available !== true) throw invalid("WSL Blender 隔离执行器未就绪");
    return {
      available: true,
      executable,
      version: typeof status.version === "string" ? status.version : undefined
    };
  } catch (error) {
    return { available: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runWslBlender<T>(
  request: Record<string, unknown>,
  timeoutMs: number,
  consume: (directory: string, result: Record<string, unknown>) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const { distro, executable } = configuration();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cowork-wsl-blender-")));
  try {
    const [script, job] = await Promise.all([linuxPath(distro, broker), linuxPath(distro, directory)]);
    const input = request.inputBlend;
    if (input instanceof Uint8Array) await writeFile(join(directory, "input.blend"), input);
    await copyFile(runner, join(directory, "runner.py"));
    await writeFile(
      join(directory, "request.json"),
      JSON.stringify({ ...request, inputBlend: input instanceof Uint8Array, directory: "/job" })
    );
    signal?.throwIfAborted();
    await new Promise<void>((done, reject) => {
      const child = spawn(
        "wsl.exe",
        [
          "-d",
          distro,
          "--exec",
          "/usr/bin/python3",
          script,
          "--runtime",
          executable,
          "--directory",
          job,
          "--timeout",
          String(timeoutMs / 1000)
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
      let output = "",
        failure: Error | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const stop = (message: string) => {
        if (failure) return;
        failure = invalid(message);
        // Closing the owned pipe asks the Linux broker to kill its namespace and wait for exit.
        child.stdin.end();
        forced = setTimeout(() => child.kill(), 5_000);
      };
      const abort = () => stop("Blender 任务已取消，已保存工程未改变");
      const deadline = setTimeout(() => stop("Blender 任务超时，已保存工程未改变"), timeoutMs + 15_000);
      child.stdin.on("error", () => {});
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-16_384);
        });
      child.once("error", (error) => {
        failure ??= error;
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("close", (code) => {
        clearTimeout(deadline);
        clearTimeout(forced);
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(invalid(`Blender 隔离执行失败 (${code})：${output.slice(-4096)}`));
        else done();
      });
    });
    signal?.throwIfAborted();
    const file = join(directory, "result.json"),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 2_000_000)
      throw invalid("Blender 输出无效或超过预算");
    const response = record(JSON.parse(await readFile(file, "utf8")));
    if (response.ok !== true) throw invalid(`Blender 执行失败：${String(response.error)}`);
    return await consume(directory, record(response.result));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

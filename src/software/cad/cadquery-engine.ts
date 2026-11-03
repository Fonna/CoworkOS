import { existsSync } from "node:fs";
import { selectedComponentDirectory, componentDisabled } from "../components/paths.js";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProgram, type CadProgram } from "./program.js";
import { validateGeometry, type ProgramGeometry } from "./program-geometry.js";
import { CAD_COMPUTE_LIMITS, CADQUERY_RUNNER_FILE, computeBudget } from "./compute-limits.js";

const active = new Set<number>();
const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
process.once("exit", () => {
  for (const pid of active) killGroup(pid);
});
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const runner = fileURLToPath(new URL(CADQUERY_RUNNER_FILE, import.meta.url));
export const cadQueryPython = () =>
  componentDisabled("cadquery")
    ? ""
    : process.env.COWORK_CADQUERY_PYTHON ||
      (selectedComponentDirectory("cadquery")
        ? join(selectedComponentDirectory("cadquery")!, "bin/python3")
        : existsSync(join(root, ".tools/cadquery-runtime/bin/python3"))
          ? join(root, ".tools/cadquery-runtime/bin/python3")
          : "");
const quoted = (value: string) => JSON.stringify(value);

/** Native Python is never treated as a language sandbox. Fail closed without OS isolation. */
async function launch(request: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
  computeBudget(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  signal?.throwIfAborted();
  if (process.platform !== "darwin")
    throw new Error("CadQuery 原生内核目前支持 macOS；其他平台请使用 JSCAD，等待对应进程隔离适配");
  if (!cadQueryPython()) throw new Error("CadQuery 运行时未安装或已停用；请在设置的应用组件中启用或修复安装");
  const python = resolve(cadQueryPython());
  let runtime: string;
  try {
    runtime = dirname(dirname(await realpath(python)));
  } catch {
    throw new Error("CadQuery 内置运行时缺失，请在设置的应用组件中修复安装");
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atria-cadquery-")));
  try {
    // Allow only the runtime, job directory, runner and OS libraries. No user/workspace reads,
    // network, arbitrary executables, or inherited provider credentials.
    const profile = `(version 1)
    (deny default)
    (allow process-exec (literal ${quoted(python)}) (literal ${quoted(await realpath(python))}))
    (allow sysctl-read)
    (allow file-read-metadata)
    (allow file-read* (literal "/") (subpath ${quoted(runtime)}) (subpath ${quoted(dirname(dirname(python)))})
      (literal ${quoted(runner)}) (subpath ${quoted(directory)})
      (subpath "/usr/lib") (subpath "/System/Library") (subpath "/Library/Apple")
      (subpath "/System/Cryptexes") (subpath "/System/Volumes/Preboot/Cryptexes")
      (subpath "/private/var/db/dyld") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
    (allow file-write* (subpath ${quoted(directory)}) (literal "/dev/null"))`;
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("CAD 计算超时；源码已保留，可增加预算重试");
    const result = await new Promise<Record<string, unknown>>((resolveJob, reject) => {
      const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, python, "-I", "-B", runner], {
        cwd: directory,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: directory,
          TMPDIR: directory,
          LANG: "en_US.UTF-8",
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
          MPLCONFIGDIR: directory
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true
      });
      if (child.pid) active.add(child.pid);
      const chunks: Buffer[] = [];
      let bytes = 0,
        diagnostics = "",
        failure: Error | undefined;
      const stop = (message: string) => {
        failure ??= new Error(message);
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      };
      const abort = () => stop("CAD 计算已取消；源码已保留");
      let sampling = false;
      const memory = setInterval(() => {
        if (sampling || !child.pid) return;
        sampling = true;
        execFile("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000 }, (_error, output) => {
          sampling = false;
          if (
            child.exitCode === null &&
            child.signalCode === null &&
            Number(output.trim()) * 1024 > CAD_COMPUTE_LIMITS.nativeMemoryBytes
          )
            stop("CadQuery 原生内核超出 2 GiB 内存预算；源码已保留");
        });
      }, 500);
      const timer = setTimeout(
        () => stop("CAD 计算超时；源码已保留，可增加预算重试"),
        Math.max(1, deadline - Date.now())
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > CAD_COMPUTE_LIMITS.maxResultBytes)
          stop("CAD 计算结果超过传输预算；候选未提交，已保存设计保持不变");
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (diagnostics.length < 4096) diagnostics += chunk.toString().slice(0, 4096 - diagnostics.length);
      });
      child.stdin.on("error", () => {
        /* exit reports the failure */
      });
      child.on("error", (error) => {
        failure = error;
      });
      child.once("close", (code, exitSignal) => {
        if (child.pid) {
          active.delete(child.pid);
          killGroup(child.pid);
        }
        clearTimeout(timer);
        clearInterval(memory);
        signal?.removeEventListener("abort", abort);
        if (failure) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          reject(new Error(`CadQuery 进程失败 (${exitSignal || code})：${diagnostics || "原生内核退出"}`));
          return;
        }
        try {
          const output = Buffer.concat(chunks);
          chunks.length = 0;
          const wire = JSON.parse(output.toString("utf8"));
          if (wire.ok !== true)
            throw new Error(
              `CadQuery ${wire.line ? `第 ${wire.line} 行：` : ""}${wire.error}${diagnostics.trim() ? `\n建模诊断：${diagnostics.trim()}` : ""}`
            );
          resolveJob({ ...wire.result, ...(diagnostics.trim() ? { diagnostics: diagnostics.trim() } : {}) });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ ...request, timeoutMs: remaining, limits: CAD_COMPUTE_LIMITS }));
    });
    if (request.operation === "step" || request.operation === "stl") {
      const path = join(directory, `model.${request.operation}`);
      const info = await stat(path);
      if (!info.isFile() || info.size < 1 || info.size > CAD_COMPUTE_LIMITS.maxExportBytes)
        throw new Error("导出文件超过预算或为空");
      return { ...result, body: await readFile(path) };
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function evaluateCadQuery(
  program: CadProgram,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProgramGeometry> {
  const result = await launch({ operation: "mesh", program: normalizeProgram(program) }, timeoutMs, signal);
  const geometry = validateGeometry(result);
  if (geometry.features.length || result.brep !== undefined) geometry.brep = validateBrep(result.brep);
  return geometry;
}
function validateBrep(value: unknown): NonNullable<ProgramGeometry["brep"]> {
  const info = value as NonNullable<ProgramGeometry["brep"]>;
  if (
    !info ||
    info.valid !== true ||
    info.engine !== "cadquery" ||
    typeof info.version !== "string" ||
    !Number.isInteger(info.solids) ||
    info.solids < 1 ||
    !Number.isInteger(info.faces) ||
    info.faces < 1 ||
    !Array.isArray(info.bounds) ||
    info.bounds.length !== 2 ||
    !info.bounds.every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))
  )
    throw new Error("无效精确实体诊断");
  return info;
}
export async function exportCadQuery(
  program: CadProgram,
  format: "step" | "stl",
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const result = await launch({ operation: format, program: normalizeProgram(program) }, timeoutMs, signal);
  validateBrep(result.brep);
  return result.body as Uint8Array;
}
export async function cadQueryReference(module?: string, member?: string): Promise<Record<string, unknown>> {
  return launch({ operation: "api", module, member }, 20_000);
}

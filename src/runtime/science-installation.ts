import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWrite } from "../applications/fs-utils.js";
import { withFileLock } from "../storage/file-lock.js";
import { ProcessHost } from "./process-host.js";
import { validScienceExecutable, type ScienceEnvironmentTarget } from "./science-environment.js";

export const SCIENCE_INSTALLATION_SPECS = {
  general: { version: "atria-science-general-v1", packages: ["numpy==2.2.6", "scipy==1.15.3"] },
  chemistry: {
    version: "atria-science-chemistry-v1",
    packages: ["rdkit==2026.9.1", "numpy==2.2.6", "Pillow==11.3.0"]
  }
} as const;

type InstallationState = "absent" | "installing" | "ready" | "failed" | "cancelled" | "interrupted";
type InstallationPhase =
  "validating_python" | "creating_venv" | "installing_dependencies" | "checking_environment";
export interface ScienceInstallationStatus {
  target: ScienceEnvironmentTarget;
  state: InstallationState;
  specVersion: string;
  installedPython?: string;
  operationId?: string;
  phase?: InstallationPhase;
  startedAt?: string;
  updatedAt?: string;
  error?: { code: string; message: string };
}
interface Operation extends ScienceInstallationStatus {
  version: 1;
  operationId: string;
  sourcePython: string;
  owner: { pid: number; host: string };
}
interface ReadyReference {
  version: 1;
  generation: string;
  specVersion: string;
  sourcePython: string;
}
export class ScienceInstallationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ScienceInstallationError";
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const pause = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));
function targetValue(value: unknown): asserts value is ScienceEnvironmentTarget {
  if (value !== "general" && value !== "chemistry")
    throw new ScienceInstallationError(400, "invalid_arguments", "请选择基础或 RDKit 环境");
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function jsonFile(path: string): Promise<unknown> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.length <= 64 * 1024 ? JSON.parse(raw) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Resolve the host selection without passing its PATH into installation workers. */
async function resolveSourcePython(command: string): Promise<string> {
  // Node already uses the host PATH for Windows lookup when the child has none.
  if (isAbsolute(command) || process.platform === "win32") return command;
  const cwd = process.cwd();
  const folders = (process.env.PATH ?? "/usr/bin:/bin").split(delimiter);
  for (const folder of folders) {
    const candidate = resolve(cwd, folder, command);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      // Keep symlinks: resolving a venv interpreter's realpath changes sys.prefix.
      return candidate;
    } catch {
      /* Continue past missing, inaccessible or non-executable PATH entries. */
    }
  }
  throw new ScienceInstallationError(
    400,
    "python_unavailable",
    "无法启动所选 Python，请先安装 Python 3.10+ 并选择有效解释器"
  );
}

const WATCHDOG = `
import os,signal,sys,threading,time
parent=int(sys.argv[1])
def watch():
    if os.name == "nt":
        import ctypes
        kernel=ctypes.windll.kernel32
        kernel.OpenProcess.restype=ctypes.c_void_p
        handle=kernel.OpenProcess(0x00100000,False,parent)
        if not handle: os._exit(125)
        while True:
            time.sleep(0.2)
            if kernel.WaitForSingleObject(ctypes.c_void_p(handle),0) != 258: os._exit(125)
    while True:
        time.sleep(0.2)
        if os.getppid() != parent: os.killpg(os.getpgrp(),signal.SIGKILL)
threading.Thread(target=watch,daemon=True).start()
`;
const HOST_CHECK = `# ATRIA_SCIENCE_HOST
${WATCHDOG}
import json,sys
print(json.dumps({"version":list(sys.version_info[:3])}))
`;
// Python's venv scripts contain absolute paths. Never move a completed venv.
// Every worker stops its process group if the installing application dies.
const SUPERVISED_MODULE = `# ATRIA_SCIENCE_MODULE
${WATCHDOG}
import runpy
module=sys.argv[2]
sys.argv=[module]+sys.argv[3:]
runpy.run_module(module,run_name="__main__",alter_sys=True)
`;
const VERIFY = `# ATRIA_SCIENCE_VERIFY
${WATCHDOG}
import json,math,sys
target=sys.argv[2]
if sys.prefix == sys.base_prefix: raise RuntimeError("A virtual environment is required")
import numpy
versions={"numpy":numpy.__version__}
if target == "general":
    import scipy
    from scipy.signal import find_peaks
    versions["scipy"]=scipy.__version__
    if find_peaks(numpy.array([0.,1.,0.]))[0].tolist() != [1]: raise RuntimeError("Peak self-test failed")
    fit=numpy.polyfit([0.,1.,2.],[1.,3.,5.],1)
    if not numpy.allclose(fit,[2.,1.],rtol=0,atol=1e-10): raise RuntimeError("Array self-test failed")
else:
    import PIL,rdkit
    from rdkit import Chem
    from rdkit.Chem import Descriptors
    versions.update({"rdkit":rdkit.__version__,"Pillow":PIL.__version__})
    molecule=Chem.MolFromSmiles("OCC")
    if molecule is None or Chem.MolToSmiles(molecule) != "CCO" or abs(Descriptors.MolWt(molecule)-46.069)>0.001:
        raise RuntimeError("RDKit self-test failed")
print(json.dumps({"version":list(sys.version_info[:3]),"versions":versions},allow_nan=False))
`;

/** Explicit installation only. Reading status never creates directories or executes Python. */
export function createScienceInstallation(options: {
  root: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
}) {
  const root = resolve(options.root);
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (
    !isAbsolute(options.root) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60 * 60_000 ||
    !Number.isSafeInteger(probeTimeoutMs) ||
    probeTimeoutMs < 1 ||
    probeTimeoutMs > 60_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16 * 1024 * 1024
  )
    throw new Error("Invalid scientific installation limits or root");
  const local = new Map<
    ScienceEnvironmentTarget,
    { controller: AbortController; done: Promise<void>; started: Promise<void>; operationId?: string }
  >();
  const terminalFailures = new Map<
    ScienceEnvironmentTarget,
    { operationId: string; updatedAt: string; error: { code: string; message: string } }
  >();
  let stopping = false;
  const directory = (target: ScienceEnvironmentTarget) => join(root, target);
  const operationPath = (target: ScienceEnvironmentTarget) => join(directory(target), "operation.json");
  const generationPath = (target: ScienceEnvironmentTarget, generation: string) =>
    join(directory(target), "generations", generation);
  const pythonPath = (target: ScienceEnvironmentTarget, generation: string) =>
    join(
      generationPath(target, generation),
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python"
    );
  const cancelPath = (target: ScienceEnvironmentTarget, id: string) =>
    join(directory(target), `cancel-${id}.json`);
  async function contained(path: string) {
    const [canonicalRoot, canonical] = await Promise.all([realpath(root), realpath(path)]);
    const relation = relative(canonicalRoot, canonical);
    if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`))
      throw new Error("Scientific environment directory escapes its managed root");
  }

  async function operation(target: ScienceEnvironmentTarget): Promise<Operation | undefined> {
    const value = await jsonFile(operationPath(target));
    if (
      !record(value) ||
      value.version !== 1 ||
      value.target !== target ||
      typeof value.operationId !== "string" ||
      !uuid.test(value.operationId) ||
      typeof value.sourcePython !== "string" ||
      !validScienceExecutable(value.sourcePython) ||
      !record(value.owner) ||
      !Number.isSafeInteger(value.owner.pid) ||
      Number(value.owner.pid) < 1 ||
      typeof value.owner.host !== "string" ||
      value.specVersion !== SCIENCE_INSTALLATION_SPECS[target].version ||
      !["installing", "ready", "failed", "cancelled", "interrupted"].includes(String(value.state))
    )
      return undefined;
    return value as unknown as Operation;
  }
  async function ready(target: ScienceEnvironmentTarget): Promise<ReadyReference | undefined> {
    const value = await jsonFile(join(directory(target), "ready.json"));
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.generation !== "string" ||
      !uuid.test(value.generation) ||
      value.specVersion !== SCIENCE_INSTALLATION_SPECS[target].version ||
      typeof value.sourcePython !== "string"
    )
      return undefined;
    try {
      await contained(generationPath(target, value.generation));
      if (!(await stat(pythonPath(target, value.generation))).isFile()) return undefined;
      return value as unknown as ReadyReference;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function oneStatus(target: ScienceEnvironmentTarget): Promise<ScienceInstallationStatus> {
    const [current, installed] = await Promise.all([operation(target), ready(target)]);
    const terminal = terminalFailures.get(target);
    const failedLocally =
      current?.state === "installing" &&
      terminal?.operationId === current.operationId &&
      current.owner.pid === process.pid &&
      current.owner.host === hostname();
    const base = {
      target,
      specVersion: SCIENCE_INSTALLATION_SPECS[target].version,
      ...(installed ? { installedPython: pythonPath(target, installed.generation) } : {})
    };
    if (!current) return { ...base, state: installed ? "ready" : "absent" };
    const interrupted =
      current.state === "installing" && current.owner.host === hostname() && !alive(current.owner.pid);
    const missing = current.state === "ready" && !installed;
    return {
      ...base,
      state: failedLocally ? "failed" : interrupted ? "interrupted" : missing ? "failed" : current.state,
      operationId: current.operationId,
      ...(current.phase && current.state === "installing" && !interrupted && !failedLocally
        ? { phase: current.phase }
        : {}),
      ...(typeof current.startedAt === "string" ? { startedAt: current.startedAt } : {}),
      ...(typeof current.updatedAt === "string" ? { updatedAt: current.updatedAt } : {}),
      ...(failedLocally
        ? { updatedAt: terminal.updatedAt, error: terminal.error }
        : interrupted
          ? { error: { code: "interrupted", message: "安装进程已结束，请重新安装；已有可用环境仍保留" } }
          : missing
            ? { error: { code: "environment_missing", message: "已发布环境的解释器不存在，请重新安装" } }
            : current.error &&
                typeof current.error.code === "string" &&
                typeof current.error.message === "string"
              ? { error: { code: current.error.code, message: current.error.message } }
              : {})
    };
  }
  const status = async () => ({
    general: await oneStatus("general"),
    chemistry: await oneStatus("chemistry")
  });
  async function save(value: Operation) {
    value.updatedAt = new Date().toISOString();
    await atomicWrite(operationPath(value.target), JSON.stringify(value) + "\n", { mode: 0o600 });
  }
  async function removeCandidate(target: ScienceEnvironmentTarget, id: string) {
    // Only generated, unpublished UUID directories are ever removed.
    const installed = await ready(target);
    if (installed?.generation === id) return;
    try {
      await contained(join(directory(target), "generations"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(generationPath(target, id), { recursive: true, force: true });
    await rm(cancelPath(target, id), { force: true });
  }
  async function execute(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    deadline: number
  ) {
    const host = new ProcessHost();
    const child = host.start("installation", command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: cwd,
        USERPROFILE: cwd,
        XDG_CONFIG_HOME: cwd,
        XDG_CACHE_HOME: cwd,
        TMPDIR: cwd,
        TMP: cwd,
        TEMP: cwd,
        PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : "/dev/null",
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        ...(process.platform === "win32" && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {})
      }
    });
    let output = "",
      bytes = 0,
      failure: ScienceInstallationError | undefined;
    let cleanup: Promise<void> | undefined;
    const stop = () => (cleanup ??= host.stopKey("installation", 100));
    const fail = (code: string, message: string) => {
      failure ??= new ScienceInstallationError(400, code, message);
      void stop().catch(() => {});
    };
    const abort = () => fail("cancelled", "安装已取消，原配置和已有环境保持不变");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => fail("timeout", "科学环境安装超时，请检查网络和 Python 后重试"),
      Math.max(1, deadline - Date.now())
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) fail("output_too_large", "安装输出超过限制，操作已停止");
      else output += chunk;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) fail("output_too_large", "安装输出超过限制，操作已停止");
    });
    const closed = new Promise<number | null>((done) => {
      child.once("error", () =>
        fail("python_unavailable", "无法启动所选 Python，请先安装 Python 3.10+ 并选择有效解释器")
      );
      child.once("exit", () => {
        void stop().catch(() => {});
      });
      child.once("close", done);
    });
    if (signal.aborted) abort();
    try {
      const code = await closed;
      await stop();
      if (failure) throw failure;
      if (code !== 0)
        throw new ScienceInstallationError(
          400,
          "installation_failed",
          "安装步骤未完成；请确认 Python 含 venv/ensurepip、网络可访问 PyPI 且平台有对应 wheel"
        );
      return output;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await stop();
      host.processes.delete("installation");
    }
  }
  function supported(raw: string): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      /* checked below */
    }
    if (
      !record(value) ||
      !Array.isArray(value.version) ||
      value.version.length !== 3 ||
      !value.version.every((part) => Number.isSafeInteger(part) && part >= 0)
    )
      throw new ScienceInstallationError(400, "invalid_python_response", "Python 返回了无效的版本或自检信息");
    if (value.version[0] !== 3 || value.version[1] < 10)
      throw new ScienceInstallationError(
        400,
        "unsupported_python",
        "安装需要 Python 3.10 或更新的 Python 3 版本；请先安装宿主 Python"
      );
    return value;
  }
  async function perform(value: Operation, signal: AbortSignal) {
    const { target, operationId } = value;
    const path = generationPath(target, operationId);
    const work = join(path, ".installation");
    const deadline = Date.now() + timeoutMs;
    const phase = async (next: InstallationPhase) => {
      value.phase = next;
      await save(value);
    };
    try {
      await mkdir(work, { recursive: true, mode: 0o700 });
      await contained(work);
      await phase("validating_python");
      const sourcePython = await resolveSourcePython(value.sourcePython);
      supported(
        await execute(
          sourcePython,
          ["-I", "-B", "-c", HOST_CHECK, String(process.pid)],
          work,
          signal,
          Math.min(deadline, Date.now() + probeTimeoutMs)
        )
      );
      await phase("creating_venv");
      await execute(
        sourcePython,
        ["-I", "-B", "-c", SUPERVISED_MODULE, String(process.pid), "venv", "--copies", path],
        work,
        signal,
        deadline
      );
      await phase("installing_dependencies");
      const python = pythonPath(target, operationId);
      await execute(
        python,
        [
          "-I",
          "-B",
          "-c",
          SUPERVISED_MODULE,
          String(process.pid),
          "pip",
          "--isolated",
          "--disable-pip-version-check",
          "--no-input",
          "install",
          "--index-url",
          "https://pypi.org/simple",
          "--only-binary=:all:",
          "--no-deps",
          "--no-cache-dir",
          "--no-compile",
          ...SCIENCE_INSTALLATION_SPECS[target].packages
        ],
        work,
        signal,
        deadline
      );
      await phase("checking_environment");
      const checked = supported(
        await execute(
          python,
          ["-I", "-B", "-c", VERIFY, String(process.pid), target],
          work,
          signal,
          Math.min(deadline, Date.now() + probeTimeoutMs)
        )
      );
      const expected =
        target === "general"
          ? { numpy: "2.2.6", scipy: "1.15.3" }
          : { numpy: "2.2.6", rdkit: "2026.09.1", Pillow: "11.3.0" };
      if (
        !record(checked.versions) ||
        !Object.entries(expected).every(
          ([name, version]) =>
            checked.versions && (checked.versions as Record<string, unknown>)[name] === version
        )
      )
        throw new ScienceInstallationError(
          400,
          "dependency_version_mismatch",
          "新环境未通过固定依赖版本自检，尚未发布为可用环境"
        );
      if (signal.aborted) throw new ScienceInstallationError(400, "cancelled", "安装已取消");
      await atomicWrite(
        join(directory(target), "ready.json"),
        JSON.stringify({
          version: 1,
          generation: operationId,
          specVersion: value.specVersion,
          sourcePython: value.sourcePython
        }) + "\n",
        { mode: 0o600 }
      );
      value.state = "ready";
      delete value.phase;
      await save(value);
      await rm(work, { recursive: true, force: true });
    } catch (error) {
      value.state = signal.aborted ? "cancelled" : "failed";
      delete value.phase;
      value.error =
        error instanceof ScienceInstallationError
          ? { code: error.code, message: error.message }
          : { code: "installation_failed", message: "科学环境安装未完成，原配置和已有环境保持不变" };
      await removeCandidate(target, operationId);
      await save(value);
    }
  }
  async function install(input: {
    target: ScienceEnvironmentTarget;
    pythonExecutable: string;
    reinstall?: boolean;
  }): Promise<ScienceInstallationStatus> {
    targetValue(input.target);
    if (
      !validScienceExecutable(input.pythonExecutable) ||
      (input.reinstall !== undefined && typeof input.reinstall !== "boolean")
    )
      throw new ScienceInstallationError(400, "invalid_arguments", "请选择宿主 Python 的绝对路径或命令名");
    if (stopping) throw new ScienceInstallationError(409, "stopping", "应用正在关闭，请稍后重试");
    const { target } = input;
    const active = local.get(target);
    if (active) {
      await active.started;
      const current = await oneStatus(target);
      if (current.state === "installing") return current;
      await active.done;
      return install(input);
    }
    const controller = new AbortController();
    let acknowledged = false;
    let accepted!: () => void;
    const started = new Promise<void>((done) => {
      accepted = () => {
        acknowledged = true;
        done();
      };
    });
    const job: {
      controller: AbortController;
      done: Promise<void>;
      started: Promise<void>;
      operationId?: string;
    } = { controller, done: Promise.resolve(), started };
    local.set(target, job);
    let startError: unknown;
    let acquiredLock = false;
    const acquire = async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await mkdir(directory(target), { recursive: true, mode: 0o700 });
      await contained(directory(target));
      await mkdir(join(directory(target), "generations"), { recursive: true, mode: 0o700 });
      await contained(join(directory(target), "generations"));
      return withFileLock(
        operationPath(target),
        async () => {
          acquiredLock = true;
          const prior = await operation(target);
          if (prior?.state === "installing") {
            if (
              prior.owner.host !== hostname() ||
              (prior.owner.pid !== process.pid && alive(prior.owner.pid))
            ) {
              accepted();
              return;
            }
            // Module workers terminate themselves when their owning application dies.
            await pause(300);
            await removeCandidate(target, prior.operationId);
          }
          const installed = await ready(target);
          if (installed && installed.sourcePython === input.pythonExecutable && !input.reinstall) {
            const reused: Operation = {
              version: 1,
              target,
              state: "ready",
              specVersion: installed.specVersion,
              operationId: installed.generation,
              sourcePython: installed.sourcePython,
              owner: { pid: process.pid, host: hostname() },
              updatedAt: new Date().toISOString()
            };
            await save(reused);
            terminalFailures.delete(target);
            accepted();
            return;
          }
          const value: Operation = {
            version: 1,
            target,
            state: "installing",
            specVersion: SCIENCE_INSTALLATION_SPECS[target].version,
            operationId: randomUUID(),
            sourcePython: input.pythonExecutable,
            owner: { pid: process.pid, host: hostname() },
            startedAt: new Date().toISOString()
          };
          job.operationId = value.operationId;
          await save(value);
          terminalFailures.delete(target);
          accepted();
          const poll = setInterval(() => {
            void jsonFile(cancelPath(target, value.operationId))
              .then((request) => {
                if (record(request) && request.operationId === value.operationId) controller.abort();
              })
              .catch(() => {});
          }, 200);
          try {
            await perform(value, controller.signal);
          } finally {
            clearInterval(poll);
            await rm(cancelPath(target, value.operationId), { force: true });
          }
        },
        { recoverDeadOwner: true, timeoutMs: 500, heartbeatMs: 1000 }
      );
    };
    job.done = acquire()
      .catch(async (error) => {
        const current = await operation(target).catch(() => undefined);
        // A failed cleanup/state write can leave our own last durable phase as
        // installing. Do not mistake the still-live Host PID for an active job.
        // Keep the original bytes and expose the terminal state only for this
        // exact operation; a later retry must acquire the normal file lock.
        if (
          current?.state === "installing" &&
          current.operationId === job.operationId &&
          current.owner.pid === process.pid &&
          current.owner.host === hostname()
        )
          terminalFailures.set(target, {
            operationId: current.operationId,
            updatedAt: new Date().toISOString(),
            error: {
              code: "installation_io_failed",
              message: "安装已停止，但清理或状态写入未完成；请检查存储空间与目录权限后重试，已有环境仍保留"
            }
          });
        const anotherOwner =
          !acquiredLock &&
          current?.state === "installing" &&
          (current.owner.host !== hostname() || alive(current.owner.pid));
        if (!anotherOwner && !acknowledged) startError = error;
        accepted();
      })
      .finally(() => {
        local.delete(target);
        accepted();
      });
    await started;
    if (startError)
      throw new ScienceInstallationError(
        409,
        "installation_busy",
        "无法开始安装，请检查环境目录权限或等待当前操作完成"
      );
    return oneStatus(target);
  }
  async function cancel(target: ScienceEnvironmentTarget): Promise<ScienceInstallationStatus> {
    targetValue(target);
    const current = await operation(target);
    if (!current || current.state !== "installing") return oneStatus(target);
    if (current.owner.host === hostname() && !alive(current.owner.pid)) return oneStatus(target);
    await atomicWrite(
      cancelPath(target, current.operationId),
      JSON.stringify({ operationId: current.operationId }) + "\n",
      { mode: 0o600 }
    );
    const own = local.get(target);
    if (own?.operationId === current.operationId) {
      own.controller.abort();
      await own.done;
    } else {
      const deadline = Date.now() + 10_000;
      const stillCurrent = async () => {
        const latest = await oneStatus(target);
        return latest.operationId === current.operationId && latest.state === "installing";
      };
      while ((await stillCurrent()) && Date.now() < deadline) await pause(50);
      if (await stillCurrent())
        throw new ScienceInstallationError(409, "cancellation_pending", "已请求取消，请等待安装进程完成回收");
    }
    return oneStatus(target);
  }
  return {
    status,
    install,
    cancel,
    async stop() {
      stopping = true;
      const pending = [...local.values()];
      for (const job of pending) job.controller.abort();
      await Promise.all(pending.map((job) => job.done));
    }
  };
}

import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessHost } from "./process-host.js";
import { DEFAULT_SCIENCE_CATALOG_VERSION } from "../tools/science/catalog.js";

export interface ScienceEnvironmentSettings {
  enabled?: boolean;
  pythonExecutable?: string;
  chemistryPythonExecutable?: string;
}

export interface ScienceEnvironmentConfig {
  science?: ScienceEnvironmentSettings;
}

const environmentFields = {
  enabled: "COWORK_SCIENCE_TOOLS",
  pythonExecutable: "COWORK_SCIENCE_PYTHON",
  chemistryPythonExecutable: "COWORK_SCIENCE_CHEMISTRY_PYTHON"
} as const;

export interface ScienceEnvironmentSelection {
  enabled: boolean;
  pythonExecutable: string;
  chemistryPythonExecutable: string;
  chemistryInheritsGeneral: boolean;
  managedByEnvironment: boolean;
  managedFields: Record<keyof typeof environmentFields, boolean>;
  configurationError?: string;
}

export function validScienceExecutable(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\0\r\n]/u.test(value) &&
    (isAbsolute(value) || /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Optional malformed settings disable science without blocking ordinary Agent startup. */
export function configuredScienceEnvironment(
  config: ScienceEnvironmentConfig = {},
  env: NodeJS.ProcessEnv = process.env
): ScienceEnvironmentSelection {
  const managedFields = {
    enabled: env.COWORK_SCIENCE_TOOLS !== undefined,
    pythonExecutable: env.COWORK_SCIENCE_PYTHON !== undefined,
    chemistryPythonExecutable: env.COWORK_SCIENCE_CHEMISTRY_PYTHON !== undefined
  };
  const raw: unknown = config.science;
  const saved = record(raw) ? raw : {};
  const python = env.COWORK_SCIENCE_PYTHON ?? saved.pythonExecutable ?? "python3";
  const chemistry = env.COWORK_SCIENCE_CHEMISTRY_PYTHON ?? saved.chemistryPythonExecutable;
  const pythonExecutable = typeof python === "string" ? python.trim() : "";
  const chemistryPythonExecutable =
    chemistry === undefined ? pythonExecutable : typeof chemistry === "string" ? chemistry.trim() : "";
  let configurationError: string | undefined;
  if (raw !== undefined && !record(raw)) configurationError = "科学计算设置必须为对象";
  else if (!managedFields.enabled && saved.enabled !== undefined && typeof saved.enabled !== "boolean")
    configurationError = "科学计算开关必须为布尔值";
  else if (
    !validScienceExecutable(pythonExecutable) ||
    (typeof python === "string" && /[\0\r\n]/u.test(python))
  )
    configurationError = "通用 Python 必须为绝对路径或单独的命令名";
  else if (
    !validScienceExecutable(chemistryPythonExecutable) ||
    (typeof chemistry === "string" && /[\0\r\n]/u.test(chemistry))
  )
    configurationError = "化学 Python 必须为绝对路径或单独的命令名";
  return {
    enabled:
      !configurationError &&
      (managedFields.enabled ? env.COWORK_SCIENCE_TOOLS?.trim() === "1" : saved.enabled === true),
    pythonExecutable: validScienceExecutable(pythonExecutable) ? pythonExecutable : "python3",
    chemistryPythonExecutable: validScienceExecutable(chemistryPythonExecutable)
      ? chemistryPythonExecutable
      : "python3",
    chemistryInheritsGeneral: chemistry === undefined,
    managedByEnvironment: Object.values(managedFields).some(Boolean),
    managedFields,
    ...(configurationError ? { configurationError } : {})
  };
}

/** Resolved host values for a fresh child; callers preserve existing Run/queue selections. */
export function scienceEnvironmentEnv(
  config: ScienceEnvironmentConfig = {},
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const selected = configuredScienceEnvironment(config, env);
  return {
    COWORK_SCIENCE_TOOLS: selected.enabled ? "1" : "0",
    COWORK_SCIENCE_PYTHON: selected.pythonExecutable,
    COWORK_SCIENCE_CHEMISTRY_PYTHON: selected.chemistryPythonExecutable
  };
}

export function publicScienceEnvironmentStatus(
  config: ScienceEnvironmentConfig = {},
  env: NodeJS.ProcessEnv = process.env
) {
  return {
    ...configuredScienceEnvironment(config, env),
    appliesTo: "new-runs" as const,
    enablementAppliesTo: "next-process-start" as const,
    catalogVersion: DEFAULT_SCIENCE_CATALOG_VERSION
  };
}

export function saveScienceEnvironmentConfig<T extends ScienceEnvironmentConfig>(
  config: T,
  input: Record<string, unknown>
): T {
  if (
    !record(input) ||
    !Object.keys(input).length ||
    Object.keys(input).some((key) => !Object.hasOwn(environmentFields, key))
  )
    throw new Error("仅支持科学计算开关、通用 Python 和化学 Python 设置");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("科学计算开关必须为布尔值");
  const science: ScienceEnvironmentSettings = record(config.science) ? { ...config.science } : {};
  if (input.enabled !== undefined) science.enabled = input.enabled;
  for (const field of ["pythonExecutable", "chemistryPythonExecutable"] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const raw = input[field];
    if (typeof raw !== "string" || /[\0\r\n]/u.test(raw)) throw new Error("Python 选择必须为单行字符串");
    const value = raw.trim();
    if (value && !validScienceExecutable(value)) throw new Error("Python 必须为绝对路径或单独的命令名");
    if (value) science[field] = value;
    else delete science[field];
  }
  const next = { ...config, science };
  const parsed = configuredScienceEnvironment(next, {});
  if (parsed.configurationError) throw new Error(parsed.configurationError);
  return next;
}

export type ScienceEnvironmentTarget = "general" | "chemistry";
export interface SciencePackageStatus {
  available: boolean;
  version?: string;
  selfTestPassed?: boolean;
}
export interface ScienceEnvironmentCheck {
  ok: boolean;
  target: ScienceEnvironmentTarget;
  pythonExecutable: string;
  python: SciencePackageStatus;
  packages: Record<"numpy" | "scipy" | "rdkit", SciencePackageStatus>;
  scalarFunctionsAvailable: boolean;
  error?: { code: string; message: string };
}

const packages = ["numpy", "scipy", "rdkit"] as const;
export const SCIENCE_RDKIT_VERSION = "2026.09.1";

/** Explicit host action only: one fixed script, no installation, discovery or inherited credentials. */
export async function checkScienceEnvironment(
  input: { target: ScienceEnvironmentTarget; pythonExecutable: string },
  options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<ScienceEnvironmentCheck> {
  const failure = (code: string, message: string): ScienceEnvironmentCheck => ({
    ok: false,
    ...input,
    python: { available: false },
    packages: { numpy: { available: false }, scipy: { available: false }, rdkit: { available: false } },
    scalarFunctionsAvailable: false,
    error: { code, message }
  });
  if (!validScienceExecutable(input.pythonExecutable) || !["general", "chemistry"].includes(input.target))
    return failure("invalid_configuration", "请选择有效的 Python 解释器");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1024 * 1024
  )
    return failure("invalid_configuration", "环境检查的资源限制无效");
  if (options.signal?.aborted) return failure("cancelled", "环境检查已取消");
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "atria-science-check-"));
  } catch {
    return failure("unavailable", "无法创建环境检查的临时目录");
  }
  const host = new ProcessHost();
  let child: ChildProcess;
  try {
    child = host.start(
      "check",
      input.pythonExecutable,
      ["-I", "-B", fileURLToPath(new URL("../tools/science/environment-probe.py", import.meta.url))],
      {
        cwd: directory,
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          OMP_NUM_THREADS: "1",
          OPENBLAS_NUM_THREADS: "1",
          MKL_NUM_THREADS: "1",
          ...(process.platform === "win32" && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {})
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch {
    await rm(directory, { recursive: true, force: true });
    return failure("unavailable", "无法启动所选 Python 解释器");
  }
  let output = "",
    bytes = 0;
  let failed: ScienceEnvironmentCheck | undefined;
  let cleanup: Promise<void> | undefined;
  const stop = () =>
    (cleanup ??= host.stopKey("check", 100).catch(() => {
      failed ??= failure("cleanup_failed", "无法停止环境检查进程");
    }));
  const fail = (code: string, message: string) => {
    failed ??= failure(code, message);
    void stop();
  };
  const abort = () => fail("cancelled", "环境检查已取消");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail("timeout", "环境检查超时，进程已停止"), timeoutMs);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxOutputBytes) fail("output_too_large", "环境检查输出超过限制");
    else output += chunk;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) fail("output_too_large", "环境检查输出超过限制");
  });
  const closed = new Promise<number | null>((done) => {
    child.once("error", () => {
      failed ??= failure("unavailable", "无法启动所选 Python 解释器");
    });
    child.once("exit", () => {
      void stop();
    });
    child.once("close", done);
  });
  if (options.signal?.aborted) abort();
  try {
    const code = await closed;
    await stop();
    if (failed) return failed;
    if (code !== 0) return failure("probe_failed", "所选 Python 无法完成环境检查");
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      return failure("invalid_response", "Python 环境检查返回了无效结果");
    }
    const validStatus = (status: unknown): status is SciencePackageStatus =>
      record(status) &&
      typeof status.available === "boolean" &&
      (status.selfTestPassed === undefined || typeof status.selfTestPassed === "boolean") &&
      (status.version === undefined ||
        (typeof status.version === "string" && /^[A-Za-z0-9.+!_-]{1,128}$/u.test(status.version)));
    if (!record(value) || !validStatus(value.python) || !record(value.packages))
      return failure("invalid_response", "Python 环境检查返回了无效结果");
    const probed = value.packages;
    if (!packages.every((name) => validStatus(probed[name])))
      return failure("invalid_response", "Python 环境检查返回了无效结果");
    const packageStatus = (name: (typeof packages)[number]): SciencePackageStatus => {
      const status = probed[name] as SciencePackageStatus;
      return {
        available: status.available,
        ...(status.version ? { version: status.version } : {}),
        ...(status.selfTestPassed === undefined ? {} : { selfTestPassed: status.selfTestPassed })
      };
    };
    const dependencies = {
      numpy: packageStatus("numpy"),
      scipy: packageStatus("scipy"),
      rdkit: packageStatus("rdkit")
    };
    const python = {
      available: value.python.available,
      ...(value.python.version ? { version: value.python.version } : {})
    };
    const version = python.version?.match(/^(\d+)\.(\d+)\./u);
    const scalarsSupported =
      python.available &&
      Boolean(version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 9)));
    const supported =
      python.available &&
      Boolean(version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 10)));
    const versionMismatch =
      input.target === "chemistry" &&
      dependencies.rdkit.version !== undefined &&
      dependencies.rdkit.version !== SCIENCE_RDKIT_VERSION;
    const ready =
      supported &&
      (input.target === "general"
        ? dependencies.numpy.available && dependencies.scipy.available
        : dependencies.rdkit.available && !versionMismatch && dependencies.rdkit.selfTestPassed === true);
    return {
      ok: ready,
      ...input,
      python,
      packages: dependencies,
      scalarFunctionsAvailable: scalarsSupported,
      ...(!supported
        ? {
            error: {
              code: "unsupported_python",
              message:
                input.target === "chemistry"
                  ? "化学工具需要 Python 3.10 或更新版本"
                  : scalarsSupported
                    ? "数组分析需要 Python 3.10 或更新版本；标量函数仍可使用"
                    : "科学工具需要 Python 3.9 或更新版本"
            }
          }
        : versionMismatch
          ? {
              error: {
                code: "dependency_version_mismatch",
                message: `化学工具需要 RDKit ${SCIENCE_RDKIT_VERSION}，请在所选环境中使用匹配版本`
              }
            }
          : !ready
            ? {
                error: {
                  code: "dependency_unavailable",
                  message:
                    input.target === "general"
                      ? "通用数组分析需要 NumPy 和 SciPy；标量函数仍可使用"
                      : "化学工具需要所选环境中的 RDKit"
                }
              }
            : {})
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await stop();
    host.processes.delete("check");
    await rm(directory, { recursive: true, force: true });
  }
}

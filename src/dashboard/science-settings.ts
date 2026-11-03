import { existsSync } from "node:fs";
import { join } from "node:path";
import { atriaDataPaths } from "../../scripts/data-home.cjs";
import { atomicWrite } from "../applications/fs-utils.js";
import { coworkConfigPath, readCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import {
  checkScienceEnvironment,
  configuredScienceEnvironment,
  publicScienceEnvironmentStatus,
  saveScienceEnvironmentConfig,
  validScienceExecutable,
  type ScienceEnvironmentConfig
} from "../runtime/science-environment.js";
import { withFileLock } from "../storage/file-lock.js";
import { createScienceInstallation } from "../runtime/science-installation.js";

export class ScienceSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ScienceSettingsError";
  }
}

/** Settings affect fresh Runs only; persistence and status never execute the selected runtime. */
export function createScienceSettings(
  root: string,
  config: CoworkConfig & ScienceEnvironmentConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    installation?: ReturnType<typeof createScienceInstallation>;
  } = {}
) {
  const env = options.env ?? process.env;
  const installation =
    options.installation ??
    createScienceInstallation({
      root: join(atriaDataPaths(env, config, root).home, "science-environments")
    });
  const status = () => publicScienceEnvironmentStatus(config, env);
  let checks = 0;
  return {
    status,
    environments: installation.status,
    async install(input: Record<string, unknown>) {
      if (
        Object.keys(input).some((key) => !["target", "pythonExecutable", "reinstall"].includes(key)) ||
        (input.target !== "general" && input.target !== "chemistry") ||
        (input.reinstall !== undefined && typeof input.reinstall !== "boolean") ||
        (input.pythonExecutable !== undefined &&
          (typeof input.pythonExecutable !== "string" || /[\0\r\n]/u.test(input.pythonExecutable)))
      )
        throw new ScienceSettingsError(
          400,
          "invalid_arguments",
          "请选择环境与宿主 Python，不支持自定义软件包或安装参数"
        );
      const selected = configuredScienceEnvironment(config, env);
      const draft = typeof input.pythonExecutable === "string" ? input.pythonExecutable.trim() : "";
      const pythonExecutable =
        draft ||
        (input.target === "general" ? selected.pythonExecutable : selected.chemistryPythonExecutable);
      if (!validScienceExecutable(pythonExecutable))
        throw new ScienceSettingsError(400, "invalid_arguments", "请选择有效的宿主 Python 3.10+ 解释器");
      return installation.install({
        target: input.target,
        pythonExecutable,
        ...(input.reinstall === undefined ? {} : { reinstall: input.reinstall })
      });
    },
    async cancelInstallation(input: Record<string, unknown>) {
      if (
        Object.keys(input).some((key) => key !== "target") ||
        (input.target !== "general" && input.target !== "chemistry")
      )
        throw new ScienceSettingsError(400, "invalid_arguments", "请选择要取消安装的环境");
      return installation.cancel(input.target);
    },
    stop: installation.stop,
    async save(input: Record<string, unknown>) {
      saveScienceEnvironmentConfig({}, input);
      const managed = status().managedFields;
      if (Object.keys(input).some((key) => managed[key as keyof typeof managed]))
        throw new ScienceSettingsError(
          409,
          "managed_by_environment",
          "科学计算由启动环境管理，请在启动配置中修改"
        );
      const path = coworkConfigPath(root, env);
      await withFileLock(
        path,
        async () => {
          const previous = existsSync(path)
            ? readCoworkConfig(root, { ...env, COWORK_CONFIG: path })
            : config;
          const next = saveScienceEnvironmentConfig(previous, input);
          try {
            await atomicWrite(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
          } catch (error) {
            throw new ScienceSettingsError(500, "save_failed", "无法保存科学计算设置，原配置仍保留", {
              cause: error
            });
          }
          Object.assign(config, next);
        },
        { recoverDeadOwner: true, timeoutMs: 2000 }
      );
      return status();
    },
    async check(input: Record<string, unknown>, signal?: AbortSignal) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => !["target", "pythonExecutable"].includes(key)) ||
        (input.target !== "general" && input.target !== "chemistry")
      )
        throw new ScienceSettingsError(400, "invalid_arguments", "请选择通用或化学环境进行检查");
      if (
        input.pythonExecutable !== undefined &&
        (typeof input.pythonExecutable !== "string" || /[\0\r\n]/u.test(input.pythonExecutable))
      )
        throw new ScienceSettingsError(400, "invalid_arguments", "Python 选择必须为单行字符串");
      const selected = configuredScienceEnvironment(config, env);
      const managed =
        input.target === "general"
          ? selected.managedFields.pythonExecutable
          : selected.managedFields.chemistryPythonExecutable;
      const current =
        input.target === "general" ? selected.pythonExecutable : selected.chemistryPythonExecutable;
      const draft = typeof input.pythonExecutable === "string" ? input.pythonExecutable.trim() : "";
      const pythonExecutable = managed || !draft ? current : draft;
      if (!validScienceExecutable(pythonExecutable))
        throw new ScienceSettingsError(400, "invalid_arguments", "Python 必须为绝对路径或单独的命令名");
      if (selected.configurationError && (managed || !draft))
        throw new ScienceSettingsError(400, "invalid_configuration", selected.configurationError);
      if (checks >= 2)
        throw new ScienceSettingsError(429, "check_busy", "已有两个环境检查正在运行，请等待完成");
      checks++;
      try {
        return await checkScienceEnvironment(
          { target: input.target, pythonExecutable },
          {
            signal,
            timeoutMs: options.timeoutMs,
            maxOutputBytes: options.maxOutputBytes
          }
        );
      } finally {
        checks--;
      }
    }
  };
}

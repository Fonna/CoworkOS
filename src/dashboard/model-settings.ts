import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { coworkConfigPath, readCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import { withFileLock } from "../storage/file-lock.js";
import { configuredSupportsImages } from "../runtime/runtime-settings.js";
import { testModelConnection } from "../runtime/model-connection.js";
import { publicConnections, saveConnection, selectedConnection } from "../runtime/model-connections.js";
import { connectionProfile, parseConnectionProfile } from "../runtime/model-profile.js";

/** Local Web settings never return credentials or overwrite environment-managed connections. */
export function createModelSettings(root: string, config: CoworkConfig, active: () => boolean) {
  const path = coworkConfigPath(root);
  const status = () => ({
    ...connectionProfile(config),
    ...publicConnections(config),
    baseUrl: process.env.COWORK_API_BASE || config.baseUrl || config.apiBase || "",
    model: process.env.COWORK_MODEL || config.model || "",
    configured: Boolean(
      (process.env.COWORK_API_BASE || config.baseUrl || config.apiBase) &&
      (process.env.COWORK_API_KEY || config.apiKey)
    ),
    supportsImages:
      process.env.COWORK_SUPPORTS_IMAGES !== undefined ||
      [
        "COWORK_REASONING_EFFORT",
        "COWORK_SUPPORTS_REASONING_EFFORT",
        "COWORK_MAIN_MAX_TOKENS",
        "COWORK_MAX_TOKENS"
      ].some((key) => process.env[key] !== undefined)
        ? configuredSupportsImages()
        : config.supportsImages === true,
    managedByEnvironment: Boolean(
      process.env.COWORK_API_BASE ||
      process.env.COWORK_API_KEY ||
      process.env.COWORK_MODEL ||
      process.env.COWORK_SUPPORTS_IMAGES !== undefined ||
      process.env.COWORK_MODEL_API !== undefined ||
      process.env.COWORK_SUPPORTS_PROMPT_CACHE_KEY !== undefined ||
      process.env.COWORK_THINKING_FORMAT !== undefined ||
      process.env.COWORK_CONTEXT_WINDOW !== undefined
    )
  });
  return {
    status,
    async test(value: Record<string, unknown>) {
      const current = status();
      const managed = current.managedByEnvironment;
      const selected = managed ? config : selectedConnection(config, value) || {};
      if (value.supportsImages !== undefined && typeof value.supportsImages !== "boolean")
        throw new Error("图像能力设置必须为布尔值");
      return testModelConnection({
        ...parseConnectionProfile(managed ? {} : value, connectionProfile(selected)),
        baseUrl: managed
          ? current.baseUrl
          : typeof value.baseUrl === "string"
            ? value.baseUrl.trim()
            : selected.baseUrl || "",
        model: managed
          ? current.model
          : typeof value.model === "string"
            ? value.model.trim()
            : selected.model || "",
        apiKey:
          !managed && typeof value.apiKey === "string" && value.apiKey.trim()
            ? value.apiKey.trim()
            : (managed ? process.env.COWORK_API_KEY || config.apiKey : selected.apiKey) || "",
        supportsImages:
          managed || value.supportsImages === undefined
            ? managed
              ? current.supportsImages
              : selected.supportsImages === true
            : value.supportsImages === true
      });
    },
    async save(value: Record<string, unknown>) {
      if (active()) throw new Error("请先停止运行中的任务，再修改模型连接");
      if (status().managedByEnvironment) throw new Error("当前连接由启动环境管理，请在启动配置中修改");
      await withFileLock(path, async () => {
        const previous = existsSync(path) ? readCoworkConfig(root, { COWORK_CONFIG: path }) : config;
        const next = saveConnection(previous, value);
        if (!previous.modelConnections && existsSync(path)) {
          await copyFile(path, `${path}.before-model-profiles`, 1).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
          await chmod(`${path}.before-model-profiles`, 0o600);
        }
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.tmp-${randomUUID()}`;
        await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        await rename(temporary, path);
        await chmod(path, 0o600);
        Object.assign(config, next);
      });
      return status();
    }
  };
}

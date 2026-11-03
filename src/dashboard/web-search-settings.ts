import { existsSync } from "node:fs";
import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { coworkConfigPath, readCoworkConfig, type CoworkConfig } from "../runtime/config.js";
import { publicWebSearchStatus, saveWebSearchConfig } from "../runtime/web-search-config.js";
import { withFileLock } from "../storage/file-lock.js";

/** The Web host stores optional keys privately and never returns them. Desktop writes go through its encrypted host. */
export function createWebSearchSettings(root: string, config: CoworkConfig, active: () => boolean) {
  const status = () => publicWebSearchStatus(config);
  return {
    status,
    async save(input: Record<string, unknown>) {
      if (active()) throw new Error("请先停止运行中的任务，再修改联网搜索设置");
      if (status().managedByEnvironment) throw new Error("联网搜索由启动环境管理，请在启动配置中修改");
      if (config.webSearch?.encryptedExaApiKey) throw new Error("请在桌面设置中修改加密的搜索配置");
      const path = coworkConfigPath(root);
      await withFileLock(path, async () => {
        const previous = existsSync(path) ? readCoworkConfig(root, { COWORK_CONFIG: path }) : config;
        const next = saveWebSearchConfig(previous, input);
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.tmp-${randomUUID()}`;
        await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        await rename(temp, path);
        await chmod(path, 0o600);
        Object.assign(config, next);
      });
      return status();
    }
  };
}

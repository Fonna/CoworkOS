const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
/** Separate encrypted credential; existing secrets never cross the preload boundary. */
function createComponentAuth(userData, safeStorage) {
  const file = path.join(userData, "component-github-secret.bin");
  const encryptionAvailable = async () =>
    (await safeStorage.isEncryptionAvailable()) && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  let writes = Promise.resolve();
  async function read() {
    try {
      const encrypted = await fs.readFile(file);
      if (!(await encryptionAvailable())) throw new Error();
      return await safeStorage.decryptString(encrypted);
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw new Error("组件下载凭据无法解密，请重新保存或清除");
    }
  }
  async function status() {
    try {
      return { configured: Boolean(await read()), unavailable: false };
    } catch {
      return { configured: false, unavailable: true };
    }
  }
  return {
    read,
    status,
    save(input) {
      const operation = writes
        .catch(() => {})
        .then(async () => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !["token", "clear"].includes(key)) ||
            (input.clear === true
              ? input.token !== undefined
              : input.clear !== undefined || typeof input.token !== "string")
          )
            throw new Error("无效的组件下载凭据设置");
          if (input.clear === true) await fs.rm(file, { force: true });
          else {
            const { validateComponentToken } = await import("../dist/src/software/components/download.js");
            const token = validateComponentToken(input.token);
            if (!token) throw new Error("请输入 GitHub token 或使用清除按钮");
            await safeStorage.retry?.();
            if (!(await encryptionAvailable()))
              throw new Error("系统密钥存储访问失败，凭据尚未保存。请再次点击保存重试。");
            const temporary = `${file}.${crypto.randomUUID()}`;
            try {
              await fs.writeFile(temporary, await safeStorage.encryptString(token), { mode: 0o600 });
              await fs.rename(temporary, file);
            } finally {
              await fs.rm(temporary, { force: true });
            }
          }
          return status();
        });
      writes = operation;
      return operation;
    }
  };
}
/** Serialize persistence and live IPC as one operation, including a concurrent clear. */
function createComponentAuthController(store, getBackend) {
  let pending = Promise.resolve();
  return {
    save(input) {
      const operation = pending
        .catch(() => {})
        .then(async () => {
          const backend = getBackend();
          const status = await store.save(input);
          await backend.componentAuth(await store.read());
          return status;
        });
      pending = operation;
      return operation;
    }
  };
}
/** Public component downloads must not open an old saved GitHub secret. */
async function syncComponentAuth(backend, store, releaseRoot) {
  const { privateComponentSource } = await import("../dist/src/software/components/source.js");
  if (privateComponentSource(releaseRoot)) await backend.componentAuth(await store.read().catch(() => ""));
}
module.exports = { createComponentAuth, createComponentAuthController, syncComponentAuth };

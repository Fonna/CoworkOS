import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { blenderStatus } from "./engine.js";
import { blenderRuntimeDirectory } from "./runtime-path.js";
import { DEFAULT_COMPONENT_RELEASE_ROOT } from "../components/source.js";

const file = "blender-4.5.11-macos-arm64.dmg";
export const BLENDER_INSTALL_SOURCE = {
  file,
  downloadBytes: 308_255_028,
  sha256: "1fad76c7da9451c7d6db99f1a5ed3c0a1a461d0aa07bf2b639e2fb4804ca4f13",
  urls: [
    `${DEFAULT_COMPONENT_RELEASE_ROOT}/${file}`,
    `https://download.blender.org/release/Blender4.5/${file}`
  ]
};
export type BlenderInstallSource = {
  file: string;
  sha256: string;
  downloadBytes?: number;
  urls: string[];
};
type Progress = { phase: string; message: string; progress?: number };
export type BlenderInstallState = Progress & { available: boolean; installing: boolean; canInstall: boolean };
type Reporter = (progress: Progress) => void;

const checksum = async (path: string, signal?: AbortSignal) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
};

const run = (command: string, args: string[], signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", signal, timeout: 180_000 });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? resolve()
          : reject(new Error(`安装步骤失败：${command.split("/").at(-1)} (${code})`))
    );
  });

/** Only fixed, checksum-pinned sources are used by the public installation endpoint. */
export async function installBlenderRuntime({
  directory = blenderRuntimeDirectory(),
  signal = new AbortController().signal,
  report = (_progress: Progress) => {},
  source = BLENDER_INSTALL_SOURCE,
  fetcher = fetch,
  execute = run
}: {
  directory?: string;
  signal?: AbortSignal;
  report?: Reporter;
  source?: BlenderInstallSource;
  fetcher?: typeof fetch;
  execute?: typeof run;
} = {}): Promise<void> {
  const downloadDirectory = join(dirname(directory), "blender-download");
  await mkdir(downloadDirectory, { recursive: true });
  const archive = join(downloadDirectory, source.file);
  let valid = await checksum(archive, signal)
    .then((value) => value === source.sha256)
    .catch(() => false);
  let failure = "下载失败，请检查网络后重试";
  if (!valid) {
    for (const url of source.urls) {
      signal.throwIfAborted();
      const temporary = `${archive}.${randomUUID()}.partial`;
      try {
        report({ phase: "downloading", message: "正在下载 Blender 4.5 LTS…", progress: 0 });
        const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
        const response = await fetcher(url, { signal: downloadSignal });
        if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
        const total = Number(response.headers.get("content-length"));
        let received = 0;
        const meter = new Transform({
          transform(chunk, _encoding, done) {
            received += chunk.length;
            if (source.downloadBytes && received > source.downloadBytes)
              return done(new Error("Blender 安装包超过声明大小"));
            report({
              phase: "downloading",
              message: `正在下载 Blender：${Math.round(received / 1024 / 1024)} MB`,
              ...(total > 0 ? { progress: Math.min(99, Math.floor((received / total) * 100)) } : {})
            });
            done(null, chunk);
          }
        });
        await pipeline(
          Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
          meter,
          createWriteStream(temporary),
          {
            signal: downloadSignal
          }
        );
        report({ phase: "verifying", message: "正在校验安装包…" });
        if (source.downloadBytes && received !== source.downloadBytes)
          throw new Error("Blender 安装包大小不匹配，请重试");
        if ((await checksum(temporary, signal)) !== source.sha256) throw new Error("安装包校验失败，请重试");
        await rename(temporary, archive);
        valid = true;
        break;
      } catch (error) {
        signal.throwIfAborted();
        failure = error instanceof Error ? error.message : "下载失败，请重试";
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  if (!valid) throw new Error(failure);
  signal.throwIfAborted();
  const mount = join(downloadDirectory, `mount-${randomUUID()}`);
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(mount);
  await mkdir(staging);
  try {
    report({ phase: "installing", message: "正在安装 Blender…" });
    await execute(
      "/usr/bin/hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, archive],
      signal
    );
    await execute("/usr/bin/ditto", [join(mount, "Blender.app"), join(staging, "Blender.app")], signal);
    report({ phase: "verifying", message: "正在验证 Blender 能否启动…" });
    await execute(join(staging, "Blender.app/Contents/MacOS/Blender"), ["--version"], signal);
    signal.throwIfAborted();
    await rename(staging, directory);
    await access(join(directory, "Blender.app/Contents/MacOS/Blender"), 1);
  } finally {
    // An interrupted attach may already have mounted the image. Never recurse
    // into a mountpoint if detach fails, and preserve the original install error.
    await execute("/usr/bin/hdiutil", ["detach", mount])
      .catch(() => execute("/usr/bin/hdiutil", ["detach", "-force", mount]))
      .catch(() => {});
    await rmdir(mount).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

/** A Dashboard owns one install job; closing its UI never cancels the download. */
export function createBlenderInstaller({
  probe = blenderStatus,
  install = installBlenderRuntime,
  supported = process.platform === "darwin" && process.arch === "arm64"
} = {}) {
  let state: Progress = { phase: "missing", message: "Blender 待安装" };
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let closed = false;
  async function status(): Promise<BlenderInstallState> {
    if (active) return { ...state, available: false, installing: true, canInstall: supported };
    const runtime = await probe();
    if (runtime.available)
      return {
        phase: "ready",
        message: "Blender 可用",
        available: true,
        installing: false,
        canInstall: false
      };
    return {
      ...(state.phase === "failed"
        ? state
        : { phase: "missing", message: supported ? "Blender 待安装" : "一键安装目前支持 Apple Silicon Mac" }),
      available: false,
      installing: false,
      canInstall: supported
    };
  }
  function start(): Promise<BlenderInstallState> {
    if (!active) {
      if (closed) throw new Error("应用正在退出，请重新打开后安装");
      if (!supported) throw new Error("一键安装目前支持 Apple Silicon Mac");
      controller = new AbortController();
      state = { phase: "checking", message: "正在检查 Blender…" };
      const signal = controller.signal;
      active = (async () => {
        if (!(await probe()).available)
          await install({
            signal,
            report: (progress) => {
              state = progress;
            }
          });
        if (!(await probe()).available)
          throw new Error("安装完成但未检测到 Blender，请重试或检查自定义 Blender 路径");
        state = { phase: "ready", message: "Blender 可用" };
      })()
        .catch((error) => {
          state = {
            phase: "failed",
            message: signal.aborted
              ? "安装已中断，可重新安装"
              : error instanceof Error
                ? error.message
                : "安装失败，请重试"
          };
        })
        .finally(() => {
          active = undefined;
        });
    }
    return status();
  }
  return {
    status,
    start,
    async stop() {
      closed = true;
      controller?.abort();
      await active;
    }
  };
}

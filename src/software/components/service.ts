import { createComponentDownload, componentTokenProvider, componentJson } from "./download.js";
import { componentReleaseRoot } from "./source.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
  access,
  lstat,
  realpath,
  readdir
} from "node:fs/promises";
import { release } from "node:os";
import { join, posix, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withFileLock } from "../../storage/file-lock.js";
import {
  installBlenderRuntime,
  BLENDER_INSTALL_SOURCE,
  type BlenderInstallSource
} from "../blender/installer.js";
import { blenderStatus } from "../blender/engine.js";
import { wslBlenderStatus } from "../blender/wsl-engine.js";
import { cadQueryPython } from "../cad/cadquery-engine.js";
import {
  componentHome,
  componentIds,
  packagedComponentDirectory,
  selectedComponentDirectory,
  type ComponentId
} from "./paths.js";
export type Artifact = {
  id: ComponentId;
  version: string;
  hostVersion: string;
  platform: string;
  apiVersion: 1;
  file: string;
  sha256: string;
  downloadBytes: number;
  installedBytes: number;
};
export type ComponentState = {
  id: ComponentId;
  version?: string;
  enabled: boolean;
  available: boolean;
  phase: string;
  message: string;
  progress?: number;
  installing: boolean;
  supported: boolean;
  downloadBytes?: number;
  installedBytes?: number;
  dependencies: string[];
  managed: boolean;
  bundled: boolean;
};
const entry = {
  cadquery: "bin/python3",
  blender: "Blender.app/Contents/MacOS/Blender",
  pptist: "index.html"
};
const dependencies = {
  cadquery: ["CPython 3.11.15", "CadQuery 2.6.1", "OpenCascade"],
  blender: ["Blender 4.5 LTS"],
  pptist: ["PPTist (AGPL-3.0 source included)"]
};
const execute = (command: string, args: string[], signal?: AbortSignal): Promise<string> =>
  new Promise((done, reject) => {
    const child = spawn(command, args, { signal, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    let output = "",
      failure: Error | undefined;
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 4_000_000) child.kill();
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? done(output)
          : reject(new Error(`Component installation step failed (${code})`))
    );
  });
const json = async (path: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid component state record");
  }
  return value as Record<string, unknown>;
};
const atomic = async (path: string, value: unknown) => {
  const temporary = `${path}.${randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};
export function validateArtifact(
  value: unknown,
  id: ComponentId,
  hostVersion: string,
  platform: string
): Artifact {
  const v = value as Artifact;
  if (
    !v ||
    v.apiVersion !== 1 ||
    v.id !== id ||
    (v.hostVersion !== hostVersion && v.hostVersion !== "*") ||
    v.platform !== platform ||
    typeof v.version !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(v.version) ||
    typeof v.file !== "string" ||
    !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(v.file) ||
    !/^[a-f0-9]{64}$/.test(v.sha256) ||
    !Number.isSafeInteger(v.downloadBytes) ||
    v.downloadBytes <= 0 ||
    !Number.isSafeInteger(v.installedBytes) ||
    v.installedBytes <= 0
  )
    throw new Error("Component artifact is incompatible or has invalid integrity metadata");
  return v;
}
/** Shared by CLI and HTTP. Immutable version directories and atomic activation preserve old installs. */
const legacyProbe = async (id: ComponentId): Promise<{ version: string } | undefined> => {
  try {
    if (id === "blender") {
      if (process.platform === "win32" && process.env.COWORK_BLENDER_WSL_DISTRO) {
        const state = await wslBlenderStatus();
        return state.available && state.version ? { version: state.version } : undefined;
      }
      const state = await blenderStatus();
      if (!state.available || !state.executable) return undefined;
      const version = await execute(state.executable, ["--version"]);
      return (process.env.COWORK_BLENDER_EXECUTABLE ? /^Blender \d+\.\d+\./ : /^Blender 4\.5\./).test(version)
        ? { version: version.split("\n")[0].replace("Blender ", "") }
        : undefined;
    }
    if (id === "cadquery") {
      const python = cadQueryPython();
      await access(python, 1);
      const version = await execute(python, [
        "-I",
        "-B",
        "-c",
        "import cadquery; print(cadquery.__version__)"
      ]);
      return (
        process.env.COWORK_CADQUERY_PYTHON
          ? /^\d+\.\d+\.\d+/.test(version.trim())
          : version.trim() === "2.6.1"
      )
        ? { version: version.trim() }
        : undefined;
    }
    const directory =
      selectedComponentDirectory("pptist") ||
      (process.env.COWORK_UI_DIR
        ? join(process.env.COWORK_UI_DIR, "assets/pptist/generated")
        : new URL("../../../../web/assets/pptist/generated", import.meta.url).pathname);
    await access(join(directory, "index.html"));
    await access(join(directory, "LICENSE.txt"));
    await access(join(directory, "source.tar.gz"));
    return { version: packagedComponentDirectory("pptist") ? packageVersion() : "bundled" };
  } catch {
    return undefined;
  }
};
const packageVersion = () =>
  JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")).version as string;
export function createComponentService({
  home = componentHome(),
  hostVersion = packageVersion(),
  platform = `${process.platform}-${process.arch}`,
  fetcher = fetch,
  releaseRoot = componentReleaseRoot(),
  githubToken = componentTokenProvider(releaseRoot),
  blenderSource = {
    ...BLENDER_INSTALL_SOURCE,
    urls: [`${releaseRoot}/${BLENDER_INSTALL_SOURCE.file}`, ...BLENDER_INSTALL_SOURCE.urls.slice(1)]
  },
  installBlender = installBlenderRuntime,
  run = execute,
  legacy = legacyProbe,
  freeBytes = async (path: string) => {
    const disk = await statfs(path);
    return Number(disk.bavail) * Number(disk.bsize);
  }
}: {
  home?: string;
  hostVersion?: string;
  platform?: string;
  fetcher?: typeof fetch;
  githubToken?: () => string;
  releaseRoot?: string;
  blenderSource?: BlenderInstallSource;
  installBlender?: typeof installBlenderRuntime;
  run?: typeof execute;
  legacy?: typeof legacyProbe;
  freeBytes?: (path: string) => Promise<number>;
} = {}) {
  const download = createComponentDownload({ releaseRoot, fetcher, token: githubToken });
  const jobs = new Map<ComponentId, { promise: Promise<void>; controller: AbortController }>();
  const userCancellation = Symbol("component-user-cancellation");
  let closed = false;
  let preparation: Promise<void> | undefined;
  const supported = (id: ComponentId) =>
    id === "pptist" ||
    (platform === "darwin-arm64" && (process.platform !== "darwin" || Number(release().split(".")[0]) >= 23));
  const base = (id: ComponentId) => join(home, id);
  const stateFile = (id: ComponentId) => join(base(id), "install.json");
  const reports = new Map<ComponentId, Promise<void>>();
  const report = (id: ComponentId, value: Record<string, unknown>) => {
    const next = (reports.get(id) || Promise.resolve())
      .catch(() => {})
      .then(() => atomic(stateFile(id), value));
    reports.set(id, next);
    return next;
  };
  const catalogArtifacts = new Map<ComponentId, Artifact>();
  const legacyCache = new Map<ComponentId, { at: number; selection: string; value?: { version: string } }>();
  async function status(id: ComponentId): Promise<ComponentState> {
    const current: Record<string, unknown> = await json(join(base(id), "current.json")).catch(() => ({}));
    const progress: Record<string, unknown> = await json(stateFile(id)).catch(() => ({}));
    const version =
      current.apiVersion === 1 &&
      (id === "pptist" || current.platform === platform) &&
      typeof current.version === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(current.version)
        ? current.version
        : undefined;
    const packaged = packagedComponentDirectory(id);
    let managedAvailable = false;
    if (!packaged && version && current.enabled !== false) {
      try {
        if ((await lstat(base(id))).isSymbolicLink()) throw new Error("Unsafe component storage");
        if ((await lstat(join(base(id), "versions"))).isSymbolicLink())
          throw new Error("Unsafe component versions");
        const executable = await realpath(join(base(id), "versions", version, entry[id]));
        managedAvailable = executable.startsWith((await realpath(base(id))) + sep);
      } catch {
        /* Missing/corrupt component does not block the base program. */
      }
    }
    const explicit =
      id === "cadquery"
        ? process.env.COWORK_CADQUERY_PYTHON
        : id === "blender"
          ? process.env.COWORK_BLENDER_EXECUTABLE
          : undefined;
    const selection = `${explicit || ""}:${packaged || ""}:${version || ""}:${managedAvailable}`;
    const probeSelected = explicit || packaged || !version || (id === "blender" && !managedAvailable);
    if (
      probeSelected &&
      current.enabled !== false &&
      (explicit ||
        legacyCache.get(id)?.selection !== selection ||
        Date.now() - legacyCache.get(id)!.at > 10_000)
    )
      legacyCache.set(id, { at: Date.now(), selection, value: await legacy(id) });
    const existing = probeSelected ? legacyCache.get(id)?.value : undefined;
    const available =
      current.enabled !== false &&
      (explicit || packaged ? Boolean(existing) : managedAvailable || Boolean(existing));
    let locked = false;
    try {
      const owner = await json(join(base(id), ".install-lock.lock/owner.json"));
      if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) {
        try {
          process.kill(Number(owner.pid), 0);
          locked = true;
        } catch (error) {
          locked = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
    } catch {
      /* Abandoned install locks are recovered by the next installation. */
    }
    const installing = jobs.has(id) || locked;
    return {
      id,
      version:
        explicit || packaged || existing
          ? existing?.version
          : typeof current.runtimeVersion === "string"
            ? current.runtimeVersion
            : version || catalogArtifacts.get(id)?.version,
      managed: !explicit && !packaged && !existing && Boolean(version),
      bundled: Boolean(packaged),
      available,
      enabled: current.enabled !== false,
      supported: supported(id),
      dependencies: dependencies[id],
      phase: installing
        ? String(progress.phase || "checking")
        : !packaged && ["failed", "cancelled"].includes(String(progress.phase))
          ? String(progress.phase)
          : available
            ? "ready"
            : current.enabled === false
              ? "disabled"
              : packaged || progress.phase === "ready"
                ? "missing"
                : String(progress.phase || "missing"),
      message: String(
        (explicit
          ? available
            ? "使用用户显式指定的外部组件；版本与发行受管环境独立"
            : "显式组件路径不可用；请修复或撤销 COWORK_CADQUERY_PYTHON/COWORK_BLENDER_EXECUTABLE 覆盖"
          : packaged && !installing
            ? current.enabled === false
              ? "CoworkOS 内置组件已停用；可在设置中启用"
              : available
                ? "使用 CoworkOS 内置组件，随 CoworkOS 更新"
                : "CoworkOS 内置组件缺失或无法运行；请修复完整安装包"
            : !available && progress.phase === "ready"
              ? "组件文件缺失；请重新安装修复"
              : progress.message) ||
          (available
            ? existing
              ? "检测到兼容已有组件；复用当前环境"
              : "组件可用"
            : "按需安装组件；基础任务可继续使用")
      ),
      installing,
      ...(typeof progress.progress === "number" ? { progress: progress.progress } : {}),
      ...(typeof current.downloadBytes === "number"
        ? { downloadBytes: current.downloadBytes }
        : catalogArtifacts.has(id)
          ? { downloadBytes: catalogArtifacts.get(id)!.downloadBytes }
          : {}),
      ...(typeof current.installedBytes === "number"
        ? { installedBytes: current.installedBytes }
        : catalogArtifacts.has(id)
          ? { installedBytes: catalogArtifacts.get(id)!.installedBytes }
          : {})
    };
  }
  async function installLock(target: string, job: () => Promise<void>, signal: AbortSignal) {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      try {
        return await withFileLock(target, job, { recoverDeadOwner: true, timeoutMs: 1000 });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("timed out acquiring file lock:"))
          throw error;
      }
    }
    throw new Error("Another component installation is still active; check status or cancel it");
  }
  function install(id: ComponentId, upgrade = false, automatic = false): Promise<void> {
    if (closed) throw new Error("Component service is shutting down; reopen CoworkOS to install");
    if (packagedComponentDirectory(id))
      throw new Error("内置组件随 CoworkOS 更新；请重新安装完整安装包以修复组件");
    if (jobs.has(id)) return jobs.get(id)!.promise;
    if (!supported(id))
      throw new Error("Component installation currently supports Apple Silicon macOS 14 or later");
    const controller = new AbortController(),
      signal = controller.signal;
    const promise = mkdir(base(id), { recursive: true })
      .then(async () => {
        if ((await lstat(base(id))).isSymbolicLink())
          throw new Error("Component storage must not be a symlink");
        return installLock(
          join(base(id), ".install-lock"),
          async () => {
            signal.throwIfAborted();
            const selected = await status(id);
            // A user can cancel while a legacy runtime probe is still running.
            // Preserve their cancellation marker instead of clearing it below.
            signal.throwIfAborted();
            // Recheck inside the installation lock: a queued background job must
            // honor a disable/cancel that happened after its initial status read.
            if (
              automatic &&
              (!selected.enabled ||
                (await access(join(base(id), "cancel")).then(
                  () => true,
                  () => false
                )))
            )
              return;
            const explicit =
              id === "cadquery"
                ? process.env.COWORK_CADQUERY_PYTHON
                : id === "blender"
                  ? process.env.COWORK_BLENDER_EXECUTABLE
                  : undefined;
            if (explicit) {
              if (!selected.available) throw new Error(selected.message);
              return;
            }
            if (!upgrade && selected.available) return;
            if (!automatic) await rm(join(base(id), "cancel"), { force: true });
            const poll = setInterval(() => {
              void access(join(base(id), "cancel")).then(
                () => controller.abort(userCancellation),
                () => {}
              );
            }, 100);
            poll.unref();
            const staging = join(base(id), `.staging-${randomUUID()}`);
            try {
              await report(id, { phase: "checking", message: "正在检查兼容组件" });
              let version: string, metadata: Record<string, unknown>;
              if (id === "blender") {
                version = "4.5.11";
                metadata = { version, platform, hostVersion, apiVersion: 1 };
                let downloadBytes = blenderSource.downloadBytes || 0;
                for (const url of downloadBytes ? [] : blenderSource.urls) {
                  const response = await fetcher(url, {
                    method: "HEAD",
                    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                  }).catch(() => undefined);
                  const bytes = Number(response?.headers.get("content-length"));
                  if (response?.ok && Number.isSafeInteger(bytes) && bytes > 0) {
                    downloadBytes = bytes;
                    break;
                  }
                }
                if (!downloadBytes)
                  throw new Error("Could not determine Blender download size; check network and retry");
                if ((await freeBytes(base(id))) < downloadBytes * 8)
                  throw new Error(
                    "Insufficient disk space for Blender staging; existing runtime is preserved"
                  );
                metadata.downloadBytes = downloadBytes;
                await installBlender({
                  directory: staging,
                  signal,
                  source: blenderSource,
                  fetcher,
                  report: (p) => {
                    void report(id, p).catch(() => {});
                  }
                });
                const directoryBytes = async (path: string): Promise<number> => {
                  const info = await lstat(path);
                  return info.isDirectory()
                    ? (
                        await Promise.all(
                          (await readdir(path)).map((name) => directoryBytes(join(path, name)))
                        )
                      ).reduce((a, b) => a + b, 0)
                    : info.size;
                };
                metadata.installedBytes = await directoryBytes(staging);
              } else {
                const response = await download(
                  "atria-components-darwin-arm64.json",
                  AbortSignal.any([signal, AbortSignal.timeout(30_000)])
                );
                if (!response.ok)
                  throw new Error(
                    `Component catalog unavailable (HTTP ${response.status}); retry after checking network/release assets`
                  );
                const catalog = (await componentJson(response)) as { artifacts?: unknown[] };
                const artifact = validateArtifact(
                  catalog.artifacts?.find(
                    (v) => v !== null && typeof v === "object" && (v as Artifact).id === id
                  ),
                  id,
                  hostVersion,
                  id === "pptist" ? "any" : platform
                );
                catalogArtifacts.set(id, artifact);
                version = `${artifact.version}-${artifact.sha256.slice(0, 16)}`;
                metadata = { ...artifact, runtimeVersion: artifact.version, version };
                if ((await freeBytes(base(id))) < artifact.downloadBytes + artifact.installedBytes * 2)
                  throw new Error(
                    "Insufficient disk space for component staging; existing component is preserved"
                  );
                await mkdir(staging);
                const archive = join(base(id), `.download-${randomUUID()}.tar.gz`);
                try {
                  const result = await download(
                    artifact.file,
                    AbortSignal.any([signal, AbortSignal.timeout(300_000)])
                  );
                  if (!result.ok || !result.body)
                    throw new Error(`Component download failed (HTTP ${result.status})`);
                  let bytes = 0;
                  const hash = createHash("sha256");
                  const meter = new Transform({
                    transform(chunk, _encoding, done) {
                      bytes += chunk.length;
                      hash.update(chunk);
                      if (bytes > artifact.downloadBytes)
                        return done(new Error("Component download exceeds declared size"));
                      void report(id, {
                        phase: "downloading",
                        message: "正在下载组件",
                        progress: Math.floor((100 * bytes) / artifact.downloadBytes)
                      }).catch(() => {});
                      done(null, chunk);
                    }
                  });
                  await pipeline(
                    Readable.fromWeb(
                      result.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>
                    ),
                    meter,
                    createWriteStream(archive, { flags: "wx" }),
                    { signal }
                  ).catch((error) => {
                    if (
                      error instanceof Error &&
                      error.message === "Component download exceeds declared size"
                    )
                      throw error;
                    throw new Error("Component archive download interrupted; check network and retry");
                  });
                  if (bytes !== artifact.downloadBytes || hash.digest("hex") !== artifact.sha256)
                    throw new Error("Component integrity verification failed");
                  const listing = await run("tar", ["-tzf", archive], signal);
                  const names = listing.trim().split("\n");
                  if (
                    names.some(
                      (name) =>
                        !name ||
                        /[\x00-\x1f\x7f\\]/.test(name) ||
                        name.startsWith("/") ||
                        name.split("/").includes("..")
                    )
                  )
                    throw new Error("Unsafe component archive path");
                  const verbose = (await run("tar", ["-tvzf", archive], signal)).trim().split("\n");
                  if (verbose.length !== names.length) throw new Error("Invalid component archive inventory");
                  for (let index = 0; index < names.length; index++) {
                    const line = verbose[index],
                      name = names[index],
                      type = line[0];
                    if (!["-", "d", "l", "h"].includes(type))
                      throw new Error("Unsupported component archive entry");
                    if (type === "l" || type === "h") {
                      const separator = type === "l" ? " -> " : " link to ";
                      const offset = line.lastIndexOf(name + separator);
                      if (offset < 0) throw new Error("Invalid component archive link");
                      const target = line.slice(offset + name.length + separator.length);
                      const destination = posix.normalize(
                        type === "l" ? posix.join(posix.dirname(name), target) : target
                      );
                      if (
                        !target ||
                        target.startsWith("/") ||
                        /[\x00-\x1f\x7f\\]/.test(target) ||
                        destination === ".." ||
                        destination.startsWith("../")
                      )
                        throw new Error("Unsafe component archive link");
                    }
                  }
                  await report(id, { phase: "installing", message: "正在安装与验证组件" });
                  await run("tar", ["-xzf", archive, "-C", staging], signal);
                  await access(join(staging, entry[id]));
                  if (id === "cadquery") {
                    const actual = await run(
                      join(staging, entry[id]),
                      [
                        "-I",
                        "-B",
                        "-c",
                        'import cadquery as cq; assert cq.Workplane("XY").box(2,3,4).val().isValid(); print(cq.__version__)'
                      ],
                      signal
                    );
                    if (actual.trim() !== "2.6.1") throw new Error("CadQuery runtime version check failed");
                  } else {
                    await access(join(staging, "LICENSE.txt"));
                    await access(join(staging, "source.tar.gz"));
                  }
                } finally {
                  await rm(archive, { force: true });
                }
              }
              signal.throwIfAborted();
              await mkdir(join(base(id), "versions"), { recursive: true });
              if ((await lstat(join(base(id), "versions"))).isSymbolicLink())
                throw new Error("Component versions directory must not be a symlink");
              const target = join(base(id), "versions", version);
              await rename(staging, target).catch(async (error) => {
                if (
                  (error as NodeJS.ErrnoException).code !== "EEXIST" &&
                  (error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
                )
                  throw error;
                // Never reactivate an unverified existing directory. Preserve it while
                // activating the freshly verified replacement under an immutable slot.
                const replacement = `${version}-repair-${randomUUID().slice(0, 8)}`;
                await rename(staging, join(base(id), "versions", replacement));
                metadata.runtimeVersion ??= metadata.version;
                metadata.version = replacement;
              });
              await atomic(join(base(id), "current.json"), { ...metadata, enabled: true });
              await report(id, { phase: "ready", message: "组件可用" });
            } catch (error) {
              await report(id, {
                phase: signal.aborted ? "cancelled" : "failed",
                message: error instanceof Error ? error.message : "安装失败"
              });
              throw error;
            } finally {
              clearInterval(poll);
              await rm(staging, { recursive: true, force: true });
            }
          },
          signal
        );
      })
      .finally(async () => {
        try {
          // A manual retry may have been clearing the old marker when a new
          // user cancellation arrived. Reassert that intent after all job I/O.
          if (signal.reason === userCancellation) await writeFile(join(base(id), "cancel"), "");
        } finally {
          jobs.delete(id);
        }
      });
    jobs.set(id, { promise, controller });
    return promise;
  }
  async function action(id: ComponentId, operation: string): Promise<ComponentState> {
    if (operation === "install" || operation === "upgrade") {
      void install(id, operation === "upgrade").catch(() => {});
    } else if (operation === "cancel") {
      await mkdir(base(id), { recursive: true });
      if ((await lstat(base(id))).isSymbolicLink())
        throw new Error("Component storage must not be a symlink");
      jobs.get(id)?.controller.abort(userCancellation);
      await writeFile(join(base(id), "cancel"), "");
    } else if (["enable", "disable", "uninstall"].includes(operation)) {
      if (operation === "uninstall" && packagedComponentDirectory(id))
        throw new Error("完整安装包的内置组件可停用；更换为轻量安装包可释放组件空间");
      if ((await status(id)).installing)
        throw new Error(
          "Component installation is active; cancel it before changing activation or uninstalling"
        );
      await mkdir(base(id), { recursive: true });
      if ((await lstat(base(id))).isSymbolicLink())
        throw new Error("Component storage must not be a symlink");
      await withFileLock(
        join(base(id), ".install-lock"),
        async () => {
          const current: Record<string, unknown> = await json(join(base(id), "current.json")).catch(
            () => ({})
          );
          await atomic(join(base(id), "current.json"), { ...current, enabled: operation === "enable" });
          if (operation === "uninstall") {
            await rm(join(base(id), "versions"), { recursive: true, force: true });
            await atomic(join(base(id), "current.json"), { enabled: false });
            await report(id, { phase: "missing", message: "组件已卸载；文档、任务与历史保留" });
          }
        },
        { recoverDeadOwner: true }
      );
    } else throw new Error("Unsupported component action");
    return status(id);
  }
  async function list(refresh = false, probe = false) {
    if (probe) legacyCache.clear();
    if (refresh) {
      const response = await download("atria-components-darwin-arm64.json", AbortSignal.timeout(30_000));
      if (!response.ok)
        throw new Error(
          `Component catalog unavailable (HTTP ${response.status}); local installed components remain usable`
        );
      const catalog = (await componentJson(response)) as { artifacts?: unknown[] };
      for (const id of ["cadquery", "pptist"] as const) {
        if (!supported(id)) continue;
        const artifact = validateArtifact(
          catalog.artifacts?.find((v) => v !== null && typeof v === "object" && (v as Artifact).id === id),
          id,
          hostVersion,
          id === "pptist" ? "any" : platform
        );
        catalogArtifacts.set(id, artifact);
      }
      if (supported("blender")) {
        const bytes = blenderSource.downloadBytes;
        if (bytes && Number.isSafeInteger(bytes) && bytes > 0) {
          catalogArtifacts.set("blender", {
            apiVersion: 1,
            id: "blender",
            version: "4.5.11",
            hostVersion,
            platform,
            file: blenderSource.file,
            sha256: blenderSource.sha256,
            downloadBytes: bytes,
            installedBytes: bytes * 8
          });
        }
      }
    }
    return Promise.all(componentIds.map(status));
  }
  return {
    status,
    install,
    action,
    list,
    /** Called by a listening packaged desktop host, never during import or CLI construction. */
    prepareMissing(ids: readonly ComponentId[] = componentIds): Promise<void> {
      if (closed) return Promise.resolve();
      preparation ??= (async () => {
        // Sequential jobs avoid competing multi-hundred-MB downloads on first launch.
        for (const id of ids) {
          if (closed) return;
          const selected = await status(id);
          if (closed) return;
          const cancelled = await access(join(base(id), "cancel")).then(
            () => true,
            () => false
          );
          if (closed) return;
          if (!selected.supported || !selected.enabled || selected.available || cancelled) continue;
          try {
            await install(id, false, true);
          } catch {
            // A missing component or concurrent shutdown cannot block later startup work.
          }
        }
      })();
      return preparation;
    },
    async stop() {
      closed = true;
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map((j) => j.promise));
      await Promise.allSettled([preparation]);
    }
  };
}
export { BLENDER_INSTALL_SOURCE };

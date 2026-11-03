import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { launchMacApplication } from "./mac-application-launch.mjs";

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error("无法确认原 App 是否退出，未修改开发运行时。");
  }
}

export async function waitForExit(pid, { timeoutMs = 120_000, pollMs = 250, isAlive = running } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error("开发 App 的进程 ID 无效，未执行重启。");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0)
    throw new Error("开发重启的等待参数无效。");
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("原 App 尚未退出，开发运行时保持原样。请退出 App 后重新启动。");
    await delay(Math.min(pollMs, remaining));
  }
}

function finderDirectory(root, entry) {
  if (!entry) return undefined;
  if (
    !isAbsolute(entry) ||
    !["CoworkOS Dev", "Atria Dev"].some((name) =>
      entry.endsWith(`${sep}${name}.app${sep}Contents${sep}MacOS${sep}${name}`)
    )
  )
    throw new Error("开发 App 入口无效，未修改任何应用。");
  const executable = resolve(entry);
  const cache = resolve(root, ".tmp/desktop-runtime");
  const location = relative(cache, executable);
  if (!location.startsWith(`..${sep}`) && location !== ".." && !isAbsolute(location)) return undefined;
  const bundle = resolve(executable, "../../..");
  return dirname(bundle);
}

function runtimePaths(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("开发重启的运行数据路径无效。");
  for (const [name, value] of Object.entries(input)) {
    if (
      !["COWORK_DESKTOP_DATA", "COWORK_WORKSPACE"].includes(name) ||
      typeof value !== "string" ||
      !isAbsolute(value) ||
      value.includes("\0")
    )
      throw new Error("开发重启仅允许恢复 App 数据和工作区的绝对路径。");
  }
  return { ...input };
}

export function developmentLaunchEnvironment({ root, toolchain, runtimeEnvironment }, input = process.env) {
  const inherited = { ...input };
  for (const name of Object.keys(inherited))
    if (/^(?:COWORK_|PI_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)) delete inherited[name];
  const env = {
    ...inherited,
    ...runtimePaths(runtimeEnvironment),
    COWORK_DESKTOP_DEV: "1",
    COWORK_DESKTOP_SOURCE_ROOT: root,
    COWORK_DESKTOP_NODE_EXECUTABLE: toolchain.nodeExecutable
  };
  if (toolchain.npmCli) env.COWORK_DESKTOP_NPM_CLI = toolchain.npmCli;
  return env;
}

async function launchDevelopment(executable, options) {
  const { root } = options;
  const env = developmentLaunchEnvironment(options);
  if (process.platform === "darwin")
    return launchMacApplication(executable, { args: [root], env, cwd: root });
  return new Promise((done, reject) => {
    const child = spawn(executable, [root], { cwd: root, env, detached: true, stdio: "ignore" });
    child.once("error", () =>
      reject(new Error("新版开发运行时已准备好，但 App 启动失败。请从原入口重新打开。"))
    );
    child.once("spawn", () => {
      child.unref();
      done();
    });
  });
}

/** Run outside Electron so the old process can fully exit before replacing its runtime. */
export async function restartDevelopment({
  root,
  pid,
  entry,
  nodeExecutable,
  npmCli,
  runtimeEnvironment,
  timeoutMs,
  pollMs,
  waitForExitImpl = waitForExit,
  installDevelopmentAppImpl,
  developmentExecutableImpl,
  launchImpl = launchDevelopment
}) {
  if (
    !root ||
    !isAbsolute(root) ||
    !nodeExecutable ||
    !isAbsolute(nodeExecutable) ||
    (npmCli && !isAbsolute(npmCli))
  )
    throw new Error("开发重启缺少有效的源码或 Node/npm 工具链路径。");
  root = resolve(root);
  runtimeEnvironment = runtimePaths(runtimeEnvironment);
  const directory = finderDirectory(root, entry);
  const toolchain = { nodeExecutable, ...(npmCli ? { npmCli } : {}) };
  await waitForExitImpl(pid, { timeoutMs, pollMs });
  let implementation;
  // Import the newly updated helper only after the old runtime has exited.
  if (!(directory ? installDevelopmentAppImpl : developmentExecutableImpl))
    implementation = await import(pathToFileURL(join(root, "scripts/desktop-dev.mjs")).href);
  const executable = directory
    ? await (installDevelopmentAppImpl ?? implementation.installDevelopmentApp)({
        root,
        directory,
        toolchain
      })
    : await (developmentExecutableImpl ?? implementation.developmentExecutable)({ root, toolchain });
  await launchImpl(executable, { root, toolchain, runtimeEnvironment });
  return { restarted: true, executable };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = process.argv[2];
    if (!config || !isAbsolute(config) || process.argv.length !== 3)
      throw new Error("Usage: node restart-development.mjs /absolute/restart-config.json");
    await restartDevelopment(JSON.parse(await readFile(config, "utf8")));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

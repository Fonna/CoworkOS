import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]
  );

export function serviceDefinition({
  workspace,
  config,
  port = 3884,
  globalIndex,
  tabsIndex,
  root = harnessRoot,
  node = process.execPath,
  home = homedir(),
  path = process.env.PATH
} = {}) {
  if (!workspace || !config || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("需要 --workspace、--config 和有效的 --port");
  const work = resolve(workspace);
  const key = createHash("sha256").update(work).digest("hex").slice(0, 12);
  const label = `org.atria.cowork.monitor.${key}`;
  const logs = join(work, ".service");
  const env = {
    COWORK_CONFIG: resolve(config),
    COWORK_WORKSPACE: work,
    COWORK_GLOBAL_INDEX: globalIndex ? resolve(globalIndex) : join(logs, "workspaces.json"),
    COWORK_TABS_INDEX: tabsIndex ? resolve(tabsIndex) : join(logs, "tabs.json"),
    COWORK_UI_PORT: String(port),
    COWORK_DISABLE_WATCH_SUPERVISOR: "0",
    COWORK_SUPERVISOR_INTERVAL_MS: "60000",
    HOME: home,
    PATH: path ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  };
  const args = [node, join(root, "dist", "src", "cli", "dashboard.js")];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(logs, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "stderr.log"))}</string>
</dict></plist>\n`;
  return { label, logs, plist, plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`) };
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help") {
    console.log(
      "macOS 用户级持续监控服务：install | status | stop | uninstall --workspace <绝对路径> --config <配置路径> [--port 3884] [--global-index <路径>] [--tabs-index <路径>]"
    );
    return;
  }
  if (process.platform !== "darwin") throw new Error("当前服务管理入口适用于 macOS launchd");
  if (!["install", "status", "stop", "uninstall"].includes(command)) throw new Error("未知服务操作");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || !args[i + 1]) throw new Error("服务参数需要 --名称 值");
    options[args[i].slice(2)] = args[i + 1];
  }
  const service = serviceDefinition({
    ...options,
    port: Number(options.port ?? 3884),
    globalIndex: options["global-index"],
    tabsIndex: options["tabs-index"]
  });
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${service.label}`;
  const run = (...arguments_) => spawnSync("launchctl", arguments_, { encoding: "utf8" });
  if (command === "install") {
    await access(join(harnessRoot, "dist", "src", "cli", "dashboard.js"));
    try {
      JSON.parse(await readFile(resolve(options.config), "utf8"));
    } catch {
      throw new Error("服务配置文件无法读取或不是有效 JSON");
    }
    await mkdir(service.logs, { recursive: true });
    await mkdir(dirname(service.plistPath), { recursive: true });
    run("bootout", target);
    await writeFile(service.plistPath, service.plist, { mode: 0o600 });
    const result = run("bootstrap", domain, service.plistPath);
    if (result.status !== 0) throw new Error(`launchd 启动失败：${result.stderr.trim()}`);
  } else if (command === "stop" || command === "uninstall") {
    run("bootout", target);
    if (command === "uninstall") await rm(service.plistPath, { force: true });
  }
  const printed = run("print", target);
  console.log(
    JSON.stringify({
      label: service.label,
      plistPath: service.plistPath,
      loaded: printed.status === 0,
      state: printed.stdout.match(/\n\s*state = (.+)/)?.[1],
      pid: Number(printed.stdout.match(/\n\s*pid = (\d+)/)?.[1]) || undefined
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

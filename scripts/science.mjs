import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atriaHome } from "./data-home.cjs";

const help = `Usage: coworkos science status
       coworkos science install general|chemistry [--python PATH] [--reinstall]
       coworkos science cancel general|chemistry

Install fixed scientific dependencies into separate CoworkOS-managed environments.
Requires an existing Python 3.10+ with venv and network access to PyPI.
--python selects the base interpreter; otherwise use COWORK_SCIENCE_PYTHON,
or COWORK_SCIENCE_CHEMISTRY_PYTHON for chemistry, then python3.
Installation never changes system packages, settings, or existing Run selections.
--reinstall creates a new verified environment and preserves the previous one.
After installation select the reported Python in scientific settings, or use
COWORK_SCIENCE_PYTHON / COWORK_SCIENCE_CHEMISTRY_PYTHON for new Runs.
ATRIA_HOME selects shared App/CLI storage. Ctrl-C safely cancels this installation.`;

export async function runScience(args) {
  if (args.some((arg) => ["--help", "-h"].includes(arg))) {
    console.log(help);
    return;
  }
  const [action = "status", target, ...rest] = args;
  let python;
  let reinstall = false;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--python" && !python && rest[index + 1] && !rest[index + 1].startsWith("--"))
      python = rest[++index];
    else if (rest[index] === "--reinstall" && !reinstall) reinstall = true;
    else throw new Error("Invalid scientific environment command; use coworkos science --help");
  }
  if (
    !["status", "install", "cancel"].includes(action) ||
    (action === "status" && (target || rest.length)) ||
    (action !== "status" && !["general", "chemistry"].includes(target)) ||
    (rest.length && action !== "install")
  )
    throw new Error("Invalid scientific environment command; use coworkos science --help");
  const { createScienceInstallation } = await import("../dist/src/runtime/science-installation.js");
  const service = createScienceInstallation({ root: join(atriaHome(), "science-environments") });
  if (action === "status") {
    console.log(JSON.stringify(await service.status(), null, 2));
    return;
  }
  if (action === "cancel") {
    console.log(JSON.stringify(await service.cancel(target), null, 2));
    return;
  }
  const pythonExecutable =
    python ||
    (target === "chemistry" ? process.env.COWORK_SCIENCE_CHEMISTRY_PYTHON : undefined) ||
    process.env.COWORK_SCIENCE_PYTHON ||
    "python3";
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void service.cancel(target).catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    let state = await service.install({
      target,
      pythonExecutable,
      ...(reinstall ? { reinstall: true } : {})
    });
    let phase;
    while (state.state === "installing") {
      if (phase !== state.phase) {
        phase = state.phase;
        console.error(`${target}: ${phase || "preparing"}`);
      }
      if (interrupted) await service.cancel(target);
      await delay(250);
      state = (await service.status())[target];
    }
    console.log(JSON.stringify(state, null, 2));
    if (state.state !== "ready") process.exitCode = interrupted ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await service.stop();
  }
}

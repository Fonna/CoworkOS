import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Own only the launched SDK process. The readiness handshake cannot start a
// supervisor until the child has verified and loaded the reviewed UI target.
export async function runCliProcess({
  executable,
  bootstrap,
  args,
  env,
  projectDirectory,
  uiCompatibility = false,
  onSdkReady,
  onStop
}) {
  const token = uiCompatibility ? randomUUID() : undefined;
  const child = spawn(process.execPath, [...(bootstrap ? [bootstrap] : []), executable, ...args], {
    cwd: projectDirectory,
    env: { ...env, ...(token ? { ATRIA_CLI_UI_READY_TOKEN: token } : {}) },
    stdio: token ? ["inherit", "inherit", "inherit", "ipc"] : "inherit"
  });
  let ready = false;
  let stopping = false;
  const stop = () => {
    stopping = true;
    onStop?.();
    child.kill("SIGTERM");
  };
  const acknowledge = (message) => {
    if (!ready && !stopping && message?.type === "atria.cli.uiReady" && message.token === token) {
      ready = true;
      onSdkReady?.();
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (token) child.on("message", acknowledge);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    child.off("message", acknowledge);
  }
}

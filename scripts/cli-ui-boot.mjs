import { fileURLToPath } from "node:url";
import { preflightCliUi, installCliUiHook } from "./cli-ui-compatibility.mjs";
import { reportCliStartupError } from "./cli-startup-error.mjs";
import { preflightCliShell } from "./cli-shell-compatibility.mjs";

// Registration precedes the first SDK import. Hooks live only in this process;
// NODE_OPTIONS/execArgv and worker/tool environments receive no preloading flag.
try {
  const readyToken = process.env.ATRIA_CLI_UI_READY_TOKEN;
  delete process.env.ATRIA_CLI_UI_READY_TOKEN;
  const compatibility = preflightCliUi();
  const shell = preflightCliShell();
  installCliUiHook(
    compatibility,
    () => {
      if (process.connected && readyToken)
        process.send({ type: "atria.cli.uiReady", token: readyToken }, () => {});
    },
    shell.targets
  );
  process.argv = [process.execPath, fileURLToPath(compatibility.entryURL), ...process.argv.slice(2)];
  await import(compatibility.entryURL);
} catch (error) {
  reportCliStartupError(error);
  process.exitCode = 1;
}

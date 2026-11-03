import {
  classifyCliInformation,
  printAtriaHelp,
  printAtriaVersion,
  isInteractiveCli,
  scanCliArguments
} from "./cli-information.mjs";
import { reportCliStartupError } from "./cli-startup-error.mjs";

// Version/help must work before loading dist, SDK, configuration or mutable state.
try {
  const information = classifyCliInformation(process.argv.slice(2));
  if (information === "version") await printAtriaVersion();
  else if (information === "help") printAtriaHelp();
  else {
    let uiCompatibility;
    if (isInteractiveCli(process.argv.slice(2), process.stdin.isTTY, process.stdout.isTTY)) {
      const { preflightCliUi } = await import("./cli-ui-compatibility.mjs");
      uiCompatibility = preflightCliUi();
    }
    if (!scanCliArguments(process.argv.slice(2)).has("--list-models")) {
      const { preflightCliShell } = await import("./cli-shell-compatibility.mjs");
      preflightCliShell();
    }
    const { startPi } = await import("./start-pi-runtime.mjs");
    await startPi({ uiCompatibility });
  }
} catch (error) {
  reportCliStartupError(error);
  process.exitCode = 1;
}

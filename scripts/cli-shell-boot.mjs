import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { preflightCliShell } from "./cli-shell-compatibility.mjs";
import { installCliSourceHooks } from "./cli-ui-compatibility.mjs";
import { reportCliStartupError } from "./cli-startup-error.mjs";

// An ordinary entry keeps the hook local, without inheritable preload flags.
try {
  const executable = process.argv[2];
  const entryURL = pathToFileURL(realpathSync(executable)).href;
  installCliSourceHooks(preflightCliShell().targets);
  process.argv = [process.execPath, executable, ...process.argv.slice(3)];
  await import(entryURL);
} catch (error) {
  reportCliStartupError(error);
  process.exitCode = 1;
}

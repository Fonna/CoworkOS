import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Invoke npm's JavaScript entry directly: Windows batch shims need a shell. */
export function npmCommand(args) {
  const cli = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  ].find((path) => path?.endsWith("npm-cli.js") && existsSync(path));
  if (cli) return { command: process.execPath, args: [cli, ...args] };
  if (process.platform === "win32")
    throw new Error("Cannot locate npm-cli.js; run this command through npm.");
  return { command: "npm", args };
}

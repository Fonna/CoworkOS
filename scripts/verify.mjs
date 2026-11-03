import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, runCommand } from "./test.mjs";

export const verificationScripts = [
  "build:full",
  "lint",
  "check:workbench",
  "check:extensions",
  "format:check",
  "check:docs",
  "check:source",
  "test:release:runner"
];

export async function verify(args = process.argv.slice(2), run = runCommand) {
  if (args.some((argument) => argument !== "--list" && argument !== "--help" && argument !== "-h"))
    throw new Error("verify accepts only --list or --help; use test:unit for focused checks");
  const steps = [
    ...verificationScripts.map((script) => ({
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", script]
    })),
    { command: process.execPath, args: ["scripts/test.mjs"] }
  ];
  if (args.length) {
    console.log(
      "Local verification builds once, checks lint/types/changed-file format/docs/source hygiene, then runs all deterministic Node tests."
    );
    for (const step of steps) console.log(`${step.command} ${step.args.join(" ")}`);
    console.log(
      "Browser, native windows, real model calls and release/install evidence use explicit separate commands."
    );
    return 0;
  }
  for (const step of steps) {
    console.log(`\nVerify: ${step.command} ${step.args.join(" ")}`);
    const code = await run(step.command, step.args, { root: repositoryRoot });
    if (code !== 0) return code;
  }
  console.log(
    "\nLocal verification passed. Review skipped Node checks and run the relevant browser/native/release layer."
  );
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verify()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { discoverAssets } from "./discover_assets.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export async function checkBackend(env = process.env) {
  const result = [];

  try {
    result.push({ kind: "pptxgenjs", available: true, path: require.resolve("pptxgenjs") });
  } catch {
    result.push({ kind: "pptxgenjs", available: false });
  }

  for (const [kind, executable, args] of [
    ["python3", env.COWORK_PYTHON_PATH || "python3", ["--version"]],
    ["soffice", env.COWORK_SOFFICE_PATH || "soffice", ["--version"]],
    ["pdftoppm", env.COWORK_PDFTOPPM_PATH || "pdftoppm", ["-v"]]
  ]) {
    try {
      const output = await exec(executable, args, { timeout: 5_000, maxBuffer: 16_384 });
      result.push({
        kind,
        available: true,
        version: `${output.stdout}${output.stderr}`.trim().split("\n")[0]
      });
    } catch (error) {
      const failure = error;
      if (failure?.code === 0) result.push({ kind, available: true });
      else result.push({ kind, available: false });
    }
  }

  return {
    create: result.find((item) => item.kind === "pptxgenjs")?.available === true,
    render: ["soffice", "pdftoppm", "python3"].every(
      (kind) => result.find((item) => item.kind === kind)?.available === true
    ),
    renderPdf: ["pdftoppm", "python3"].every(
      (kind) => result.find((item) => item.kind === kind)?.available === true
    ),
    validate: result.find((item) => item.kind === "python3")?.available === true,
    backends: result,
    assets: await discoverAssets(process.cwd())
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await checkBackend(), null, 2));
}

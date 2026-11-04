import { execFileSync } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanCompiled } from "./clean-compiled.mjs";
import { buildScienceRuntime } from "./build-science.mjs";

// Headless CAD remains available; browser bundles, icons and Swift helpers are optional hosts.
await cleanCompiled();
execFileSync(process.execPath, ["scripts/build-cad-runtime.mjs"], { stdio: "inherit" });
execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
  stdio: "inherit"
});
const { buildCliUiManifest } = await import("./build-cli-ui.mjs");
await buildCliUiManifest();
await buildScienceRuntime();
const { CADQUERY_RUNNER_FILE } = await import("../dist/src/software/cad/compute-limits.js");
for (const [source, target] of [
  ["src/software/cad/cadquery-runner.py", `dist/src/software/cad/${CADQUERY_RUNNER_FILE}`],
  ["src/software/blender/runner.py", "dist/src/software/blender/runner.py"],
  ["src/security/wsl-blender-job.py", "dist/src/security/wsl-blender-job.py"]
]) {
  await mkdir(resolve(target, ".."), { recursive: true });
  await copyFile(source, target);
}

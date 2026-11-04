import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { CADQUERY_RUNNER_FILE } from "../dist/src/software/cad/compute-limits.js";
const outdir = "web/assets/cad/generated";
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: {
    model: "src/software/cad/model.ts",
    program: "src/software/cad/program.ts",
    migration: "src/software/cad/program-migration.ts",
    interaction: "src/software/cad/interaction.ts",
    worker: "web/assets/cad/worker.js",
    viewport: "web/assets/cad/viewport.js",
    "blender-viewport": "web/assets/blender/viewport.js"
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir,
  minify: true,
  legalComments: "eof"
});
const packages = [
  "@jscad/modeling",
  "@jscad/stl-serializer",
  "@jscad/array-utils",
  "three",
  "quickjs-emscripten",
  "@jitl/quickjs-singlefile-browser-release-sync"
];
const notices = await Promise.all(
  packages.map(async (name) => {
    const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8"));
    return `${name} ${pkg.version}\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`;
  })
);
await writeFile(`${outdir}/THIRD_PARTY_LICENSES.txt`, notices.join("\n\n"));

await copyFile("src/software/cad/cadquery-runner.py", `dist/src/software/cad/${CADQUERY_RUNNER_FILE}`);
await copyFile("src/software/blender/runner.py", "dist/src/software/blender/runner.py");
await mkdir("dist/src/security", { recursive: true });
await copyFile("src/security/wsl-blender-job.py", "dist/src/security/wsl-blender-job.py");

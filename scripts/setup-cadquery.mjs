import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("The bundled native CAD runtime currently targets macOS arm64");
const target = resolve(".tools/cadquery-runtime");
const run = (args) => execFileSync("uv", args, { stdio: "inherit" });
const downloads = resolve(".tools/cadquery-python");
await mkdir(downloads, { recursive: true });
// Standalone CPython, not a venv pointing at the developer's machine.
run(["python", "install", "3.11.15", "--install-dir", downloads]);
const directory = (await readdir(downloads)).find((name) => name.startsWith("cpython-3.11.15-"));
if (!directory) throw new Error("Standalone Python download not found");
if (!existsSync(join(target, "bin/python3"))) {
  await rm(target, { recursive: true, force: true });
  await cp(join(downloads, directory), target, { recursive: true, verbatimSymlinks: true });
}
run([
  "pip",
  "install",
  "--python",
  join(target, "bin/python3"),
  "--break-system-packages",
  "--require-hashes",
  "-r",
  "scripts/cadquery-requirements.txt"
]);
const check = execFileSync(
  join(target, "bin/python3"),
  [
    "-I",
    "-B",
    "-c",
    'import cadquery as cq; assert cq.Workplane("XY").box(2,3,4).val().isValid(); print(cq.__version__)'
  ],
  { encoding: "utf8" }
).trim();
if (check !== "2.6.1") throw new Error("Unexpected CadQuery version");
// Retain wheel licenses/metadata in the runtime; add an index for distributors.
const site = join(target, "lib/python3.11/site-packages");
const notices = [];
for (const name of await readdir(site)) {
  if (!name.endsWith(".dist-info")) continue;
  const metadata = await readFile(join(site, name, "METADATA"), "utf8");
  notices.push(
    metadata
      .split("\n")
      .filter((line) => /^(Name|Version|License|License-Expression|License-File):/.test(line))
      .join("\n")
  );
}
await writeFile(
  join(target, "THIRD_PARTY_LICENSES.txt"),
  "Bundled standalone CPython: see LICENSE and Python distribution licenses.\n" +
    "Each Python wheel retains its .dist-info license files.\n\n" +
    notices.join("\n\n")
);
await writeFile(
  join(target, "atria-runtime.json"),
  JSON.stringify({ python: "3.11.15", cadquery: "2.6.1", platform: "darwin-arm64" }, null, 2)
);
console.log(`Native CAD runtime ready: ${target}`);

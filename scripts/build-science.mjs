import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The optional Python interpreter/dependencies are never installed by the build. */
export async function buildScienceRuntime(root = process.cwd()) {
  const target = resolve(root, "dist/src/tools/science");
  await mkdir(target, { recursive: true });
  for (const file of [
    "runner.py",
    "pilot.py",
    "analysis.py",
    "astronomy.py",
    "chemistry.py",
    "materials.py",
    "mass_spectrometry.py",
    "mass-chemistry.py",
    "statistics.py",
    "environment-probe.py",
    "requirements.txt",
    "requirements-chemistry.txt"
  ])
    await copyFile(resolve(root, "src/tools/science", file), resolve(target, file));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await buildScienceRuntime();

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const blenderEntry = ".tools/blender-runtime/Blender.app/Contents/MacOS/Blender";

/** Fail before packaging if an app or its distribution materials would be omitted. */
export async function verifyDesktopComponents({ root = process.cwd() } = {}) {
  for (const [file, executable] of [
    [".tools/cadquery-runtime/bin/python3", true],
    [".tools/cadquery-runtime/atria-runtime.json"],
    [".tools/cadquery-runtime/THIRD_PARTY_LICENSES.txt"],
    [blenderEntry, true],
    [".tools/blender-runtime/Blender.app/Contents/Resources/text/copyright.txt"],
    [".tools/blender-runtime/Blender.app/Contents/Resources/text/license/license.md"],
    [".tools/blender-runtime/Blender.app/Contents/Resources/text/license/licenses.json"],
    ["web/assets/pptist/generated/index.html"],
    ["web/assets/pptist/generated/LICENSE.txt"],
    ["web/assets/pptist/generated/source.tar.gz"]
  ]) {
    try {
      await access(join(root, file), executable ? constants.X_OK : constants.R_OK);
    } catch {
      throw new Error(`Full desktop package is missing ${file}; run npm run desktop:prepare`);
    }
  }
}

/** Build-time installation uses Blender's pinned public archive, never a user's component credentials. */
export async function prepareDesktopComponents({
  root = process.cwd(),
  installer,
  commandRunner = execute
} = {}) {
  const { installBlenderRuntime, BLENDER_INSTALL_SOURCE } =
    installer || (await import("../dist/src/software/blender/installer.js"));
  const executable = join(root, blenderEntry);
  const present = await access(executable, constants.X_OK).then(
    () => true,
    () => false
  );
  if (!present) {
    await installBlenderRuntime({
      directory: join(root, ".tools/blender-runtime"),
      report: ({ message }) => console.log(message)
    });
  }
  const expectedVersion = BLENDER_INSTALL_SOURCE.file.match(/^blender-([\d.]+)-/)?.[1];
  const { stdout } = await commandRunner(executable, ["--version"], { timeout: 180_000 });
  const actualVersion = stdout.match(/^Blender (\d+\.\d+\.\d+)(?:\s|$)/m)?.[1];
  if (!expectedVersion || actualVersion !== expectedVersion)
    throw new Error(
      `Bundled Blender must be ${expectedVersion}; found ${actualVersion || "unknown version"}`
    );
  await verifyDesktopComponents({ root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("The bundled desktop components currently target macOS arm64");
  await prepareDesktopComponents();
  console.log("Full desktop components ready: CadQuery, Blender and PPTist");
}

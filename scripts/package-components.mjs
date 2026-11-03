import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  lstat,
  stat,
  realpath,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
const { version: hostVersion } = JSON.parse(await readFile("package.json", "utf8"));
const publicRelease = process.env.ATRIA_COMPONENTS_PUBLIC === "1";
const compatibleHost = publicRelease ? "*" : hostVersion;
const directory = resolve(process.env.ATRIA_PACKAGE_DIR || "release");
await mkdir(directory, { recursive: true });
async function size(path) {
  const info = await lstat(path);
  return info.isDirectory()
    ? (await Promise.all((await readdir(path)).map((name) => size(join(path, name))))).reduce(
        (a, b) => a + b,
        0
      )
    : info.size;
}
const artifacts = [];
if (publicRelease) {
  // Public archives retain the same license/source materials as an offline App.
  for (const file of [
    ".tools/cadquery-runtime/lib/python3.11/LICENSE.txt",
    ".tools/cadquery-runtime/THIRD_PARTY_LICENSES.txt",
    "web/assets/pptist/generated/LICENSE.txt",
    "web/assets/pptist/generated/source.tar.gz"
  ])
    await access(resolve(file));
}
for (const [id, version, platform, source] of [
  ["cadquery", "2.6.1", "darwin-arm64", ".tools/cadquery-runtime"],
  ["pptist", hostVersion, "any", "web/assets/pptist/generated"]
]) {
  const file = `atria-component-${id}-${version}-${platform}.tar.gz`;
  execFileSync("tar", ["-czf", join(directory, file), "-C", source, "."], { stdio: "inherit" });
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, file))) sha.update(chunk);
  const sha256 = sha.digest("hex");
  const artifact = {
    apiVersion: 1,
    id,
    version,
    hostVersion: compatibleHost,
    platform,
    file,
    sha256,
    downloadBytes: (await stat(join(directory, file))).size,
    installedBytes: await size(await realpath(source))
  };
  artifacts.push(artifact);
  await writeFile(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
}
if (publicRelease) {
  const { BLENDER_INSTALL_SOURCE } = await import("../dist/src/software/blender/installer.js");
  const source = resolve(".tools/blender-download", BLENDER_INSTALL_SOURCE.file);
  const sha = createHash("sha256");
  for await (const chunk of createReadStream(source)) sha.update(chunk);
  const sha256 = sha.digest("hex");
  if (sha256 !== BLENDER_INSTALL_SOURCE.sha256) throw new Error("Blender mirror checksum mismatch");
  const file = BLENDER_INSTALL_SOURCE.file;
  if (source !== join(directory, file)) await copyFile(source, join(directory, file));
  artifacts.push({
    apiVersion: 1,
    id: "blender",
    version: "4.5.11",
    hostVersion: compatibleHost,
    platform: "darwin-arm64",
    file,
    sha256,
    downloadBytes: (await stat(source)).size,
    installedBytes: await size(await realpath(".tools/blender-runtime"))
  });
  await writeFile(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
}
await writeFile(
  join(directory, "atria-components-darwin-arm64.json"),
  JSON.stringify({ schemaVersion: 1, hostVersion: compatibleHost, artifacts }, null, 2) + "\n"
);
console.log(JSON.stringify(artifacts, null, 2));

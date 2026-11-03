import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { npmDesktopManifest, NPM_DESKTOP_PACKAGE } from "./update-npm-desktop.mjs";
import { parseUpdateVersion } from "./update-release.mjs";

const execute = promisify(execFile);

async function hashFile(path, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

async function assertSourceChecksum(source, expectedName, digest) {
  const sidecar = `${source}.sha256`;
  try {
    await access(sidecar);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const contents = await readFile(sidecar, "utf8");
  const match = /^([a-f0-9]{64})\s+(.+)\s*$/.exec(contents);
  if (!match || match[1] !== digest || match[2] !== expectedName)
    throw new Error("Mac DMG 的 SHA-256 文件与实际文件不匹配");
}

export async function packageDesktopNpm({
  root = process.cwd(),
  outputDirectory,
  commandRunner = execute
} = {}) {
  root = resolve(root);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  parseUpdateVersion(pkg.version);
  const source = join(root, "release", `CoworkOS-${pkg.version}-mac-arm64.dmg`);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("Mac DMG 必须是普通文件");
  const sourceSha256 = (await hashFile(source, "sha256")).toString("hex");
  await assertSourceChecksum(source, basename(source), sourceSha256);
  const desktopRelease = npmDesktopManifest({
    version: pkg.version,
    size: sourceInfo.size,
    sha256: sourceSha256
  });
  const stage = await mkdtemp(join(tmpdir(), "coworkos-desktop-npm-"));
  try {
    const stagedDmg = join(stage, desktopRelease.artifact.name);
    await copyFile(source, stagedDmg);
    const stagedSha256 = (await hashFile(stagedDmg, "sha256")).toString("hex");
    if (stagedSha256 !== desktopRelease.artifact.sha256) throw new Error("打包期间 Mac DMG 发生变化");
    await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
    const manifest = {
      name: NPM_DESKTOP_PACKAGE,
      version: pkg.version,
      description: "CoworkOS Mac desktop installer package for Apple Silicon",
      os: ["darwin"],
      cpu: ["arm64"],
      license: "MIT",
      repository: pkg.repository,
      files: ["*.dmg"],
      desktopRelease,
      publishConfig: {
        registry: "https://registry.npmjs.org",
        access: "public",
        tag: pkg.version.includes("-") ? "beta" : "latest"
      }
    };
    await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const output = resolve(
      outputDirectory || process.env.ATRIA_DESKTOP_NPM_PACKAGE_DIR || join(root, "release")
    );
    await mkdir(output, { recursive: true });
    const packed = await commandRunner("npm", ["pack", "--json", "--pack-destination", output], {
      cwd: stage,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(packed.stdout);
    if (
      !Array.isArray(result) ||
      result.length !== 1 ||
      result[0].filename !== `${NPM_DESKTOP_PACKAGE}-${pkg.version}.tgz`
    )
      throw new Error("npm 未生成预期的 Mac 桌面平台包");
    const archive = join(output, result[0].filename);
    const archiveInfo = await lstat(archive);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 1024 * 1024 * 1024)
      throw new Error("生成的 npm 桌面包无效或过大");
    const digest = (await hashFile(archive, "sha512")).toString("base64");
    console.log(`npm Mac 桌面包已生成：${archive}\n版本：${pkg.version}\nSHA-512：sha512-${digest}`);
    return { archive, version: pkg.version, integrity: `sha512-${digest}`, manifest: desktopRelease };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await packageDesktopNpm();

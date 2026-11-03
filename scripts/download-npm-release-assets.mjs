import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const required = (value, name) => {
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export async function downloadNpmReleaseAssets({
  tag = process.env.RELEASE_TAG,
  repository = process.env.GITHUB_REPOSITORY,
  version = process.env.VERSION,
  root = process.cwd(),
  allowPublished = false,
  commandRunner = execFileSync,
  binaryRunner = spawnSync
} = {}) {
  tag = required(tag, "RELEASE_TAG");
  repository = required(repository, "GITHUB_REPOSITORY");
  version = required(version, "VERSION");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  if (tag !== `v${version}`) throw new Error("Release tag and npm package version differ");
  root = resolve(root);
  const pages = JSON.parse(
    commandRunner("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`], {
      encoding: "utf8"
    })
  );
  const releases = pages.flat();
  const matches = releases.filter(
    (release) =>
      release.tag_name === tag && (release.draft === true || (allowPublished && release.draft === false))
  );
  if (matches.length !== 1)
    throw new Error(
      allowPublished
        ? "Expected exactly one GitHub Release for this tag"
        : "Expected exactly one draft GitHub Release for this tag"
    );
  const release = matches[0];
  const names = [
    `coworkos-desktop-darwin-arm64-${version}.tgz`,
    `coworkos-app-${version}.tgz`,
    `atria-release-${version}.json`
  ];
  const output = join(root, ".tmp/npm-release");
  mkdirSync(output, { recursive: true });
  for (const name of names) {
    const pair = [name, `${name}.sha256`];
    for (const assetName of pair) {
      const assets = release.assets.filter((asset) => asset.name === assetName);
      if (assets.length !== 1 || !Number.isSafeInteger(assets[0].id))
        throw new Error(`Release is missing a unique asset: ${assetName}`);
      const path = join(output, assetName);
      const descriptor = openSync(path, "w");
      try {
        const result = binaryRunner(
          "gh",
          [
            "api",
            `repos/${repository}/releases/assets/${assets[0].id}`,
            "-H",
            "Accept: application/octet-stream"
          ],
          { stdio: ["ignore", descriptor, "inherit"] }
        );
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Unable to download release asset: ${assetName}`);
      } finally {
        closeSync(descriptor);
      }
    }
    const bytes = await readFile(join(output, name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksum = (await readFile(join(output, `${name}.sha256`), "utf8")).trim();
    if (checksum !== `${digest}  ${name}`) throw new Error(`Release asset checksum differs: ${name}`);
  }
  const releaseManifestName = names[2];
  const releaseManifest = JSON.parse(await readFile(join(output, releaseManifestName), "utf8"));
  const sourceCommit = commandRunner("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (
    releaseManifest.version !== version ||
    releaseManifest.source?.tag !== tag ||
    releaseManifest.source?.commit !== sourceCommit
  )
    throw new Error("Release manifest does not match the checked-out tag commit");
  const dmg = releaseManifest.artifacts?.find(({ name }) => name === `CoworkOS-${version}-mac-arm64.dmg`);
  if (!dmg) throw new Error("Release manifest is missing the Mac DMG fingerprint");

  for (const name of names.slice(0, 2)) {
    const manifest = JSON.parse(
      commandRunner("tar", ["-xOf", join(output, name), "package/package.json"], { encoding: "utf8" })
    );
    const expectedPackage = name.startsWith("coworkos-app-")
      ? "coworkos-app"
      : "coworkos-desktop-darwin-arm64";
    if (manifest.name !== expectedPackage || manifest.version !== version)
      throw new Error(`npm archive metadata differs from the tag: ${name}`);
    if (expectedPackage === "coworkos-app") {
      const build = JSON.parse(
        commandRunner("tar", ["-xOf", join(output, name), "package/build-info.json"], { encoding: "utf8" })
      );
      if (
        build.version !== version ||
        build.commit !== sourceCommit ||
        build.dirty !== false ||
        build.distribution !== "npm"
      )
        throw new Error("CLI npm archive provenance differs from the checked-out tag");
    } else if (
      manifest.desktopRelease?.appVersion !== version ||
      manifest.desktopRelease?.artifact?.name !== dmg.name ||
      manifest.desktopRelease?.artifact?.size !== dmg.size ||
      manifest.desktopRelease?.artifact?.sha256 !== dmg.sha256
    ) {
      throw new Error("Desktop npm archive does not contain the DMG fingerprint in the release manifest");
    }
  }
  return { directory: output, files: names.slice(0, 2), releaseManifest: releaseManifestName };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await downloadNpmReleaseAssets({ allowPublished: process.env.VERIFY_ONLY === "true" });
    console.log(`Downloaded and verified npm archives: ${result.files.join(", ")}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

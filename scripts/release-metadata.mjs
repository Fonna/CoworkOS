import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const numeric = "(?:0|[1-9]\\d*)";
const prerelease = `(?:${numeric}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

export function releaseMetadata(version, lockVersion, tag) {
  if (typeof version !== "string" || /[\r\n]/.test(version) || !semver.test(version))
    throw new Error("Package version must be a release version with no path or shell characters");
  if (lockVersion !== version)
    throw new Error("package.json and package-lock.json versions differ; update them together");
  if (tag !== `v${version}`) throw new Error(`Release tag must be v${version}, matching package.json`);
  const dmg = `release/CoworkOS-${version}-mac-arm64.dmg`;
  return {
    tag,
    version,
    prerelease: version.split("+")[0].includes("-"),
    dmg,
    checksum: `${dmg}.sha256`
  };
}

export async function validateRelease(root, tag) {
  const source = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const metadata = releaseMetadata(source.version, lock.version, tag);
  if (lock.packages?.[""]?.version !== source.version)
    throw new Error("package-lock.json root package version differs; update it with package.json");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const target = git(["rev-parse", "--verify", `refs/tags/${metadata.tag}^{commit}`]);
  if (target !== git(["rev-parse", "HEAD"]))
    throw new Error("Checked-out commit differs from the release tag; refusing to package another revision");
  if (git(["status", "--porcelain", "--untracked-files=normal"]))
    throw new Error("Release source has uncommitted changes; commit and validate it before packaging");
  return { ...metadata, commit: target };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const metadata = await validateRelease(process.cwd(), process.env.RELEASE_TAG);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(metadata)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    );
  console.log(`Release ${metadata.tag} from ${metadata.commit}: ${metadata.dmg}`);
}

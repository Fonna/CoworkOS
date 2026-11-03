import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, symlink, rm, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { releaseMetadata } from "./release-metadata.mjs";
import { macUpdateArtifacts, verifyDeveloperIdApplication, writeMacUpdateFeed } from "./update-feed.mjs";
import { macPackagingArguments, macPackagingEnvironment, verifyMacApplication } from "./mac-signing.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Mac packaging currently requires an Apple Silicon Mac");
const exec = promisify(execFile);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const { version } = pkg;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
releaseMetadata(version, lock.version, tag);
if (lock.packages?.[""]?.version !== version)
  throw new Error("package-lock.json root version differs from package.json");
const packaging = macPackagingEnvironment();
const signingConfigured = packaging.mode === "developer-id";
const appPath = resolve(".tmp/release/mac-arm64/CoworkOS.app");
const archive = resolve(`release/CoworkOS-${version}-mac-arm64.zip`);
const signingReport = resolve(`release/CoworkOS-${version}-mac-arm64.signing.json`);
const feed = resolve("release/atria-update-mac-arm64.json");
const updateMetadata = signingConfigured
  ? macUpdateArtifacts({
      version,
      lockVersion: lock.version,
      tag,
      repository: process.env.ATRIA_UPDATE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? pkg.repository
    })
  : undefined;
// Never upload an old signed update alongside a newly generated unsigned DMG.
for (const path of [archive, `${archive}.sha256`, feed, signingReport]) await rm(path, { force: true });
console.log(signingConfigured ? "Building the Developer ID app" : "Building the ad-hoc beta app");
const { stdout } = await exec(process.execPath, macPackagingArguments(process.cwd(), packaging.mode), {
  maxBuffer: 4 * 1024 * 1024,
  env: packaging.env
});
const signature = await verifyMacApplication({ appPath, version, mode: packaging.mode });
if (signingConfigured) await verifyDeveloperIdApplication(appPath);
await mkdir(resolve("release"), { recursive: true });
await writeFile(signingReport, `${JSON.stringify(signature, null, 2)}\n`);
console.log(
  stdout
    .split("\n")
    .filter((line) => !line.includes("duplicate dependency references"))
    .join("\n")
);
const staging = await mkdtemp(join(tmpdir(), "atria-dmg-staging-"));
const output = resolve(`release/CoworkOS-${version}-mac-arm64.dmg`);
await mkdir(resolve("release"), { recursive: true });
try {
  // Preserve framework symlinks when relocating a native app bundle.
  await cp(appPath, join(staging, "CoworkOS.app"), {
    recursive: true,
    verbatimSymlinks: true
  });
  await symlink("/Applications", join(staging, "Applications"));
  console.log("Creating and verifying DMG with macOS hdiutil");
  await exec(
    "/usr/bin/hdiutil",
    [
      "create",
      "-volname",
      signingConfigured ? "CoworkOS" : "CoworkOS Beta",
      "-srcfolder",
      staging,
      "-format",
      "UDZO",
      "-fs",
      "HFS+",
      "-ov",
      output
    ],
    { maxBuffer: 1024 * 1024 }
  );
  await exec("/usr/bin/hdiutil", ["verify", output]);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(output)) digest.update(chunk);
  await writeFile(`${output}.sha256`, `${digest.digest("hex")}  ${output.split("/").at(-1)}\n`);
  console.log(`Mac package ready: ${output}`);
  if (signingConfigured) {
    await exec("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive]);
    await exec("/usr/bin/unzip", ["-tq", archive]);
    const metadata = await writeMacUpdateFeed({ archive, ...updateMetadata });
    console.log(`Signed Mac update ready: ${metadata.archive}\nUpdate feed: ${metadata.feed}`);
  } else {
    console.log(
      "Ad-hoc beta distribution: DMG only, not notarized; native ZIP updates require Developer ID signing."
    );
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}

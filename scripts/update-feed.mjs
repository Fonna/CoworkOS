import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { releaseMetadata } from "./release-metadata.mjs";
import { releaseAssetUrl, updateRepository } from "./update-release.mjs";

const execute = promisify(execFile);
const maximumArchiveSize = 2 * 1024 * 1024 * 1024;

export function macUpdateArtifacts({ version, lockVersion = version, tag = `v${version}`, repository }) {
  releaseMetadata(version, lockVersion, tag);
  const selectedRepository = updateRepository(repository);
  const zipName = `CoworkOS-${version}-mac-arm64.zip`;
  return {
    version,
    tag,
    repository: selectedRepository,
    zipName,
    feedName: "atria-update-mac-arm64.json",
    zipUrl: releaseAssetUrl(selectedRepository, tag, zipName)
  };
}

export function macUpdateFeed({ sha256, size, pubDate = new Date(), notes, ...options }) {
  const metadata = macUpdateArtifacts(options);
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("Mac update requires the ZIP's SHA-256 digest");
  if (!Number.isSafeInteger(size) || size <= 0 || size > maximumArchiveSize)
    throw new Error("Mac update ZIP size must be between 1 byte and 2 GiB");
  if (!(pubDate instanceof Date) && (typeof pubDate !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(pubDate)))
    throw new Error("Mac update publication date must be ISO 8601");
  const date = new Date(pubDate);
  if (!Number.isFinite(date.getTime())) throw new Error("Mac update publication date must be ISO 8601");
  notes ??= `CoworkOS ${metadata.version}`;
  if (typeof notes !== "string" || notes.length > 10000 || notes.includes("\0"))
    throw new Error("Mac update notes must be bounded text");
  // Electron serverType: "json" uses Squirrel.Mac's static file format.
  // https://github.com/Squirrel/Squirrel.Mac#update-file-json-format
  return {
    currentRelease: metadata.version,
    releases: [
      {
        version: metadata.version,
        updateTo: {
          version: metadata.version,
          url: metadata.zipUrl,
          name: `CoworkOS ${metadata.version}`,
          notes,
          pub_date: date.toISOString(),
          sha256,
          size
        }
      }
    ]
  };
}

export async function verifyDeveloperIdApplication(appPath, commandRunner = execute) {
  try {
    await commandRunner("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    const result = await commandRunner("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
    if (!/^Authority=Developer ID Application:/m.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`))
      throw new Error("Developer ID Application certificate required");
  } catch {
    throw new Error("Mac update ZIP requires a valid Developer ID Application signature");
  }
}

export async function writeMacUpdateFeed({ archive, ...options }) {
  const metadata = macUpdateArtifacts(options);
  if (basename(archive) !== metadata.zipName)
    throw new Error("Mac update archive filename does not match its version");
  const info = await lstat(archive);
  if (!info.isFile() || info.size <= 0 || info.size > maximumArchiveSize)
    throw new Error("Mac update archive must be a regular ZIP file between 1 byte and 2 GiB");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  const feed = macUpdateFeed({ ...options, sha256, size: info.size });
  const checksum = `${archive}.sha256`;
  const feedPath = join(dirname(archive), metadata.feedName);
  await writeFile(checksum, `${sha256}  ${metadata.zipName}\n`);
  await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
  return { archive, checksum, feed: feedPath, sha256, size: info.size };
}

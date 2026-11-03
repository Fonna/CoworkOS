import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyReleaseArtifacts, releaseFiles } from "./release-artifacts.mjs";
import {
  MAX_PUBLIC_ARTIFACT_BYTES,
  PUBLIC_RELEASE_REPOSITORY,
  PUBLIC_UPDATE_FEED_URL,
  compareUpdateVersions,
  parseUpdateVersion,
  publicReleaseArtifactNames,
  releaseAssetUrl,
  validatePublicReleaseFeed
} from "./update-release.mjs";

const execute = promisify(execFile);
const pointerPath = "updates/coworkos-latest.json";
const shaPattern = /^[a-f0-9]{40}$/;
const notFound = (error) => error.status === 404 || /\(HTTP 404\)/.test(String(error.stderr ?? ""));

async function fingerprint(directory, name) {
  const path = join(directory, name);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    !Number.isSafeInteger(info.size) ||
    info.size <= 0 ||
    info.size > MAX_PUBLIC_ARTIFACT_BYTES
  )
    throw new Error("Public release files must be regular files smaller than 2 GiB: " + name);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { name, size: info.size, sha256: hash.digest("hex") };
}

function remoteAssets(release, artifacts) {
  if (!Array.isArray(release.assets) || release.assets.length !== artifacts.length)
    throw new Error("Remote public release has missing or unexpected assets; publication stopped");
  const names = new Set();
  for (const asset of release.assets) {
    const local = artifacts.find(({ name }) => name === asset.name);
    if (
      !local ||
      names.has(asset.name) ||
      asset.state !== "uploaded" ||
      asset.size !== local.size ||
      asset.digest !== `sha256:${local.sha256}`
    )
      throw new Error("Remote public release asset digest or size differs: " + String(asset.name));
    names.add(asset.name);
  }
}

/** Publish only verified binary assets; the public tag points to its own distribution repository. */
export async function publishPublicRelease({
  root = process.cwd(),
  tag = process.env.RELEASE_TAG,
  commandRunner = execute,
  verifyArtifacts = verifyReleaseArtifacts,
  resumePointer = false
} = {}) {
  root = resolve(root);
  const repository = PUBLIC_RELEASE_REPOSITORY;
  const manifest = await verifyArtifacts({ root, tag, requireSigningReport: true });
  parseUpdateVersion(manifest.version);
  if (manifest.source?.tag !== `v${manifest.version}` || tag !== manifest.source.tag)
    throw new Error("Public release tag differs from the verified source");
  if (manifest.mac?.signing !== "adhoc" || manifest.mac.developerId !== false)
    throw new Error(
      "Public publishing currently supports the eight-file ad-hoc release only; signed ZIP publishing is not configured"
    );
  const names = publicReleaseArtifactNames(manifest.version);
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== names.length ||
    new Set(manifest.files).size !== names.length ||
    manifest.files.some((name) => !names.includes(name))
  )
    throw new Error("Public publishing requires exactly the eight verified distribution files");
  const directory = join(root, "release");
  const artifacts = await Promise.all(names.map((name) => fingerprint(directory, name)));
  for (const artifact of manifest.artifacts) {
    const current = artifacts.find(({ name }) => name === artifact.name);
    if (!current || artifact.sha256 !== current.sha256 || artifact.size !== current.size)
      throw new Error("A verified release file changed before public publishing");
  }
  const notes = join(directory, releaseFiles(manifest.version).notes);
  const noteInfo = await lstat(notes);
  if (!noteInfo.isFile() || noteInfo.size <= 0 || noteInfo.size > 128 * 1024)
    throw new Error("Public release notes must be a bounded regular file");
  const gh = async (args) =>
    commandRunner("gh", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const json = async (endpoint) => {
    const response = await gh(["api", endpoint]);
    try {
      return JSON.parse(response.stdout);
    } catch {
      throw new Error("GitHub returned invalid public release metadata");
    }
  };
  const readPointer = async () => {
    let entry;
    try {
      entry = await json(`repos/${repository}/contents/${pointerPath}?ref=main`);
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
    if (
      entry.type !== "file" ||
      entry.encoding !== "base64" ||
      !shaPattern.test(entry.sha ?? "") ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > 32 * 1024 ||
      typeof entry.content !== "string" ||
      entry.content.length > 48 * 1024
    )
      throw new Error("Existing public update pointer is invalid");
    let feed;
    try {
      feed = validatePublicReleaseFeed(JSON.parse(Buffer.from(entry.content, "base64").toString("utf8")));
    } catch {
      throw new Error("Existing public update pointer is invalid");
    }
    return { sha: entry.sha, feed };
  };
  const assertAdvance = (pointer) => {
    if (pointer && compareUpdateVersions(manifest.version, pointer.feed.version) <= 0)
      throw new Error("Public update pointer cannot move backwards or replace the same version");
  };
  const repositoryInfo = await json(`repos/${repository}`);
  if (repositoryInfo.private !== false || repositoryInfo.default_branch !== "main")
    throw new Error("Public distribution requires a public repository with an initialized main branch");
  const originalPointer = await readPointer();
  if (originalPointer && compareUpdateVersions(manifest.version, originalPointer.feed.version) < 0)
    throw new Error("Public update pointer cannot move backwards");
  let releaseId;
  const readRelease = async () => {
    if (releaseId) return json(`repos/${repository}/releases/${releaseId}`);
    const response = await gh(["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]);
    let pages;
    try {
      pages = JSON.parse(response.stdout);
    } catch {
      throw new Error("GitHub returned invalid release listing");
    }
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
      throw new Error("GitHub returned invalid release listing");
    const matches = pages.flat().filter((entry) => entry.tag_name === tag);
    if (matches.length > 1) throw new Error("GitHub returned duplicate version releases");
    const release = matches[0];
    if (release) {
      if (!Number.isSafeInteger(release.id) || release.id <= 0)
        throw new Error("GitHub returned an invalid release identity");
      releaseId = release.id;
    }
    return release;
  };
  let release = await readRelease();
  const published = release?.draft === false;
  const prerelease = parseUpdateVersion(manifest.version).prerelease.length > 0;
  if (published) {
    if (!resumePointer)
      throw new Error(
        "Public release is already published; use --resume-pointer only to recover its verified pointer without replacing assets"
      );
    remoteAssets(release, artifacts);
  } else {
    assertAdvance(originalPointer);
    if (release && (release.draft !== true || release.tag_name !== tag))
      throw new Error("Public release metadata is invalid");
    if (
      release &&
      (!Array.isArray(release.assets) || release.assets.some(({ name }) => !names.includes(name)))
    )
      throw new Error("Public draft contains unexpected assets; publication stopped");
    if (!release) {
      await gh([
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--target",
        "main",
        "--draft",
        `--prerelease=${prerelease}`,
        "--latest=false",
        "--title",
        `CoworkOS ${tag}`,
        "--notes-file",
        notes
      ]);
    }
    // Drafts are discovered through the authenticated listing: tag lookup can return 404 for a draft.
    release = await readRelease();
    if (release?.draft !== true || release.tag_name !== tag)
      throw new Error("Public release was published while preparing; no assets were replaced");
    await gh([
      "release",
      "upload",
      tag,
      ...names.map((name) => join(directory, name)),
      "--repo",
      repository,
      "--clobber"
    ]);
    release = await readRelease();
    if (release.draft !== true || release.tag_name !== tag)
      throw new Error("Public release changed during upload; update pointer was not changed");
    remoteAssets(release, artifacts);
    const beforePublication = await readPointer();
    if (beforePublication?.sha !== originalPointer?.sha)
      throw new Error("Public update pointer changed concurrently; publication stopped without replacing it");
    assertAdvance(beforePublication);
    await gh([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      `--prerelease=${prerelease}`,
      "--latest=false"
    ]);
    release = await readRelease();
  }
  if (
    release.draft !== false ||
    release.tag_name !== tag ||
    !Number.isFinite(Date.parse(release.published_at))
  )
    throw new Error("Public release publication could not be confirmed; update pointer was not changed");
  remoteAssets(release, artifacts);
  const feed = validatePublicReleaseFeed({
    schemaVersion: 1,
    repository,
    version: manifest.version,
    publishedAt: new Date(release.published_at).toISOString(),
    releaseUrl: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      url: releaseAssetUrl(repository, tag, artifact.name)
    }))
  });
  const result = {
    repository,
    tag,
    version: manifest.version,
    uploaded: published ? 0 : artifacts.length,
    releaseUrl: feed.releaseUrl,
    feedUrl: PUBLIC_UPDATE_FEED_URL
  };
  const equalFeed = (left, right) =>
    left.repository === right.repository &&
    left.version === right.version &&
    left.publishedAt === right.publishedAt &&
    left.releaseUrl === right.releaseUrl &&
    left.feedUrl === right.feedUrl &&
    left.artifacts.length === right.artifacts.length &&
    left.artifacts.every((a) =>
      right.artifacts.some(
        (b) => a.name === b.name && a.size === b.size && a.sha256 === b.sha256 && a.url === b.url
      )
    );
  if (originalPointer && compareUpdateVersions(manifest.version, originalPointer.feed.version) === 0) {
    if (!published || !equalFeed(originalPointer.feed, feed))
      throw new Error(
        "The same public version already points to different release contents; nothing was replaced"
      );
    return { ...result, pointerUnchanged: true };
  }
  assertAdvance(originalPointer);
  const temporary = await mkdtemp(join(tmpdir(), "atria-public-publish-"));
  try {
    const payload = join(temporary, "pointer.json");
    await writeFile(
      payload,
      JSON.stringify({
        message: `Publish CoworkOS ${tag} update pointer`,
        branch: "main",
        content: Buffer.from(JSON.stringify(feed, null, 2) + "\n").toString("base64"),
        ...(originalPointer ? { sha: originalPointer.sha } : {})
      })
    );
    try {
      await gh(["api", "--method", "PUT", `repos/${repository}/contents/${pointerPath}`, "--input", payload]);
    } catch {
      throw new Error(
        "Public release is published, but the update pointer changed concurrently or could not be saved; no pointer was overwritten. Inspect the current pointer before retrying."
      );
    }
    const saved = await readPointer();
    if (!saved || JSON.stringify(saved.feed) !== JSON.stringify(feed))
      throw new Error("Public release is published, but the saved update pointer could not be verified");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--resume-pointer") || args.length > 1)
      throw new Error("Usage: node scripts/public-release-publish.mjs [--resume-pointer]");
    const result = await publishPublicRelease({ resumePointer: args.includes("--resume-pointer") });
    console.log(
      `Public release: ${result.releaseUrl}\nUpdate pointer: ${result.feedUrl}\nVerified assets: ${result.uploaded}`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

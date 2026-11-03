import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const catalogFile = "atria-components-darwin-arm64.json";
const safeName = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);

async function verifyFile(directory, artifact) {
  if (!safeName(artifact.file)) throw new Error("Invalid component publication filename");
  const path = join(directory, artifact.file);
  const info = await lstat(path);
  if (!info.isFile() || !info.size || info.size >= 2 ** 31)
    throw new Error(`Release asset must be a regular file below GitHub's limit: ${artifact.file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (info.size !== artifact.bytes || hash.digest("hex") !== artifact.sha256)
    throw new Error(`Release asset size/checksum mismatch: ${artifact.file}`);
  return path;
}

function validatePublicArtifact(artifact, id) {
  if (
    !artifact ||
    artifact.apiVersion !== 1 ||
    artifact.hostVersion !== "*" ||
    artifact.platform !== (id === "pptist" ? "any" : "darwin-arm64") ||
    typeof artifact.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(artifact.version) ||
    !safeName(artifact.file) ||
    !artifact.file.endsWith(id === "blender" ? ".dmg" : ".tar.gz") ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.downloadBytes) ||
    artifact.downloadBytes <= 0 ||
    !Number.isSafeInteger(artifact.installedBytes) ||
    artifact.installedBytes <= 0
  )
    throw new Error(`Public component catalog has incompatible metadata for ${id}`);
}

/** Publish only prepared component assets, never the private checkout or App source. */
export async function publishComponents({
  root = process.cwd(),
  directory = resolve(root, process.env.ATRIA_PACKAGE_DIR || "release"),
  sources = resolve(root, process.env.ATRIA_COMPONENT_SOURCES_DIR || ".tmp/component-sources"),
  target,
  commandRunner = execute
} = {}) {
  const { COMPONENT_REPOSITORY, COMPONENT_RELEASE_TAG } =
    target || (await import("../dist/src/software/components/source.js"));
  const repository = COMPONENT_REPOSITORY,
    tag = COMPONENT_RELEASE_TAG;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !safeName(tag))
    throw new Error("Invalid component publication target");
  const catalog = JSON.parse(await readFile(join(directory, catalogFile), "utf8"));
  if (
    catalog.schemaVersion !== 1 ||
    catalog.hostVersion !== "*" ||
    !Array.isArray(catalog.artifacts) ||
    catalog.artifacts.length !== 3
  )
    throw new Error("Build the public component catalog with npm run components:pack:public first");
  const files = [join(directory, catalogFile)];
  for (const id of ["cadquery", "pptist", "blender"]) {
    const artifact = catalog.artifacts.find((entry) => entry.id === id);
    validatePublicArtifact(artifact, id);
    files.push(await verifyFile(directory, { ...artifact, bytes: artifact.downloadBytes }));
    const checksumFile = `${artifact.file}.sha256`;
    if (
      (await readFile(join(directory, checksumFile), "utf8")).trim() !==
      `${artifact.sha256}  ${artifact.file}`
    )
      throw new Error(`Invalid checksum sidecar: ${checksumFile}`);
    files.push(join(directory, checksumFile));
  }
  const sourceManifest = JSON.parse(await readFile(join(sources, "SOURCE_MANIFEST.json"), "utf8"));
  if (
    sourceManifest.schemaVersion !== 1 ||
    sourceManifest.componentRelease !== tag ||
    !Array.isArray(sourceManifest.assets) ||
    !sourceManifest.assets.length
  )
    throw new Error("Corresponding source materials must be prepared before public publication");
  for (const artifact of sourceManifest.assets) files.push(await verifyFile(sources, artifact));
  files.push(join(sources, "SOURCE_MANIFEST.json"), join(root, "THIRD_PARTY_NOTICES.md"));
  const assetNames = files.map((file) => basename(file));
  if (new Set(assetNames).size !== assetNames.length)
    throw new Error("Duplicate publication filenames would overwrite verified release assets");
  // Existence checks are separate from asset writes. A published version is immutable.
  const { stdout: listing } = await commandRunner("gh", ["api", `repos/${repository}/releases?per_page=100`]);
  const releases = JSON.parse(listing);
  if (!Array.isArray(releases)) throw new Error("Invalid GitHub releases response");
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && !existing.draft)
    throw new Error(`Component release ${tag} is already published; use a new component release tag`);
  if (
    existing &&
    (!Array.isArray(existing.assets) || existing.assets.some((asset) => !assetNames.includes(asset.name)))
  )
    throw new Error("Existing component draft has unexpected assets; review them before publication");
  const staging = await mkdtemp(join(tmpdir(), "atria-component-release-"));
  try {
    const notes = join(staging, "notes.md");
    await writeFile(
      notes,
      [
        "Versioned runtime components for CoworkOS on macOS 14+ Apple Silicon.",
        "",
        "The desktop app downloads the pinned catalog and verifies each component before activation.",
        "CadQuery/Python, the PPT editor and the original Blender DMG retain their upstream licenses.",
        "Corresponding source archives, build materials and SHA-256 values accompany this release.",
        "This repository distributes components; it does not contain the private CoworkOS application source.",
        "",
        "This is a beta distribution. Clean-machine installation and Developer ID notarization are separate checks."
      ].join("\n") + "\n"
    );
    if (!existing)
      await commandRunner("gh", [
        "release",
        "create",
        tag,
        "--repo",
        repository,
        "--draft",
        "--prerelease",
        "--title",
        `CoworkOS runtime ${tag}`,
        "--notes-file",
        notes
      ]);
    // Only drafts may be resumed. Exact filenames prevent accidental private artifact uploads.
    for (const file of files)
      await commandRunner("gh", ["release", "upload", tag, file, "--repo", repository, "--clobber"], {
        maxBuffer: 1024 * 1024
      });
    await commandRunner("gh", [
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      "--prerelease"
    ]);
    return `https://github.com/${repository}/releases/tag/${tag}`;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishComponents()
    .then(console.log)
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

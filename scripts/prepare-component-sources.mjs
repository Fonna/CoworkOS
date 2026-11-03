import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { COMPONENT_RELEASE_TAG } from "../dist/src/software/components/source.js";

// Maintainer-only source preparation. Public runtime installation never invokes gh or curl.
const directory = resolve(process.env.ATRIA_COMPONENT_SOURCES_DIR || ".tmp/component-sources");
const cache = join(directory, ".upstream");
await mkdir(cache, { recursive: true });
const assets = [];
const snapshots = new Map();
const gh = (path) => {
  const key = createHash("sha256").update(path).digest("hex");
  const location = join(cache, `${key}.json`);
  try {
    return JSON.parse(readFileSync(location, "utf8"));
  } catch {
    /* cache miss */
  }
  const result = JSON.parse(
    execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  );
  writeFileSync(location, JSON.stringify(result));
  return result;
};
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(file, upstream, { bytes, expectedSha256, kind = "source", ...metadata } = {}) {
  const target = join(directory, file);
  let valid = await stat(target).then(
    (value) => value.isFile() && (!bytes || value.size === bytes),
    () => false
  );
  if (valid && /\.(?:tar\.(?:gz|xz)|tgz)$/.test(file)) {
    try {
      execFileSync("tar", ["-tf", target], { stdio: "ignore" });
    } catch {
      valid = false;
    }
  }
  if (valid && file.endsWith(".zip")) {
    try {
      execFileSync("unzip", ["-tq", target], { stdio: "ignore" });
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    console.log(`Downloading source: ${file}`);
    execFileSync(
      "curl",
      [
        "--fail",
        "--location",
        "--retry",
        "3",
        "--silent",
        "--show-error",
        upstream,
        "--output",
        `${target}.download`
      ],
      { stdio: "inherit" }
    );
    await rename(`${target}.download`, target);
  }
  const size = (await stat(target)).size;
  if (!size || size >= 2 ** 31 || (bytes && size !== bytes)) throw new Error(`Invalid source size: ${file}`);
  const sha256 = await digest(target);
  if (expectedSha256 && sha256 !== expectedSha256)
    throw new Error(`Upstream source checksum mismatch: ${file}`);
  const asset = { file, sha256, bytes: size, upstream, kind, ...metadata };
  assets.push(asset);
  return target;
}
async function github(repo, ref, { label, before, submodules = true } = {}) {
  const key = `${repo}@${ref}`;
  if (snapshots.has(key)) return snapshots.get(key);
  const metadataFile = join(cache, `${repo.replaceAll("/", "_")}-${ref.replaceAll("/", "_")}.json`);
  let commit;
  try {
    commit = JSON.parse(await readFile(metadataFile, "utf8"));
  } catch {
    commit = before
      ? gh(
          `repos/${repo}/commits?sha=${encodeURIComponent(ref)}&until=${encodeURIComponent(before)}&per_page=1`
        )[0]
      : gh(`repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if (!commit?.sha) throw new Error(`No upstream commit for ${key}`);
    await writeFile(metadataFile, JSON.stringify(commit));
  }
  const file = `${label || repo.replaceAll("/", "-")}-${commit.sha.slice(0, 12)}-source.tar.gz`;
  snapshots.set(key, file);
  await download(file, `https://codeload.github.com/${repo}/tar.gz/${commit.sha}`, {
    repository: repo,
    ref,
    commit: commit.sha,
    ...(before ? { snapshotBefore: before } : {})
  });
  if (!submodules) return file;
  // Source archives omit gitlinks. Preserve each dependency at the exact recorded gitlink.
  let modules;
  try {
    const response = gh(`repos/${repo}/contents/.gitmodules?ref=${commit.sha}`);
    modules = Buffer.from(response.content, "base64").toString("utf8");
  } catch (error) {
    if (String(error.stderr).includes("HTTP 404")) return file;
    throw error;
  }
  const entries = [...modules.matchAll(/\[submodule [^\]]+\]([\s\S]*?)(?=\[submodule|$)/g)].map(
    ([, block]) => ({
      path: block.match(/^\s*path\s*=\s*(.+)$/m)?.[1]?.trim(),
      url: block.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim()
    })
  );
  const tree = gh(`repos/${repo}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated) throw new Error(`Truncated submodule tree: ${repo}`);
  for (const entry of entries) {
    const gitlink = tree.tree.find((value) => value.path === entry.path && value.type === "commit");
    if (!gitlink) continue;
    const match = entry.url?.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (!match) throw new Error(`Unsupported submodule source ${repo}:${entry.path}`);
    await github(match[1], gitlink.sha);
  }
  return file;
}

await github("Open-Cascade-SAS/OCCT", "V7_8_1");
await github("CadQuery/OCP", "7.8.1.1");
const ocpIndex = join(cache, "ocp-pypi.json");
execFileSync("curl", [
  "--fail",
  "--location",
  "--silent",
  "--show-error",
  "https://pypi.org/pypi/cadquery-ocp/7.8.1.1.post1/json",
  "--output",
  ocpIndex
]);
const ocpRelease = JSON.parse(await readFile(ocpIndex, "utf8"));
const ocpWheel = ocpRelease.urls.find(
  (value) => value.filename.includes("cp311") && value.filename.includes("arm64")
);
if (!ocpWheel) throw new Error("OCP macOS arm64 wheel provenance was not found");
await github("CadQuery/ocp-build-system", "main", {
  before: ocpWheel.upload_time_iso_8601,
  submodules: false
});
await github("CadQuery/cadquery", "v2.6.1");
await download(
  "casadi-source-v3.8.1.zip",
  "https://github.com/casadi/casadi/releases/download/3.8.1/casadi-source-v3.8.1.zip",
  { bytes: 8010032 }
);
const casadiCommit = gh("repos/casadi/casadi/commits/3.8.1");
await github("casadi/casadi", "3.8.1");
await github("casadi/action-setup-compiler", "master", { before: casadiCommit.commit.committer.date });
await github("conda-forge/gfortran_impl_osx-64-feedstock", "44431d312251a738c455a57d15b106eb7953552e");
await download("gcc-12.4.0.tar.gz", "https://ftp.gnu.org/gnu/gcc/gcc-12.4.0/gcc-12.4.0.tar.gz", {
  expectedSha256: "5a30de2be740062bb3ddd3fd13c9b1bb4584d8f85616d33f23a713439d714148"
});
const cmakeResponse = gh(`repos/casadi/casadi/contents/CMakeLists.txt?ref=${casadiCommit.sha}`);
const cmake = Buffer.from(cmakeResponse.content, "base64").toString("utf8");
await writeFile(join(cache, "casadi-CMakeLists.txt"), cmake);
const python = resolve(".tools/cadquery-runtime/bin/python3");
const evidence = JSON.parse(
  execFileSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      "import casadi as c,json; print(json.dumps({k:getattr(c.CasadiMeta,k)() for k in ['version','git_revision','feature_list','compiler_id','build_type','modules']}))"
    ],
    { encoding: "utf8" }
  )
);
if (evidence.version !== "3.8.1" || evidence.git_revision !== casadiCommit.sha)
  throw new Error("CAD wheel source revision differs from the prepared CasADi release");
await writeFile(join(directory, "casadi-build-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
const compilerRuntimeUuids = {
  "libgfortran.5.dylib": "81ACE1A5-BFCF-331E-95AF-9937C9612B6B",
  "libquadmath.0.dylib": "71CF453F-5A66-3A4C-90CB-1AED0D2407DC",
  "libgcc_s.1.1.dylib": "6A5DE030-CDB9-3277-9572-5A9B6797AC1C"
};
for (const [file, uuid] of Object.entries(compilerRuntimeUuids)) {
  const actual = execFileSync(
    "dwarfdump",
    ["--uuid", resolve(".tools/cadquery-runtime/lib/python3.11/site-packages/casadi", file)],
    { encoding: "utf8" }
  );
  if (!actual.includes(uuid)) throw new Error(`Compiler runtime provenance changed: ${file}`);
}
await writeFile(
  join(directory, "compiler-runtime-source-evidence.json"),
  JSON.stringify(
    {
      package: "conda-forge/libgfortran5-12.4.0-h98f8ed6_105",
      packageSha256: "f99c51a95c002b08fa8f45dbe0167b2ed20fd44fefced7b768dbe0d9ab7e29ca",
      packageUpstream:
        "https://api.anaconda.org/download/conda-forge/libgfortran5/12.4.0/osx-arm64/libgfortran5-12.4.0-h98f8ed6_105.conda",
      runtimeMachOUuids: compilerRuntimeUuids,
      source: "gcc-12.4.0.tar.gz",
      patchAndBuildRepository: "conda-forge/gfortran_impl_osx-64-feedstock",
      patchAndBuildCommit: "44431d312251a738c455a57d15b106eb7953552e"
    },
    null,
    2
  ) + "\n"
);
const values = new Map(
  [...cmake.matchAll(/set\((BUILD_[A-Z0-9_]+)\s+(?:"([^"]+)"|([^\s)]+))\s+CACHE/g)].map(
    ([, key, quoted, unquoted]) => [key, quoted || unquoted]
  )
);
const excluded = new Set(["RUMOCA", "ALPAQA", "SPRAL"]); // Not built into this wheel.
for (const [key, url] of values) {
  if (!key.endsWith("_GIT_REPO")) continue;
  const name = key.slice(6, -9);
  if (excluded.has(name)) continue;
  const ref = values.get(`BUILD_${name}_VERSION`);
  if (!ref) throw new Error(`Missing source version: ${key}`);
  const githubMatch = url.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (githubMatch) {
    const floating = [
      "main",
      "master",
      "develop",
      "patch-1",
      "bugfix2",
      "gate-unconditional-use-omp-lib"
    ].includes(ref);
    await github(githubMatch[1], ref, floating ? { before: casadiCommit.commit.committer.date } : {});
  } else if (name === "EIGEN3") {
    await download(
      "eigen-3.4.0-source.tar.gz",
      "https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz"
    );
  } else throw new Error(`Unsupported upstream source: ${url}`);
}
await download("metis-4.0.3.tar.gz", "https://coin-or-tools.github.io/ThirdParty-Metis/metis-4.0.3.tar.gz");
await download("MUMPS_5.8.2.tar.gz", "https://coin-or-tools.github.io/ThirdParty-Mumps/MUMPS_5.8.2.tar.gz");

await download("blender-4.5.11.tar.xz", "https://download.blender.org/source/blender-4.5.11.tar.xz", {
  bytes: 85104276
});
await download(
  "blender-with-libraries-4.5.0.tar.xz",
  "https://download.blender.org/source/blender-with-libraries-4.5.0.tar.xz",
  {
    bytes: 1544879472,
    purpose:
      "Blender 4.5 dependency source baseline; use the 4.5.11 source tree and its version recipes for the application."
  }
);

const blenderVersions = (file, version) =>
  execFileSync(
    "tar",
    ["-xOf", join(directory, file), `blender-${version}/build_files/build_environment/cmake/versions.cmake`],
    { encoding: "utf8" }
  );
const versionDeclarations = (content) =>
  [...content.matchAll(/^set\([^\n]*(?:_VERSION|_HASH|_URI|_FILE)[^\n]*$/gm)]
    .map(([line]) => line)
    .join("\n");
const baselineVersions = versionDeclarations(blenderVersions("blender-with-libraries-4.5.0.tar.xz", "4.5.0"));
const finalVersions = versionDeclarations(blenderVersions("blender-4.5.11.tar.xz", "4.5.11"));
if (baselineVersions !== finalVersions)
  throw new Error("Blender dependency sources changed; prepare the additional versions before publication");
await writeFile(
  join(directory, "blender-source-evidence.json"),
  JSON.stringify(
    {
      sourceVersion: "4.5.11",
      dependencySourceVersion: "4.5.0",
      matchingDependencyVersionAndHashDeclarations: true,
      declarationsSha256: createHash("sha256").update(finalVersions).digest("hex")
    },
    null,
    2
  ) + "\n"
);
const licenseRoot = join(directory, ".licenses");
await mkdir(licenseRoot, { recursive: true });
async function retainLicenses(source, destination, inherited = false) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const selected = inherited || /license|copying|notice|copyright/i.test(entry.name);
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await retainLicenses(from, to, selected);
    else if (selected || entry.name === "METADATA") {
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to);
    }
  }
}
await retainLicenses(resolve(".tools/cadquery-runtime"), join(licenseRoot, "cadquery-runtime"));
await retainLicenses(
  resolve(".tools/blender-runtime/Blender.app/Contents/Resources/text"),
  join(licenseRoot, "blender-notices")
);
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "scripts/cadquery-requirements.txt"])
  await cp(resolve(file), join(licenseRoot, basename(file)));
const licenseFile = "atria-component-license-materials.tar.gz";
execFileSync("tar", ["-czf", join(directory, licenseFile), "-C", licenseRoot, "."], { stdio: "inherit" });
const notes = `# Component source and notices\n\nThese materials accompany the fixed component release; their individual licenses remain applicable.\n\n- Blender 4.5.11 is the unmodified official binary. blender-4.5.11.tar.xz contains its application source and build recipes. blender-with-libraries-4.5.0.tar.xz contains the official 4.5-series dependency-source baseline. The dependency version, archive name, URL and hash declarations match between 4.5.0 and 4.5.11; blender-source-evidence.json records that check.\n- CAD retains standalone CPython and wheel notices. OCP uses OCCT 7.8.1 under LGPL-2.1 plus the OCCT exception; the binding sources and pywrap gitlink are supplied independently.\n- CasADi 3.8.1 wheel git revision ${evidence.git_revision} matches its release. casadi-build-evidence.json records actual wheel features. Sources include its release source, dependency repositories, their gitlinks, METIS and MUMPS originals, and the upstream build patches. Dependency branches are frozen at or before the CasADi release commit; the manifest records the resolved revisions.\n- The included libgfortran, libquadmath and libgcc_s have matching Mach-O UUIDs with conda-forge libgfortran5-12.4.0-h98f8ed6_105. Its recipe identifies GCC 12.4.0 and feedstock commit 44431d312251a738c455a57d15b106eb7953552e; both source and patches/build recipes are supplied.\n- The proprietary-solver integrations in CasADi are mockup interfaces; no vendor solver license is granted by this distribution. Use of separately installed vendor software remains subject to its license.\n- Upstream METIS distribution clarification is retained in ThirdParty-Metis/INSTALL.Metis; its older source LICENSE must be read with that upstream clarification.\n- Source and license materials are downloadable beside the binaries; downloading these optional materials is not necessary for normal App use.\n\nThe source materials include upstream build recipes. They are not evidence that a source rebuild, signing/notarization or clean-machine installation has been completed.\n`;
await writeFile(join(directory, "SOURCE_NOTICES.md"), notes);
for (const file of [
  licenseFile,
  "SOURCE_NOTICES.md",
  "casadi-build-evidence.json",
  "blender-source-evidence.json",
  "compiler-runtime-source-evidence.json"
]) {
  assets.push({
    file,
    sha256: await digest(join(directory, file)),
    bytes: (await stat(join(directory, file))).size,
    kind: file === licenseFile ? "licenses" : "notice"
  });
}
await writeFile(
  join(directory, "SOURCE_MANIFEST.json"),
  JSON.stringify({ schemaVersion: 1, componentRelease: COMPONENT_RELEASE_TAG, assets }, null, 2) + "\n"
);
console.log(`Prepared ${assets.length} source/license assets in ${directory}`);

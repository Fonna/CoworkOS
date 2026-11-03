import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  checkNpmDesktopRelease,
  downloadNpmDesktopRelease,
  NPM_DESKTOP_PACKAGE,
  NPM_REGISTRY,
  npmDesktopManifest
} from "../scripts/update-npm-desktop.mjs";

const execute = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const integrity = (value) => "sha512-" + createHash("sha512").update(value).digest("base64");

async function fixture(t, { extraFile } = {}) {
  const root = await mkdtemp(join(tmpdir(), "coworkos-npm-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "source", "package");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0" }));
  const version = "0.2.0";
  const bytes = Buffer.from("verified Mac DMG fixture");
  const desktopRelease = npmDesktopManifest({ version, bytes });
  const manifest = {
    name: NPM_DESKTOP_PACKAGE,
    version,
    os: ["darwin"],
    cpu: ["arm64"],
    license: "MIT",
    desktopRelease
  };
  await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
  await writeFile(join(pkg, "LICENSE"), "MIT fixture");
  await writeFile(join(pkg, desktopRelease.artifact.name), bytes);
  if (extraFile) await writeFile(join(pkg, extraFile), "unexpected");
  const archive = join(root, "package.tgz");
  await execute("tar", [
    "-czf",
    archive,
    "-C",
    join(root, "source"),
    "package/package.json",
    "package/LICENSE",
    `package/${desktopRelease.artifact.name}`,
    ...(extraFile ? [`package/${extraFile}`] : [])
  ]);
  const tarball = await readFile(archive);
  const unpackedSize =
    JSON.stringify(manifest).length + Buffer.byteLength("MIT fixture") + bytes.length + (extraFile ? 10 : 0);
  const metadata = {
    ...manifest,
    dist: {
      tarball:
        NPM_REGISTRY + "/" + NPM_DESKTOP_PACKAGE + "/-/" + NPM_DESKTOP_PACKAGE + "-" + version + ".tgz",
      integrity: integrity(tarball),
      unpackedSize
    }
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    options.signal?.throwIfAborted();
    requests.push({ url, options });
    if (url === NPM_REGISTRY + "/" + NPM_DESKTOP_PACKAGE + "/latest")
      return new Response(JSON.stringify(metadata));
    if (url === metadata.dist.tarball) return new Response(tarball);
    return new Response("missing", { status: 404 });
  };
  return { root, version, bytes, desktopRelease, metadata, tarball, requests, fetchImpl };
}

test("checks the platform package on npm and extracts only its verified DMG", async (t) => {
  const f = await fixture(t);
  const check = await checkNpmDesktopRelease({
    root: f.root,
    kind: "mac",
    arch: "arm64",
    fetchImpl: f.fetchImpl
  });
  assert.equal(check.source, "npm-registry");
  assert.equal(check.package, NPM_DESKTOP_PACKAGE);
  assert.equal(check.version, "0.2.0");
  assert.equal(check.available, true);
  assert.equal(check.manifest.artifact.sha256, digest(f.bytes));
  const download = join(f.root, "downloads");
  const path = await downloadNpmDesktopRelease({ check, directory: download, fetchImpl: f.fetchImpl });
  assert.deepEqual(await readFile(path), f.bytes);
  assert.deepEqual(await readdir(download), [f.desktopRelease.artifact.name]);
  assert.deepEqual(
    f.requests.map(({ url }) => url),
    [NPM_REGISTRY + "/" + NPM_DESKTOP_PACKAGE + "/latest", f.metadata.dist.tarball]
  );
  assert.equal(f.requests[0].options.headers.accept, "application/json");
  assert.equal(f.requests[1].options.headers.accept, "application/octet-stream");
});

test("reordered registry release fields remain equivalent while changed values are rejected", async (t) => {
  const f = await fixture(t);
  const registryMetadata = structuredClone(f.metadata);
  registryMetadata.desktopRelease = Object.fromEntries(
    Object.entries(registryMetadata.desktopRelease)
      .reverse()
      .map(([key, value]) => [
        key,
        key === "artifact" ? Object.fromEntries(Object.entries(value).reverse()) : value
      ])
  );
  const fetchImpl = async (url, options) =>
    url.endsWith("/latest") ? new Response(JSON.stringify(registryMetadata)) : f.fetchImpl(url, options);
  const check = await checkNpmDesktopRelease({ root: f.root, fetchImpl });
  const path = await downloadNpmDesktopRelease({
    check,
    directory: join(f.root, "reordered-download"),
    fetchImpl
  });
  assert.deepEqual(await readFile(path), f.bytes);

  const altered = structuredClone(registryMetadata);
  altered.desktopRelease.artifact.sha256 = "a".repeat(64);
  const alteredFetch = async (url, options) =>
    url.endsWith("/latest") ? new Response(JSON.stringify(altered)) : f.fetchImpl(url, options);
  const alteredCheck = await checkNpmDesktopRelease({ root: f.root, fetchImpl: alteredFetch });
  await assert.rejects(
    downloadNpmDesktopRelease({
      check: alteredCheck,
      directory: join(f.root, "altered-download"),
      fetchImpl: alteredFetch
    }),
    /内部清单与 registry 元数据不匹配/
  );
  assert.deepEqual(await readdir(join(f.root, "altered-download")), []);
});

test("metadata rejects other packages, platforms, versions and tarball hosts", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (metadata) => (metadata.name = "another-package"),
    (metadata) => (metadata.cpu = ["x64"]),
    (metadata) => (metadata.os = ["linux"]),
    (metadata) => (metadata.desktopRelease.artifact.sha256 = "x".repeat(64)),
    (metadata) => (metadata.dist.tarball = "https://attacker.invalid/package.tgz"),
    (metadata) => (metadata.dist.integrity = "sha256-" + "a".repeat(44)),
    (metadata) => (metadata.dist.unpackedSize = metadata.desktopRelease.artifact.size - 1)
  ]) {
    const value = structuredClone(f.metadata);
    mutate(value);
    const fetchImpl = async (url, options) =>
      url.endsWith("/latest") ? new Response(JSON.stringify(value)) : f.fetchImpl(url, options);
    await assert.rejects(checkNpmDesktopRelease({ root: f.root, fetchImpl }), /npm|registry|完整性|发行信息/);
  }
  await assert.rejects(
    checkNpmDesktopRelease({ root: f.root, arch: "x64", fetchImpl: () => assert.fail("unsupported arch") }),
    /平台/
  );
});

test("tarball integrity and exact archive members are checked before returning a DMG", async (t) => {
  const f = await fixture(t);
  const check = await checkNpmDesktopRelease({ root: f.root, fetchImpl: f.fetchImpl });
  const tampered = Buffer.from("changed package archive");
  const tamperedFetch = async (url, options) =>
    url === check.tarball.url ? new Response(tampered) : f.fetchImpl(url, options);
  await assert.rejects(
    downloadNpmDesktopRelease({ check, directory: join(f.root, "bad-integrity"), fetchImpl: tamperedFetch }),
    /完整性/
  );
  assert.deepEqual(await readdir(join(f.root, "bad-integrity")), []);

  const malicious = await fixture(t, { extraFile: "unexpected.txt" });
  const maliciousCheck = await checkNpmDesktopRelease({
    root: malicious.root,
    fetchImpl: malicious.fetchImpl
  });
  await assert.rejects(
    downloadNpmDesktopRelease({
      check: maliciousCheck,
      directory: join(malicious.root, "extract"),
      fetchImpl: malicious.fetchImpl
    }),
    /未允许的路径/
  );
  assert.deepEqual(await readdir(join(malicious.root, "extract")), []);
});

test("unavailable npm versions and malformed registry responses report retryable errors", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    checkNpmDesktopRelease({ root: f.root, fetchImpl: async () => new Response("missing", { status: 404 }) }),
    /尚未发布/
  );
  await assert.rejects(
    checkNpmDesktopRelease({ root: f.root, fetchImpl: async () => new Response("not JSON") }),
    /无效/
  );
  await assert.rejects(
    checkNpmDesktopRelease({
      root: f.root,
      fetchImpl: async () => {
        throw new Error("private network detail");
      }
    }),
    /无法连接/
  );
});

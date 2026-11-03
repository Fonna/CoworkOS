import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PUBLIC_RELEASE_REPOSITORY,
  PUBLIC_UPDATE_FEED_URL,
  MAX_PUBLIC_ARTIFACT_BYTES,
  checkRelease,
  downloadRelease,
  releaseAssetUrl,
  validatePublicReleaseFeed
} from "../scripts/update-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = PUBLIC_RELEASE_REPOSITORY;
function feedFixture(version = "1.1.0-beta.2", legacy = false) {
  const entries = new Map();
  const artifacts = [];
  for (const name of [
    `${legacy ? "Atria" : "CoworkOS"}-${version}-mac-arm64.dmg`,
    `${legacy ? "atria-cowork-cli" : "coworkos-cli"}-${version}.tgz`
  ]) {
    const bytes = Buffer.from(`fixture bytes for ${name}`);
    for (const [file, content] of [
      [name, bytes],
      [`${name}.sha256`, Buffer.from(`${hash(bytes)}  ${name}\n`)]
    ]) {
      const url = releaseAssetUrl(repository, `v${version}`, file);
      entries.set(url, content);
      artifacts.push({ name: file, size: content.length, sha256: hash(content), url });
    }
  }
  const feed = {
    schemaVersion: 1,
    repository,
    version,
    publishedAt: "2026-10-16T01:00:00.000Z",
    releaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
    artifacts
  };
  const requests = [];
  return {
    feed,
    entries,
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, undefined, "public requests never receive a token");
      assert.ok(!url.startsWith("https://api.github.com/"), "clients never depend on the Releases API");
      return url === PUBLIC_UPDATE_FEED_URL
        ? new Response(JSON.stringify(feed))
        : entries.has(url)
          ? new Response(entries.get(url))
          : new Response("missing", { status: 404 });
    }
  };
}
async function fixture(t, version = "1.0.0") {
  const root = await mkdtemp(join(tmpdir(), "atria-public-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ version, repository: "git+https://github.com/private/source.git" })
  );
  return root;
}

test("default updates use one anonymous static public pointer and ignore private repository/token/channel preferences", async (t) => {
  const root = await fixture(t);
  const api = feedFixture();
  const previous = {
    token: process.env.ATRIA_UPDATE_TOKEN,
    channel: process.env.ATRIA_UPDATE_CHANNEL,
    repository: process.env.ATRIA_UPDATE_REPOSITORY
  };
  Object.assign(process.env, {
    ATRIA_UPDATE_TOKEN: "fixture-private-token",
    ATRIA_UPDATE_CHANNEL: "stable",
    ATRIA_UPDATE_REPOSITORY: "private/source"
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      const key = `ATRIA_UPDATE_${name.toUpperCase()}`;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const check = await checkRelease({ root, kind: "mac", arch: "arm64", token: "also-ignored", ...api });
  assert.equal(check.source, "public-feed");
  assert.equal(check.repository, repository);
  assert.equal(check.version, api.feed.version);
  assert.equal(check.available, true);
  assert.equal("channel" in check, false);
  assert.equal(check.asset.sha256.length, 64);
  assert.ok(Number.isSafeInteger(check.asset.size) && check.asset.size > 0);
  assert.deepEqual(
    api.requests.map(({ url }) => url),
    [PUBLIC_UPDATE_FEED_URL]
  );
});

test("public pointers can select a beta directly but can never make an older or equal version installable", async (t) => {
  for (const current of ["1.1.0-beta.2", "1.1.0", "2.0.0"]) {
    const root = await fixture(t, current);
    const api = feedFixture();
    const check = await checkRelease({ root, ...api });
    assert.equal(check.available, false);
    await assert.rejects(downloadRelease({ check, directory: join(root, "download"), ...api }), /先检查/);
    assert.equal(api.requests.length, 1);
  }
});

test("public feeds reject malformed fields, foreign URLs, duplicate names, invalid digests and unbounded sizes", () => {
  const { feed } = feedFixture();
  assert.equal(validatePublicReleaseFeed(feed).version, feed.version);
  const invalid = [
    (v) => (v.schemaVersion = 2),
    (v) => (v.repository = "private/source"),
    (v) => (v.version = "1.0.0-01"),
    (v) => (v.version = "1." + "1".repeat(140) + ".0"),
    (v) => (v.publishedAt = "2026-02-31T01:00:00.000Z"),
    (v) => (v.publishedAt = "yesterday"),
    (v) => (v.releaseUrl += "?token=secret"),
    (v) => (v.extra = "unrecognized"),
    (v) => v.artifacts.push(v.artifacts[0]),
    (v) => v.artifacts.pop(),
    (v) => (v.artifacts[0].name = "../outside.dmg"),
    (v) => (v.artifacts[0].url = "https://evil.invalid/archive.dmg"),
    (v) => (v.artifacts[0].url = v.artifacts[0].url.replace("v1.1.0-beta.2", "v9.0.0")),
    (v) => (v.artifacts[0].size = 0),
    (v) => (v.artifacts[0].size = 1.5),
    (v) => (v.artifacts[0].size = MAX_PUBLIC_ARTIFACT_BYTES + 1),
    (v) => (v.artifacts[0].sha256 = "f".repeat(63)),
    (v) => (v.artifacts[0].apiUrl = "https://api.github.com/private"),
    (v) => (v.feedUrl = "https://evil.invalid/signed.json"),
    (v) => (v.feedUrl = releaseAssetUrl(repository, `v${v.version}`, "atria-update-mac-arm64.json"))
  ];
  for (const mutate of invalid) {
    const value = structuredClone(feed);
    mutate(value);
    assert.throws(() => validatePublicReleaseFeed(value));
  }
});

test("signed public pointer requires the matching public ZIP, checksum and native feed as one set", () => {
  const { feed } = feedFixture();
  const names = [
    `CoworkOS-${feed.version}-mac-arm64.zip`,
    `CoworkOS-${feed.version}-mac-arm64.zip.sha256`,
    "atria-update-mac-arm64.json"
  ];
  feed.artifacts.push(
    ...names.map((name) => ({
      name,
      size: 4,
      sha256: "a".repeat(64),
      url: releaseAssetUrl(repository, `v${feed.version}`, name)
    }))
  );
  assert.throws(() => validatePublicReleaseFeed(feed), /附件/);
  feed.feedUrl = releaseAssetUrl(repository, `v${feed.version}`, names[2]);
  assert.equal(validatePublicReleaseFeed(feed).feedUrl, feed.feedUrl);
  feed.artifacts.pop();
  assert.throws(() => validatePublicReleaseFeed(feed), /缺少/);
});

test("public update information rejects oversized bodies and handles invalid JSON and unavailable networks", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    checkRelease({ root, fetchImpl: async () => new Response("x".repeat(32 * 1024 + 1)) }),
    /大小/
  );
  await assert.rejects(checkRelease({ root, fetchImpl: async () => new Response("not JSON") }), /无效/);
  await assert.rejects(
    checkRelease({
      root,
      fetchImpl: async () => {
        throw new Error("private network detail");
      }
    }),
    /无法连接/
  );
  await assert.rejects(
    checkRelease({
      root,
      kind: "mac",
      arch: "x64",
      fetchImpl: () => assert.fail("unsupported platform must not request")
    }),
    /平台/
  );
});

test("public downloads verify pointer sizes/digests plus checksum contents and preserve an earlier good file", async (t) => {
  const root = await fixture(t);
  const api = feedFixture();
  const check = await checkRelease({ root, ...api });
  const directory = join(root, "downloads");
  const progress = [];
  const file = await downloadRelease({
    check,
    directory,
    token: "must-not-be-forwarded",
    ...api,
    onProgress: (value) => progress.push(value)
  });
  const bytes = api.entries.get(check.asset.url);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal(progress.at(-1).phase, "downloaded");
  assert.deepEqual(await readdir(directory), [check.asset.name]);
  api.entries.set(check.asset.url, Buffer.from("corruption"));
  await assert.rejects(downloadRelease({ check, directory, ...api }), /校验失败/);
  assert.deepEqual(await readFile(file), bytes);
  api.entries.set(check.asset.url, bytes);
  check.asset.size++;
  await assert.rejects(downloadRelease({ check, directory, ...api }), /校验失败/);
  check.asset.size--;
  api.entries.set(check.checksum.url, Buffer.from(`${hash(bytes)}  wrong.tgz\n`));
  await assert.rejects(downloadRelease({ check, directory, ...api }), /校验文件/);
  const wrong = api.entries.get(check.checksum.url);
  check.checksum.size = wrong.length;
  check.checksum.sha256 = hash(wrong);
  await assert.rejects(downloadRelease({ check, directory, ...api }), /校验文件/);
  assert.deepEqual(await readdir(directory), [check.asset.name]);
});

test("public download rejects forged metadata and API destinations before any network request", async (t) => {
  const root = await fixture(t);
  const api = feedFixture();
  const check = await checkRelease({ root, ...api });
  check.asset.apiUrl = "https://api.github.com/repos/private/source/releases/assets/1";
  await assert.rejects(
    downloadRelease({
      check,
      directory: root,
      fetchImpl: () => assert.fail("forged metadata must not request")
    }),
    /字段/
  );
});

// Real metadata/download paths stay usable while historical assets retain their names.
test("CoworkOS reads and verifies historical Atria public releases without accepting mixed asset families", async (t) => {
  const root = await fixture(t);
  for (const kind of ["cli", "mac"]) {
    const api = feedFixture("1.2.0", true);
    const check = await checkRelease({ root, kind, arch: "arm64", ...api });
    assert.ok(check.asset.name.startsWith(kind === "cli" ? "atria-cowork-cli-" : "Atria-"));
    const file = await downloadRelease({ check, directory: join(root, kind), ...api });
    assert.deepEqual(await readFile(file), api.entries.get(check.asset.url));
  }
  const legacy = feedFixture("1.2.0", true).feed;
  legacy.artifacts[0] = feedFixture("1.2.0").feed.artifacts[0];
  assert.throws(() => validatePublicReleaseFeed(legacy), /附件/);
});

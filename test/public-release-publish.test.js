import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { publishPublicRelease } from "../scripts/public-release-publish.mjs";
import {
  PUBLIC_RELEASE_REPOSITORY,
  publicReleaseArtifactNames,
  releaseAssetUrl
} from "../scripts/update-release.mjs";

const repository = PUBLIC_RELEASE_REPOSITORY;
const version = "1.2.0-beta.1";
const tag = `v${version}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function publicFeed(selectedVersion) {
  return {
    schemaVersion: 1,
    repository,
    version: selectedVersion,
    publishedAt: "2026-10-16T01:00:00.000Z",
    releaseUrl: `https://github.com/${repository}/releases/tag/v${selectedVersion}`,
    artifacts: publicReleaseArtifactNames(selectedVersion).map((name) => ({
      name,
      size: 1,
      sha256: "a".repeat(64),
      url: releaseAssetUrl(repository, `v${selectedVersion}`, name)
    }))
  };
}
function pointer(feed, sha = "a".repeat(40)) {
  const content = Buffer.from(JSON.stringify(feed, null, 2) + "\n");
  return { type: "file", encoding: "base64", sha, size: content.length, content: content.toString("base64") };
}
const missing = () => Object.assign(new Error("not found"), { status: 404 });
async function fixture(t, initialFeed) {
  const root = await mkdtemp(join(tmpdir(), "atria-public-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "release"));
  const names = publicReleaseArtifactNames(version);
  const artifacts = [];
  for (const name of names) {
    const bytes = Buffer.from(`fixture ${name}`);
    await writeFile(join(root, "release", name), bytes);
    artifacts.push({ name, size: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(
    join(root, "release", `atria-release-${version}.md`),
    "Test release notes without any private source tree.\n"
  );
  const manifest = {
    version,
    source: { repository: "private/source", commit: "b".repeat(40), tag },
    mac: { signing: "adhoc", developerId: false },
    files: names,
    artifacts: artifacts.slice(0, 6)
  };
  const state = {
    pointer: initialFeed ? pointer(initialFeed) : undefined,
    release: undefined,
    calls: [],
    uploads: [],
    reads: 0
  };
  const json = (value) => ({ stdout: JSON.stringify(value), stderr: "" });
  const commandRunner = async (command, args) => {
    assert.equal(command, "gh");
    state.calls.push([...args]);
    if (args[0] === "api") {
      if (args[1] === "--paginate") {
        assert.equal(args[2], "--slurp");
        assert.equal(args[3], `repos/${repository}/releases?per_page=100`);
        state.reads++;
        await state.onReadRelease?.();
        return json([state.release ? [state.release] : []]);
      }
      if (args[1] === "--method") {
        assert.equal(args[2], "PUT");
        assert.equal(args[3], `repos/${repository}/contents/updates/coworkos-latest.json`);
        const payload = JSON.parse(await readFile(args[5], "utf8"));
        state.payload = payload;
        if (payload.sha !== state.pointer?.sha) throw Object.assign(new Error("conflict"), { status: 409 });
        state.pointer = pointer(JSON.parse(Buffer.from(payload.content, "base64")), "c".repeat(40));
        return json({ content: state.pointer });
      }
      if (args[1] === `repos/${repository}`) return json({ private: false, default_branch: "main" });
      if (args[1] === `repos/${repository}/contents/updates/coworkos-latest.json?ref=main`) {
        if (!state.pointer) throw missing();
        return json(state.pointer);
      }
      if (args[1] === `repos/${repository}/releases/42`) {
        state.reads++;
        await state.onReadRelease?.();
        if (!state.release) throw missing();
        return json(state.release);
      }
      assert.fail("unexpected API: " + args.join(" "));
    }
    if (args[0] === "release" && args[1] === "create") {
      assert.equal(args[args.indexOf("--target") + 1], "main");
      assert.ok(!args.includes(manifest.source.commit), "public tags never copy private source commits");
      state.release = { id: 42, tag_name: tag, draft: true, assets: [] };
      return json({});
    }
    if (args[0] === "release" && args[1] === "upload") {
      assert.equal(state.release.draft, true);
      const files = args.slice(3, args.indexOf("--repo"));
      state.uploads = files;
      state.release.assets = await Promise.all(
        files.map(async (file) => {
          const bytes = await readFile(file);
          return {
            name: basename(file),
            state: "uploaded",
            size: bytes.length,
            digest: `sha256:${hash(bytes)}`
          };
        })
      );
      await state.onUploaded?.();
      return json({});
    }
    if (args[0] === "release" && args[1] === "edit") {
      assert.ok(args.includes("--draft=false"));
      state.release.draft = false;
      state.release.published_at = "2026-10-16T03:00:00Z";
      await state.onPublished?.();
      return json({});
    }
    assert.fail("unexpected command: " + args.join(" "));
  };
  const options = {
    root,
    tag,
    commandRunner,
    verifyArtifacts: async (input) => {
      assert.equal(input.requireSigningReport, true);
      assert.equal(input.root, root);
      assert.equal(input.tag, tag);
      return manifest;
    }
  };
  return { root, manifest, artifacts, state, options };
}

test("public publisher uploads exactly eight verified files, checks remote digests, publishes, then creates the anonymous pointer", async (t) => {
  const f = await fixture(t);
  const result = await publishPublicRelease(f.options);
  assert.equal(result.uploaded, 8);
  assert.equal(result.repository, repository);
  assert.deepEqual(
    f.state.uploads.map((file) => basename(file)),
    publicReleaseArtifactNames(version)
  );
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.payload.sha, undefined);
  assert.equal(f.state.payload.branch, "main");
  const feed = JSON.parse(Buffer.from(f.state.pointer.content, "base64"));
  assert.equal(feed.version, version);
  assert.equal(feed.artifacts.length, 8);
  assert.ok(
    feed.artifacts.every((asset) =>
      asset.url.startsWith(`https://github.com/${repository}/releases/download/${tag}/`)
    )
  );
  assert.equal(JSON.stringify(feed).includes("private/source"), false);
  const commands = f.state.calls.map((args) => args.slice(0, 3).join(" "));
  assert.ok(commands.indexOf("release upload " + tag) < commands.indexOf("release edit " + tag));
  assert.ok(commands.indexOf("release edit " + tag) < commands.indexOf("api --method PUT"));
});

test("public pointer advancement sends the exact previous contents SHA", async (t) => {
  const f = await fixture(t, publicFeed("1.1.0"));
  await publishPublicRelease(f.options);
  assert.equal(f.state.payload.sha, "a".repeat(40));
});

for (const remoteVersion of [version, "1.3.0", "2.0.0-beta.1"])
  test(`publisher refuses pointer downgrade or same-version replacement from ${remoteVersion}`, async (t) => {
    const f = await fixture(t, publicFeed(remoteVersion));
    await assert.rejects(publishPublicRelease(f.options), /cannot move backwards|same version/);
    assert.equal(f.state.uploads.length, 0);
    assert.equal(f.state.release, undefined);
    assert.equal(
      f.state.calls.some((args) => args[0] === "release"),
      false
    );
  });

for (const mutation of ["missing-digest", "wrong-digest", "wrong-size", "extra-asset"])
  test(`publisher refuses ${mutation} before making a draft public or moving its pointer`, async (t) => {
    const f = await fixture(t);
    f.state.onUploaded = () => {
      if (mutation === "missing-digest") delete f.state.release.assets[0].digest;
      if (mutation === "wrong-digest") f.state.release.assets[0].digest = "sha256:" + "f".repeat(64);
      if (mutation === "wrong-size") f.state.release.assets[0].size++;
      if (mutation === "extra-asset") f.state.release.assets.push({ name: "private-source.zip" });
    };
    await assert.rejects(publishPublicRelease(f.options), /digest|missing or unexpected/);
    assert.equal(f.state.release.draft, true);
    assert.equal(f.state.pointer, undefined);
  });

test("publisher refuses existing published releases without uploading or overwriting anything", async (t) => {
  const f = await fixture(t);
  f.state.release = { id: 42, tag_name: tag, draft: false, assets: [] };
  await assert.rejects(publishPublicRelease(f.options), /already published/);
  assert.equal(f.state.uploads.length, 0);
  assert.equal(f.state.pointer, undefined);
});

test("publisher detects a concurrently changed pointer before publishing the draft", async (t) => {
  const f = await fixture(t, publicFeed("1.0.0"));
  f.state.onUploaded = () => {
    f.state.pointer = pointer(publicFeed("2.0.0"), "d".repeat(40));
  };
  await assert.rejects(publishPublicRelease(f.options), /changed concurrently/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.payload, undefined);
});

test("contents compare-and-swap refuses a race after Release publication without replacing a newer pointer", async (t) => {
  const f = await fixture(t, publicFeed("1.0.0"));
  f.state.onPublished = () => {
    f.state.pointer = pointer(publicFeed("2.0.0"), "e".repeat(40));
  };
  await assert.rejects(publishPublicRelease(f.options), /published, but.*changed concurrently/);
  assert.equal(f.state.release.draft, false);
  assert.equal(JSON.parse(Buffer.from(f.state.pointer.content, "base64")).version, "2.0.0");
});

test("publisher refuses signed releases until their complete ZIP distribution is explicitly supported", async (t) => {
  const f = await fixture(t);
  f.manifest.mac = { signing: "developer-id", developerId: true };
  await assert.rejects(publishPublicRelease(f.options), /signed ZIP publishing is not configured/);
  assert.equal(f.state.calls.length, 0);
});

test("publisher rejects symlink artifacts, unknown files, changed bytes and verifier failure before remote mutation", async (t) => {
  const f = await fixture(t);
  f.manifest.files.push("config.json");
  await assert.rejects(publishPublicRelease(f.options), /exactly the eight/);
  f.manifest.files.pop();
  const original = join(f.root, "release", f.artifacts[0].name);
  const target = join(f.root, "outside-runtime");
  await writeFile(target, "fixture");
  await rm(original);
  await symlink(target, original);
  await assert.rejects(publishPublicRelease(f.options), /regular files/);
  await rm(original);
  await writeFile(original, "changed runtime");
  await assert.rejects(publishPublicRelease(f.options), /changed before/);
  await assert.rejects(
    publishPublicRelease({
      ...f.options,
      verifyArtifacts: async () => {
        throw new Error("source tag is dirty");
      }
    }),
    /source tag is dirty/
  );
  assert.equal(f.state.calls.length, 0);
});

function publishedRelease(f) {
  return {
    id: 42,
    tag_name: tag,
    draft: false,
    published_at: "2026-10-16T03:00:00Z",
    assets: f.artifacts.map((artifact) => ({
      name: artifact.name,
      size: artifact.size,
      digest: `sha256:${artifact.sha256}`,
      state: "uploaded"
    }))
  };
}

test("resume-pointer recovers an already published release using remote digests without uploading or editing its assets", async (t) => {
  const f = await fixture(t, publicFeed("1.0.0"));
  f.state.release = publishedRelease(f);
  const result = await publishPublicRelease({ ...f.options, resumePointer: true });
  assert.equal(result.uploaded, 0);
  assert.equal(f.state.payload.sha, "a".repeat(40));
  assert.equal(
    f.state.calls.some((args) => args[0] === "release"),
    false
  );
  assert.equal(JSON.parse(Buffer.from(f.state.pointer.content, "base64")).version, version);
});

test("resume-pointer is an idempotent success after a saved-pointer response was lost", async (t) => {
  const f = await fixture(t);
  await publishPublicRelease(f.options);
  const saved = structuredClone(f.state.pointer);
  f.state.calls = [];
  f.state.uploads = [];
  const result = await publishPublicRelease({ ...f.options, resumePointer: true });
  assert.equal(result.pointerUnchanged, true);
  assert.equal(result.uploaded, 0);
  assert.deepEqual(f.state.pointer, saved);
  assert.equal(
    f.state.calls.some((args) => args[0] === "release" || args[1] === "--method"),
    false
  );
});

test("resume-pointer refuses same-version pointer differences and corrupt published assets", async (t) => {
  const f = await fixture(t);
  await publishPublicRelease(f.options);
  const feed = JSON.parse(Buffer.from(f.state.pointer.content, "base64"));
  feed.artifacts[0].sha256 = "f".repeat(64);
  f.state.pointer = pointer(feed);
  f.state.calls = [];
  await assert.rejects(
    publishPublicRelease({ ...f.options, resumePointer: true }),
    /same public version.*different/
  );
  assert.equal(
    f.state.calls.some((args) => args[0] === "release" || args[1] === "--method"),
    false
  );
  f.state.pointer = pointer(publicFeed("1.0.0"));
  f.state.release.assets[0].digest = "sha256:" + "f".repeat(64);
  await assert.rejects(publishPublicRelease({ ...f.options, resumePointer: true }), /digest/);
});

test("publisher discovers draft identity through listings and never calls the draft-invisible tag endpoint", async (t) => {
  const f = await fixture(t);
  f.state.release = { id: 42, tag_name: tag, draft: true, assets: [] };
  await publishPublicRelease(f.options);
  assert.ok(f.state.calls.some((args) => args[1] === "--paginate"));
  assert.ok(f.state.calls.some((args) => args[1] === `repos/${repository}/releases/42`));
  assert.equal(
    f.state.calls.some((args) => args.some((value) => value.includes("/releases/tags/"))),
    false
  );
});

test("an existing draft published by another maintainer cannot be overwritten", async (t) => {
  const f = await fixture(t);
  f.state.release = { id: 42, tag_name: tag, draft: true, assets: [] };
  f.state.onReadRelease = () => {
    if (f.state.reads === 2) f.state.release.draft = false;
  };
  await assert.rejects(publishPublicRelease(f.options), /published while preparing/);
  assert.equal(f.state.uploads.length, 0);
});

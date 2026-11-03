import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { releaseMetadata, validateRelease } from "../scripts/release-metadata.mjs";

const script = fileURLToPath(new URL("../scripts/release-metadata.mjs", import.meta.url));

test("release metadata names versioned artifacts and requires matching package, lock and tag versions", () => {
  assert.deepEqual(releaseMetadata("1.2.3", "1.2.3", "v1.2.3"), {
    version: "1.2.3",
    tag: "v1.2.3",
    prerelease: false,
    dmg: "release/CoworkOS-1.2.3-mac-arm64.dmg",
    checksum: "release/CoworkOS-1.2.3-mac-arm64.dmg.sha256"
  });
  for (const version of [
    "0.0.0",
    "1.2.3-rc.1",
    "1.2.3-0",
    "1.2.3-01a",
    "1.2.3+01",
    "1.2.3+build.42",
    "1.2.3-rc.1+build.42"
  ]) {
    const metadata = releaseMetadata(version, version, `v${version}`);
    assert.equal(metadata.version, version);
    assert.equal(metadata.prerelease, version.split("+")[0].includes("-"));
  }
  for (const lockVersion of [undefined, null, 123, "1.2.4"])
    assert.throws(() => releaseMetadata("1.2.3", lockVersion, "v1.2.3"), /versions differ/);
  for (const tag of [undefined, "1.2.3", "v1.2.4", "refs/tags/v1.2.3", "v1.2.3\noutput=injected"])
    assert.throws(() => releaseMetadata("1.2.3", "1.2.3", tag), /Release tag must be/);
});

test("release version rejects malformed input, path traversal, shell syntax and output injection", () => {
  for (const version of [
    undefined,
    null,
    123,
    "",
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-..",
    "1.2.3-01",
    "1.2.3-rc..1",
    "1.2.3-rc.01",
    "1.2.3+.x",
    "1.2.3+build.",
    "1.2.3+build..42",
    "../1.2.3",
    "1.2.3/../../private",
    "1.2.3\\private",
    "1.2.3;touch fixture",
    "1.2.3$(touch fixture)",
    "1.2.3`touch fixture`",
    "1.2.3\noutput=injected",
    "1.2.3\routput=injected",
    "1.2.3\0",
    " 1.2.3",
    "1.2.3 "
  ])
    assert.throws(() => releaseMetadata(version, version, `v${version}`), /Package version/);
});

async function gitFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "atria-release-metadata-"));
  try {
    const config = join(root, "empty-gitconfig");
    await writeFile(config, "");
    await mkdir(join(root, "empty-hooks"));
    await mkdir(join(root, "empty-template"));
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^GIT_|^GITHUB_OUTPUT$|^RELEASE_TAG$/.test(key))
      ),
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Release Fixture",
      GIT_AUTHOR_EMAIL: "release-fixture@example.invalid",
      GIT_COMMITTER_NAME: "Release Fixture",
      GIT_COMMITTER_EMAIL: "release-fixture@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
    };
    const git = (args) =>
      execFileSync(
        "git",
        [
          "-c",
          `core.hooksPath=${join(root, "empty-hooks")}`,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          ...args
        ],
        { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "release-fixture", version: "1.2.3" })
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "release-fixture",
        version: "1.2.3",
        lockfileVersion: 3,
        packages: { "": { name: "release-fixture", version: "1.2.3" } }
      })
    );
    await writeFile(
      join(root, ".gitignore"),
      "empty-gitconfig\nempty-hooks/\nempty-template/\naction-output.txt\nrelease/\n"
    );
    git(["init", `--template=${join(root, "empty-template")}`]);
    git(["add", "package.json", "package-lock.json", ".gitignore"]);
    git(["commit", "-m", "Fixture release"]);
    git(["tag", "--no-sign", "v1.2.3"]);
    await callback({ root, env, git });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("release validation resolves lightweight/annotated tags and rejects a checkout at another commit", async () => {
  await gitFixture(async ({ root, git }) => {
    const commit = git(["rev-parse", "HEAD"]);
    const metadata = await validateRelease(root, "v1.2.3");
    assert.equal(metadata.commit, commit);
    assert.equal(metadata.tag, "v1.2.3");
    git(["tag", "--delete", "v1.2.3"]);
    git(["tag", "--no-sign", "--annotate", "--message", "Annotated fixture release", "v1.2.3"]);
    assert.equal((await validateRelease(root, "v1.2.3")).commit, commit);
    await writeFile(join(root, "different-revision.txt"), "another commit\n");
    git(["add", "different-revision.txt"]);
    git(["commit", "-m", "Another fixture revision"]);
    assert.notEqual(git(["rev-parse", "HEAD"]), commit);
    await assert.rejects(validateRelease(root, "v1.2.3"), /Checked-out commit differs/);
  });
});

test("release validation refuses missing/stale lock root metadata and malformed lock JSON", async () => {
  await gitFixture(async ({ root }) => {
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8"));
    for (const packages of [undefined, null, {}, { "": {} }, { "": { version: "1.2.4" } }]) {
      await writeFile(lockPath, JSON.stringify({ ...lock, packages }));
      await assert.rejects(validateRelease(root, "v1.2.3"), /root package version differs/);
    }
    await writeFile(lockPath, JSON.stringify({ ...lock, version: "1.2.4" }));
    await assert.rejects(validateRelease(root, "v1.2.3"), /versions differ/);
    await writeFile(lockPath, "{ incomplete lock JSON");
    await assert.rejects(validateRelease(root, "v1.2.3"), SyntaxError);
    await writeFile(lockPath, JSON.stringify(lock));
    assert.equal((await validateRelease(root, "v1.2.3")).version, "1.2.3");
  });
});

test("release CLI appends action metadata only after validation and also works without GITHUB_OUTPUT", async () => {
  await gitFixture(async ({ root, env, git }) => {
    const commit = git(["rev-parse", "HEAD"]);
    const output = join(root, "action-output.txt");
    await writeFile(output, "existing=preserved\n");
    const run = (extra) =>
      spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...env, RELEASE_TAG: "v1.2.3", ...extra },
        encoding: "utf8",
        timeout: 10000
      });
    const result = run({ GITHUB_OUTPUT: output });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`Release v1\\.2\\.3 from ${commit}: release/CoworkOS-1\\.2\\.3-mac-arm64\\.dmg`)
    );
    const contents = await readFile(output, "utf8");
    assert.ok(contents.endsWith("\n"));
    const values = Object.fromEntries(
      contents
        .trimEnd()
        .split("\n")
        .map((line) => line.split("="))
    );
    assert.deepEqual(values, {
      existing: "preserved",
      tag: "v1.2.3",
      version: "1.2.3",
      prerelease: "false",
      dmg: "release/CoworkOS-1.2.3-mac-arm64.dmg",
      checksum: "release/CoworkOS-1.2.3-mac-arm64.dmg.sha256",
      commit
    });
    const rejected = run({ RELEASE_TAG: "v1.2.4", GITHUB_OUTPUT: output });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Release tag must be v1\.2\.3/);
    assert.equal(await readFile(output, "utf8"), contents);
    const withoutOutput = run({});
    assert.equal(withoutOutput.status, 0, withoutOutput.stderr);
    assert.match(withoutOutput.stdout, /Release v1\.2\.3/);
    assert.equal(await readFile(output, "utf8"), contents);
  });
});

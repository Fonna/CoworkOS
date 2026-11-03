import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  checkRelease,
  cliInstallPrefix,
  compareUpdateVersions,
  downloadRelease,
  installCliRelease,
  releaseAssetUrl,
  updateRepository
} from "../scripts/update-release.mjs";

const execute = promisify(execFile);
const repository = "example/atria";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function release(
  version,
  { draft = false, prerelease = false, kind = "cli", bytes = Buffer.from("archive") } = {}
) {
  const name = kind === "cli" ? `coworkos-cli-${version}.tgz` : `CoworkOS-${version}-mac-arm64.dmg`;
  const asset = (name) => ({
    name,
    browser_download_url: releaseAssetUrl(repository, `v${version}`, name),
    size: bytes.length
  });
  return { tag_name: `v${version}`, draft, prerelease, assets: [asset(name), asset(`${name}.sha256`)] };
}
async function fixture(t, version = "0.1.0", packageName = "coworkos-cli") {
  const directory = await mkdtemp(join(tmpdir(), "atria-release-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, `prefix/lib/node_modules/${packageName}`);
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: packageName, version, repository: `https://github.com/${repository}.git` })
  );
  await writeFile(join(root, "scripts/atria.mjs"), "console.log('old program');\n");
  return { directory, root };
}
function service(releases, entries = new Map()) {
  const requested = [];
  return {
    requested,
    legacy: true,
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      if (url === `https://api.github.com/repos/${repository}/releases?per_page=100`)
        return new Response(JSON.stringify(releases));
      if (entries.has(url)) return new Response(entries.get(url));
      return new Response("not found", { status: 404 });
    }
  };
}

test("update versions obey stable/prerelease precedence and validate repository without shell input", () => {
  for (const [a, b] of [
    ["1.0.0", "1.0.0-beta.3"],
    ["1.0.0-beta.10", "1.0.0-beta.2"],
    ["1.0.0-beta", "1.0.0-1"],
    ["2.0.0", "1.9.9"]
  ]) {
    assert.equal(compareUpdateVersions(a, b), 1);
    assert.equal(compareUpdateVersions(b, a), -1);
  }
  assert.equal(compareUpdateVersions("1.0.0+one", "1.0.0+two"), 0);
  assert.equal(updateRepository({ url: "git+https://github.com/example/atria.git" }), repository);
  for (const value of ["file:///private/project", "../project", "https://github.com/user/repo?token=x"])
    assert.throws(() => updateRepository(value), /仓库/);
  assert.throws(() => compareUpdateVersions("1.0.0-01", "1.0.0"), /版本/);
});

test("release check rejects drafts, incompatible/missing/untrusted assets and supports preview without downgrades", async (t) => {
  const { root } = await fixture(t);
  const malformed = release("4.0.0");
  malformed.assets[0].browser_download_url = "https://untrusted.invalid/a.tgz";
  const incomplete = release("3.0.0");
  incomplete.assets.pop();
  const api = service([
    release("9.0.0", { draft: true }),
    malformed,
    incomplete,
    release("1.1.0-beta.2", { prerelease: true }),
    release("1.0.0"),
    release("0.2.0")
  ]);
  const stable = await checkRelease({ root, channel: "stable", ...api });
  assert.equal(stable.version, "1.0.0");
  assert.equal(stable.available, true);
  const preview = await checkRelease({ root, channel: "preview", ...api });
  assert.equal(preview.version, "1.1.0-beta.2");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "2.0.0", repository }));
  assert.equal((await checkRelease({ root, channel: "stable", ...api })).available, false);
  const none = await checkRelease({ root, ...service([]) });
  assert.equal(none.available, false);
  assert.match(none.message, /尚无/);
  await assert.rejects(checkRelease({ root, kind: "mac", arch: "x64", ...api }), /平台/);
});

test("verified download publishes only complete matching bytes and keeps prior downloads on corruption", async (t) => {
  const { root, directory } = await fixture(t);
  const bytes = Buffer.from("trusted fixture archive");
  const published = release("0.2.0", { bytes });
  const [asset, checksum] = published.assets;
  const entries = new Map([
    [asset.browser_download_url, bytes],
    [checksum.browser_download_url, `${digest(bytes)}  ${asset.name}\n`]
  ]);
  const api = service([published], entries);
  const check = await checkRelease({ root, ...api });
  const output = join(directory, "downloads");
  const progress = [];
  const path = await downloadRelease({
    check,
    directory: output,
    ...api,
    onProgress: (value) => progress.push(value)
  });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(progress.at(-1).phase, "downloaded");
  entries.set(asset.browser_download_url, Buffer.from("corrupt archive"));
  await assert.rejects(downloadRelease({ check, directory: output, ...api }), /校验失败/);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readdir(output), [asset.name]);
  entries.set(checksum.browser_download_url, `${digest(bytes)}  wrong.tgz\n`);
  await assert.rejects(downloadRelease({ check, directory: output, ...api }), /校验文件/);
});

test("untrusted asset URLs are rejected before sending authentication or installing anything", async (t) => {
  const { directory } = await fixture(t);
  const check = {
    available: true,
    repository,
    version: "1.0.0",
    asset: { name: "file.tgz", url: "https://untrusted.invalid/file.tgz" },
    checksum: { url: "https://untrusted.invalid/file.tgz.sha256" }
  };
  let requested = false;
  await assert.rejects(
    downloadRelease({
      check,
      directory,
      token: "fixture-authentication",
      fetchImpl: () => {
        requested = true;
        assert.fail("untrusted request");
      }
    }),
    /地址无效/
  );
  assert.equal(requested, false);
});

for (const packageName of ["coworkos-cli", "atria-cowork-cli"])
  for (const failInstall of [false, true])
    test(`${packageName} candidate ${failInstall ? "failure preserves" : "success replaces"} only its own installation`, async (t) => {
      const { root, directory } = await fixture(t, "0.1.0", packageName);
      const home = join(directory, "user-data");
      await mkdir(home);
      await writeFile(join(home, "config.json"), "fixture private configuration");
      const prefix = cliInstallPrefix(root);
      await mkdir(join(prefix, "bin"));
      await symlink(`../lib/node_modules/${packageName}/scripts/atria.mjs`, join(prefix, "bin/atria"));
      const archiveRoot = join(directory, "archive");
      await mkdir(join(archiveRoot, "package/scripts"), { recursive: true });
      await writeFile(
        join(archiveRoot, "package/package.json"),
        JSON.stringify({
          name: "coworkos-cli",
          version: "0.2.0",
          bin: { coworkos: "scripts/atria.mjs", atria: "scripts/atria.mjs" }
        })
      );
      await writeFile(join(archiveRoot, "package/scripts/atria.mjs"), "console.log('CoworkOS 0.2.0');\n");
      const tgz = join(directory, "fixture.tgz");
      await execute("tar", ["-czf", tgz, "-C", archiveRoot, "package"]);
      const bytes = await readFile(tgz),
        published = release("0.2.0", { bytes });
      const [asset, checksum] = published.assets;
      const api = service(
        [published],
        new Map([
          [asset.browser_download_url, bytes],
          [checksum.browser_download_url, `${digest(bytes)}  ${asset.name}\n`]
        ])
      );
      let installation;
      const commandRunner = async (command, args, options) => {
        if (command === "npm") {
          assert.equal(JSON.parse(await readFile(join(root, "package.json"))).version, "0.1.0");
          installation = args[args.indexOf("--prefix") + 1];
          assert.notEqual(installation, prefix);
          const candidate = join(installation, "lib/node_modules/coworkos-cli");
          await mkdir(dirname(candidate), { recursive: true });
          await cp(join(archiveRoot, "package"), candidate, { recursive: true });
          if (failInstall) throw new Error("fixture npm failure");
          return { stdout: "" };
        }
        return execute(command, args, options);
      };
      const work = installCliRelease({ root, ...api, commandRunner });
      if (failInstall) await assert.rejects(work, /安装失败/);
      else assert.equal((await work).updated, true);
      assert.ok(installation);
      assert.equal(
        JSON.parse(await readFile(join(root, "package.json"))).version,
        failInstall ? "0.1.0" : "0.2.0"
      );
      assert.equal(await readFile(join(home, "config.json"), "utf8"), "fixture private configuration");
      assert.deepEqual(await readdir(dirname(root)), [packageName]);
      if (!failInstall) {
        assert.equal(
          (await execute(process.execPath, [join(prefix, "bin/coworkos")])).stdout.trim(),
          "CoworkOS 0.2.0"
        );
        assert.equal(
          (await execute(process.execPath, [join(prefix, "bin/atria")])).stdout.trim(),
          "CoworkOS 0.2.0"
        );
      }
    });

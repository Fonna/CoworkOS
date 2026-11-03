import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { packageDesktopNpm } from "../scripts/package-desktop-npm.mjs";
import {
  downloadNpmDesktopRelease,
  NPM_DESKTOP_PACKAGE,
  NPM_REGISTRY
} from "../scripts/update-npm-desktop.mjs";

const execute = promisify(execFile);

test("a real npm pack desktop archive round-trips through the npm updater", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coworkos-npm-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = "0.1.0";
  const bytes = Buffer.from("small but valid desktop archive fixture");
  const release = join(root, "release");
  const output = join(root, "output");
  await mkdir(release);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      version,
      repository: { type: "git", url: "https://github.com/fixture/coworkos.git" }
    })
  );
  await writeFile(join(root, "LICENSE"), "MIT fixture\n");
  const dmgName = `CoworkOS-${version}-mac-arm64.dmg`;
  await writeFile(join(release, dmgName), bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(release, `${dmgName}.sha256`), `${sha256}  ${dmgName}\n`);

  let npmPack;
  const packed = await packageDesktopNpm({
    root,
    outputDirectory: output,
    async commandRunner(command, args, options) {
      const result = await execute(command, args, options);
      if (command === "npm" && args[0] === "pack") npmPack = JSON.parse(result.stdout)[0];
      return result;
    }
  });

  assert.equal(packed.version, version);
  assert.equal(npmPack.unpackedSize >= bytes.length, true);
  assert.equal(npmPack.unpackedSize <= bytes.length + 1024 * 1024, true);
  const tarball = await readFile(packed.archive);
  const check = {
    available: true,
    source: "npm-registry",
    package: NPM_DESKTOP_PACKAGE,
    tag: "latest",
    version,
    manifest: packed.manifest,
    tarball: {
      url: `${NPM_REGISTRY}/${NPM_DESKTOP_PACKAGE}/-/${NPM_DESKTOP_PACKAGE}-${version}.tgz`,
      integrity: packed.integrity
    }
  };
  const destination = join(root, "download");
  const extracted = await downloadNpmDesktopRelease({
    check,
    directory: destination,
    async fetchImpl(url) {
      assert.equal(url, check.tarball.url);
      return new Response(tarball);
    }
  });
  assert.deepEqual(await readFile(extracted), bytes);
  assert.deepEqual(await readdir(destination), [dmgName]);
  await writeFile(join(release, `${dmgName}.sha256`), `${"0".repeat(64)}  ${dmgName}\n`);
  await assert.rejects(packageDesktopNpm({ root, outputDirectory: join(root, "invalid-output") }), /SHA-256/);
});

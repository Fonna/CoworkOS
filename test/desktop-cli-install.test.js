import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { installDesktop, parseDesktopOptions, runDesktop } from "../scripts/desktop.mjs";
import {
  PUBLIC_RELEASE_REPOSITORY,
  PUBLIC_UPDATE_FEED_URL,
  releaseAssetUrl
} from "../scripts/update-release.mjs";
import { NPM_DESKTOP_PACKAGE } from "../scripts/update-npm-desktop.mjs";

const execute = promisify(execFile);
const version = "1.2.3";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function createApp(path, metadata = {}) {
  await mkdir(join(path, "Contents/MacOS"), { recursive: true });
  await mkdir(join(path, "Contents/Resources/app"), { recursive: true });
  await writeFile(join(path, "Contents/MacOS/CoworkOS"), "fixture Mach-O");
  await writeFile(join(path, "Contents/Resources/app/package.json"), JSON.stringify({ version }));
  await writeFile(
    join(path, "Contents/Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: "org.atria.cowork",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      CFBundleExecutable: "CoworkOS",
      ...metadata
    })
  );
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coworkos-desktop-install-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  const directory = join(root, "Applications");
  const target = join(directory, "CoworkOS.app");
  const source = join(root, "source/CoworkOS.app");
  await createApp(source);
  const bytes = Buffer.from("verified fixture DMG");
  const name = `CoworkOS-${version}-mac-arm64.dmg`;
  const checksum = `${hash(bytes)}  ${name}\n`;
  const files = new Map([
    [name, bytes],
    [`${name}.sha256`, Buffer.from(checksum)],
    [`coworkos-cli-${version}.tgz`, Buffer.from("fixture CLI")],
    [`coworkos-cli-${version}.tgz.sha256`, Buffer.from("fixture CLI checksum")]
  ]);
  const feed = {
    schemaVersion: 1,
    repository: PUBLIC_RELEASE_REPOSITORY,
    version,
    publishedAt: "2026-10-01T00:00:00.000Z",
    releaseUrl: `https://github.com/${PUBLIC_RELEASE_REPOSITORY}/releases/tag/v${version}`,
    artifacts: [...files].map(([file, body]) => ({
      name: file,
      size: body.length,
      sha256: hash(body),
      url: releaseAssetUrl(PUBLIC_RELEASE_REPOSITORY, `v${version}`, file)
    }))
  };
  const calls = [],
    requests = [];
  const fetchImpl = async (url, options) => {
    options.signal?.throwIfAborted();
    requests.push({ url, headers: options.headers });
    if (url === PUBLIC_UPDATE_FEED_URL) return new Response(JSON.stringify(feed));
    const file = feed.artifacts.find((artifact) => artifact.url === url)?.name;
    assert.ok(files.has(file), `unexpected request ${url}`);
    return new Response(files.get(file));
  };
  const runner = async (command, args, options = {}) => {
    options.signal?.throwIfAborted();
    calls.push({ command, args, options });
    if (command.endsWith("PlistBuddy"))
      return { stdout: String(JSON.parse(await readFile(args.at(-1), "utf8"))[args[1].slice(7)]) };
    if (command.endsWith("lipo")) return { stdout: "arm64" };
    if (command.endsWith("codesign")) {
      await access(join(args.at(-1), "Contents/MacOS/CoworkOS"));
      return { stdout: "" };
    }
    if (command.endsWith("hdiutil")) {
      if (args[0] === "attach")
        await cp(source, join(args[args.indexOf("-mountpoint") + 1], "CoworkOS.app"), {
          recursive: true,
          verbatimSymlinks: true
        });
      return { stdout: "" };
    }
    if (command.endsWith("ditto")) {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      return { stdout: "" };
    }
    throw new Error(`Unexpected command ${command}`);
  };
  const options = {
    root,
    directory,
    platform: "darwin",
    arch: "arm64",
    systemRelease: "23.0.0",
    fetchImpl,
    runner,
    check: async () => ({
      mode: "release",
      source: "npm-registry",
      package: NPM_DESKTOP_PACKAGE,
      tag: "latest",
      currentVersion: version,
      version,
      available: false,
      manifest: {
        schemaVersion: 1,
        appVersion: version,
        platform: "darwin",
        arch: "arm64",
        artifact: { name, size: bytes.length, sha256: hash(bytes) }
      },
      asset: { name, size: bytes.length, sha256: hash(bytes) },
      tarball: {
        url: "https://registry.npmjs.org/coworkos-desktop-darwin-arm64/-/fixture.tgz",
        integrity: "sha512-" + "A".repeat(88)
      }
    }),
    download: async ({ check, directory: targetDirectory }) => {
      assert.equal(check.source, "npm-registry");
      const downloaded = files.get(name);
      if (hash(downloaded) !== check.manifest.artifact.sha256) throw new Error("npm 桌面包中的 DMG 校验失败");
      await mkdir(targetDirectory, { recursive: true });
      const path = join(targetDirectory, name);
      await writeFile(path, downloaded);
      return path;
    }
  };
  return { root, directory, target, source, files, feed, name, calls, requests, runner, options };
}

test("desktop help and invalid arguments do not access the network or create user data", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coworkos-desktop-help-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const args of [
    ["desktop", "--help"],
    ["desktop", "install", "--help"],
    ["help", "desktop"]
  ]) {
    const result = await execute(process.execPath, [resolve("scripts/atria.mjs"), ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        ATRIA_HOME: join(root, "data"),
        COWORK_CONFIG: join(root, "missing-config.json")
      }
    });
    assert.match(result.stdout, /coworkos desktop install/);
    assert.match(result.stdout, /macOS 14/);
    assert.equal(result.stderr, "");
  }
  await runDesktop({
    args: ["install", "--help"],
    root,
    directory: join(root, "Applications"),
    check: () => assert.fail("help must not check"),
    onProgress: () => {}
  });
  assert.deepEqual(await readdir(root), []);
  for (const args of [
    ["remove"],
    ["install", "--force"],
    ["install", "--directory", "relative"],
    ["install", "--directory"],
    ["install", "--directory", root, "--directory", root]
  ])
    assert.throws(() => parseDesktopOptions(args));
});

test("desktop installation verifies a same-version release and publishes one App without user data", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.source, "Contents/Frameworks/Test.framework/Versions/A"), { recursive: true });
  await symlink("A", join(f.source, "Contents/Frameworks/Test.framework/Versions/Current"));
  const messages = [];
  const result = await installDesktop({ ...f.options, onProgress: (message) => messages.push(message) });
  assert.deepEqual(result, { target: f.target, version });
  assert.equal(
    JSON.parse(await readFile(join(f.target, "Contents/Resources/app/package.json"))).version,
    version
  );
  assert.ok(
    (await lstat(join(f.target, "Contents/Frameworks/Test.framework/Versions/Current"))).isSymbolicLink()
  );
  assert.deepEqual(await readdir(f.directory), ["CoworkOS.app"]);
  assert.ok(f.calls.some(({ command, args }) => command.endsWith("hdiutil") && args.includes("-readonly")));
  assert.equal(f.calls.filter(({ command }) => command.endsWith("codesign")).length, 2);
  assert.equal(f.requests.length, 0, "the test injects its npm package transport");
  assert.ok(f.requests.every(({ headers }) => !headers.Authorization));
  assert.ok(messages.at(-1).includes("Settings"));
});

test("unsupported platforms and macOS versions fail before network or filesystem writes", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { platform: "linux" },
    { platform: "win32" },
    { arch: "x64" },
    { systemRelease: "22.6.0" },
    { systemRelease: "unknown" }
  ])
    await assert.rejects(installDesktop({ ...f.options, ...overrides }), /Apple Silicon|macOS 14/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(access(f.directory), { code: "ENOENT" });
});

test("an existing App or symlink is never replaced and is rejected before download", async (t) => {
  for (const kind of ["directory", "symlink"]) {
    const f = await fixture(t);
    await mkdir(f.directory);
    if (kind === "directory") await mkdir(f.target);
    else await symlink(f.source, f.target);
    await assert.rejects(installDesktop(f.options), /already installed/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await readdir(f.directory), ["CoworkOS.app"]);
    assert.equal((await lstat(f.target)).isSymbolicLink(), kind === "symlink");
  }
});

test("a symlink Applications directory is rejected without altering its contents", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "other"));
  await symlink(join(f.root, "other"), f.directory);
  await assert.rejects(installDesktop(f.options), /symbolic link/);
  assert.deepEqual(await readdir(join(f.root, "other")), []);
  assert.equal(f.requests.length, 0);
});

test("tampered downloads fail before mounting and remove only the installation's staging files", async (t) => {
  const f = await fixture(t);
  f.files.set(f.name, Buffer.from("changed image"));
  await assert.rejects(installDesktop(f.options), /校验失败/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.directory), []);
});

test("wrong App identity, version, architecture, external links and signature never install", async (t) => {
  for (const kind of ["identity", "version", "arch", "links", "signature"]) {
    const f = await fixture(t);
    if (kind === "identity") await createApp(f.source, { CFBundleIdentifier: "org.other.app" });
    if (kind === "version") await createApp(f.source, { CFBundleVersion: "1.2.4" });
    if (kind === "links") await symlink(f.root, join(f.source, "external"));
    const runner = async (command, args, options) => {
      if (kind === "arch" && command.endsWith("lipo")) return { stdout: "x86_64" };
      if (kind === "signature" && command.endsWith("codesign")) throw new Error("Invalid signature");
      return f.runner(command, args, options);
    };
    await assert.rejects(installDesktop({ ...f.options, runner }), /标识|处理器|符号链接|signature/);
    assert.deepEqual(await readdir(f.directory), []);
    assert.ok(f.calls.some(({ command, args }) => command.endsWith("hdiutil") && args[0] === "detach"));
  }
});

test("a competing installation cannot fetch or change the active install", async (t) => {
  const f = await fixture(t);
  let releaseCheck, checked;
  const entered = new Promise((done) => {
    checked = done;
  });
  const pending = new Promise((done) => {
    releaseCheck = done;
  });
  const installation = installDesktop({
    ...f.options,
    check: async (options) => {
      checked();
      await pending;
      return f.options.check(options);
    }
  });
  await entered;
  await assert.rejects(installDesktop(f.options), /Another desktop installation/);
  assert.equal(f.requests.length, 0);
  releaseCheck();
  await installation;
  assert.deepEqual(await readdir(f.directory), ["CoworkOS.app"]);
});

test("cancellation unmounts without an aborted signal and leaves no installed App", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const runner = async (command, args, options) => {
    if (command.endsWith("ditto")) controller.abort(new Error("fixture cancelled"));
    return f.runner(command, args, options);
  };
  await assert.rejects(installDesktop({ ...f.options, runner, signal: controller.signal }), /cancelled/);
  const detach = f.calls.find(({ command, args }) => command.endsWith("hdiutil") && args[0] === "detach");
  assert.ok(detach);
  assert.equal(detach.options.signal, undefined);
  assert.deepEqual(await readdir(f.directory), []);
});

test("failure to unmount retains the staging directory and lock without installing", async (t) => {
  const f = await fixture(t);
  const runner = async (command, args, options) => {
    if (command.endsWith("hdiutil") && args[0] === "detach") throw new Error("volume busy");
    return f.runner(command, args, options);
  };
  await assert.rejects(installDesktop({ ...f.options, runner }), /Temporary files retained/);
  const files = await readdir(f.directory);
  assert.ok(files.includes(".coworkos-desktop-install.lock"));
  assert.ok(files.some((name) => name.startsWith(".coworkos-install-")));
  assert.ok(!files.includes("CoworkOS.app"));
});

test("an image that fails to mount keeps the original error and permits a fresh retry", async (t) => {
  const f = await fixture(t);
  const runner = async (command, args, options) => {
    if (command.endsWith("hdiutil") && args[0] === "attach")
      throw new Error("fixture image could not be mounted");
    if (command.endsWith("hdiutil") && args[0] === "detach")
      assert.fail("an unmounted directory must not be detached");
    return f.runner(command, args, options);
  };
  await assert.rejects(installDesktop({ ...f.options, runner }), /fixture image could not be mounted/);
  assert.deepEqual(await readdir(f.directory), []);
  await installDesktop(f.options);
  assert.deepEqual(await readdir(f.directory), ["CoworkOS.app"]);
});

test("a destination created during copying is preserved instead of being replaced", async (t) => {
  const f = await fixture(t);
  const runner = async (command, args, options) => {
    const result = await f.runner(command, args, options);
    if (command.endsWith("ditto")) {
      await mkdir(f.target);
      await writeFile(join(f.target, "keep.txt"), "do not replace");
    }
    return result;
  };
  await assert.rejects(installDesktop({ ...f.options, runner }), /already installed/);
  assert.equal(await readFile(join(f.target, "keep.txt"), "utf8"), "do not replace");
  assert.deepEqual(await readdir(f.directory), ["CoworkOS.app"]);
});

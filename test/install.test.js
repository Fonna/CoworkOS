import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import {
  PUBLIC_RELEASE_REPOSITORY,
  releaseAssetUrl,
  validatePublicReleaseFeed
} from "../scripts/update-release.mjs";

const installer = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function executable(name) {
  for (const directory of process.env.PATH.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`${name} is required for isolated installer integration tests`);
}
const npm = await executable("npm");

async function fixture(t, { shell = "/bin/zsh", legacy = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "profiles");
  const prefix = join(root, "prefix with space's");
  const commands = join(root, "commands");
  const npmLog = join(root, "npm.jsonl");
  const installed = join(root, "installed");
  await mkdir(profiles);
  await mkdir(commands);
  await writeFile(join(profiles, ".zshrc"), "# Existing shell configuration\n");
  const version = "1.2.3-beta.4";
  const name = `${legacy ? "atria-cowork-cli" : "coworkos-cli"}-${version}.tgz`;
  const stage = join(root, "stage");
  await mkdir(join(stage, "package"), { recursive: true });
  await writeFile(
    join(stage, "package", "package.json"),
    JSON.stringify({
      name: "atria-cowork-cli",
      version,
      bin: legacy ? { atria: "atria.cjs" } : { atria: "atria.cjs", coworkos: "atria.cjs" },
      scripts: { postinstall: "node install.cjs" }
    })
  );
  await writeFile(
    join(stage, "package", "atria.cjs"),
    `#!/usr/bin/env node\nconsole.log("CoworkOS ${version}");\n`
  );
  await chmod(join(stage, "package", "atria.cjs"), 0o755);
  await writeFile(
    join(stage, "package", "install.cjs"),
    'require("node:fs").writeFileSync(process.env.INSTALL_MARKER, "installed");\n'
  );
  const archive = join(root, name);
  execFileSync("tar", ["-czf", archive, "-C", stage, "package"]);
  const bytes = await readFile(archive);
  const entries = new Map();
  const feed = {
    schemaVersion: 1,
    repository: PUBLIC_RELEASE_REPOSITORY,
    version,
    publishedAt: "2026-10-28T00:00:00.000Z",
    releaseUrl: `https://github.com/${PUBLIC_RELEASE_REPOSITORY}/releases/tag/v${version}`,
    artifacts: []
  };
  for (const [artifact, content] of [
    [`${legacy ? "Atria" : "CoworkOS"}-${version}-mac-arm64.dmg`, Buffer.from("fixture DMG")],
    [name, bytes]
  ]) {
    for (const [file, data] of [
      [artifact, content],
      [`${artifact}.sha256`, Buffer.from(`${hash(content)}  ${artifact}\n`)]
    ]) {
      const url = releaseAssetUrl(PUBLIC_RELEASE_REPOSITORY, `v${version}`, file);
      entries.set(new URL(url).pathname, data);
      feed.artifacts.push({ name: file, size: data.length, sha256: hash(data), url });
    }
  }
  validatePublicReleaseFeed(feed);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const content =
      request.url === "/latest.json" ? Buffer.from(JSON.stringify(feed)) : entries.get(request.url);
    response.writeHead(content ? 200 : 404, { "Content-Length": content?.length ?? 0 });
    response.end(content);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(
    join(commands, "npm"),
    `#!${process.execPath}\n` +
      'const fs = require("node:fs");\n' +
      'fs.appendFileSync(process.env.INSTALL_NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
      `const result = require("node:child_process").spawnSync(${JSON.stringify(npm)}, process.argv.slice(2), {stdio:"inherit", env:process.env});\n` +
      "process.exit(result.status ?? 1);\n"
  );
  await chmod(join(commands, "npm"), 0o755);
  const env = {
    PATH: [commands, dirname(process.execPath), dirname(npm), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      delimiter
    ),
    SHELL: shell,
    TMPDIR: root,
    ATRIA_INSTALL_PREFIX: prefix,
    ATRIA_INSTALL_PROFILE: join(profiles, ".zshrc"),
    ATRIA_INSTALL_FEED_URL: `${origin}/latest.json`,
    ATRIA_INSTALL_RELEASE_BASE_URL: `${origin}/ignorejjj/Atria-Releases/releases/download`,
    INSTALL_NPM_LOG: npmLog,
    INSTALL_MARKER: installed,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_userconfig: join(root, "npmrc"),
    npm_config_globalconfig: join(root, "global-npmrc"),
    npm_config_registry: `${origin}/unexpected-registry`,
    npm_config_update_notifier: "false",
    // The explicit install flag must restore required lifecycle scripts.
    npm_config_ignore_scripts: "true"
  };
  async function run(overrides = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", [], { cwd: root, env: { ...env, ...overrides }, stdio: "pipe" });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
      child.stdin.on("error", () => {});
      // Feed the source on stdin, matching curl | bash rather than a script file.
      child.stdin.end(installer);
    });
  }
  async function calls() {
    try {
      return (await readFile(npmLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  return { root, profiles, prefix, commands, feed, entries, requests, name, bytes, run, calls, installed };
}

test("piped installer verifies a fixed public release and really installs into an isolated user prefix", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CoworkOS 1\.2\.3-beta\.4/);
  assert.match(result.output, /coworkos init/);
  assert.equal(await readFile(f.installed, "utf8"), "installed");
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 7), [
    "install",
    "--global",
    "--prefix",
    f.prefix,
    "--omit=dev",
    "--ignore-scripts=false",
    "--no-audit"
  ]);
  const rc = await readFile(join(f.profiles, ".zshrc"), "utf8");
  assert.ok(rc.startsWith("# Existing shell configuration\n"));
  const path = execFileSync(
    "/bin/bash",
    ["-c", '. "$1"; command -v atria', "--", join(f.profiles, ".zshrc")],
    {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8"
    }
  ).trim();
  assert.equal(path, join(f.prefix, "bin", "atria"));
  assert.deepEqual(f.requests, [
    "/latest.json",
    ...f.feed.artifacts
      .filter((item) => item.name.startsWith("coworkos-cli-"))
      .map((item) => new URL(item.url).pathname)
  ]);
});

test("explicit PATH profile preserves existing contents and repeated installation adds no duplicate lines", async (t) => {
  const f = await fixture(t, { shell: "/bin/bash" });
  const profile = join(f.profiles, ".bash_profile");
  await writeFile(profile, "# Existing login profile\n");
  for (let index = 0; index < 2; index++) {
    const result = await f.run({ ATRIA_INSTALL_PROFILE: profile });
    assert.equal(result.code, 0, result.output);
  }
  const rc = await readFile(profile, "utf8");
  assert.equal(rc.split("# CoworkOS CLI").length, 2);
  assert.ok(rc.startsWith("# Existing login profile\n"));
  assert.equal(await readFile(join(f.profiles, ".zshrc"), "utf8"), "# Existing shell configuration\n");
});

test("changed archive bytes cannot reach npm or shell configuration", async (t) => {
  const f = await fixture(t);
  const item = f.feed.artifacts.find((entry) => entry.name === f.name);
  f.entries.set(new URL(item.url).pathname, Buffer.alloc(f.bytes.length, 120));
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /SHA-256 mismatch/);
  assert.deepEqual(await f.calls(), []);
  assert.equal(await readFile(join(f.profiles, ".zshrc"), "utf8"), "# Existing shell configuration\n");
  await assert.rejects(access(f.prefix), { code: "ENOENT" });
});

test("independent checksum disagreement is rejected even when its feed hash matches", async (t) => {
  const f = await fixture(t);
  const item = f.feed.artifacts.find((entry) => entry.name === `${f.name}.sha256`);
  const wrong = Buffer.from(`${"a".repeat(64)}  ${f.name}\n`);
  item.sha256 = hash(wrong);
  item.size = wrong.length;
  f.entries.set(new URL(item.url).pathname, wrong);
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /checksum file mismatch/);
  assert.deepEqual(await f.calls(), []);
});

test("failed downloads stop before npm", async (t) => {
  const f = await fixture(t);
  f.entries.delete(new URL(f.feed.artifacts.find((item) => item.name === f.name).url).pathname);
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Download failed/);
  assert.deepEqual(await f.calls(), []);
});

test("malformed versions and foreign release URLs stop before fetching an archive", async (t) => {
  for (const mutate of [
    (feed) => {
      feed.version = "1.2.3-01";
    },
    (feed) => {
      feed.artifacts[2].url = "https://example.com/foreign.tgz";
    }
  ]) {
    await t.test(mutate.toString(), async (t) => {
      const f = await fixture(t);
      mutate(f.feed);
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /Invalid CoworkOS public release feed/);
      assert.deepEqual(f.requests, ["/latest.json"]);
      assert.deepEqual(await f.calls(), []);
    });
  }
});

test("unsupported Node gives actionable prerequisites without downloading or installing", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.commands, "node"), "#!/bin/sh\nexit 1\n");
  await chmod(join(f.commands, "node"), 0o755);
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Node\.js >=22\.19\.0 is required/);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await f.calls(), []);
});

test("installing a historical package also exposes the CoworkOS command without losing the old alias", async (t) => {
  const f = await fixture(t, { legacy: true });
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  for (const name of ["atria", "coworkos"]) {
    const output = execFileSync(join(f.prefix, "bin", name), ["--version"], {
      env: { PATH: process.env.PATH },
      encoding: "utf8"
    });
    assert.equal(output.trim(), "CoworkOS 1.2.3-beta.4");
  }
});

test("new branded archives replace the legacy global package without npm command ownership conflicts", async (t) => {
  const old = await fixture(t, { legacy: true });
  const first = await old.run();
  assert.equal(first.code, 0, first.output);
  const current = await fixture(t);
  const upgraded = await current.run({ ATRIA_INSTALL_PREFIX: old.prefix });
  assert.equal(upgraded.code, 0, upgraded.output);
  for (const name of ["atria", "coworkos"]) {
    const output = execFileSync(join(old.prefix, "bin", name), ["--version"], {
      env: { PATH: process.env.PATH },
      encoding: "utf8"
    });
    assert.equal(output.trim(), "CoworkOS 1.2.3-beta.4");
  }
});

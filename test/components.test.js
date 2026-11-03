import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { createComponentService, validateArtifact } from "../dist/src/software/components/service.js";
import { autoInstallComponentsEnabled } from "../dist/src/software/components/paths.js";
async function fixture(t, privateRelease = false) {
  const root = await mkdtemp(join(tmpdir(), "atria-components-test-"));
  const home = join(root, "components"),
    source = join(root, "source");
  await mkdir(source);
  await Promise.all([
    writeFile(join(source, "index.html"), "<html>working editor</html>"),
    writeFile(join(source, "LICENSE.txt"), "AGPL-3.0"),
    writeFile(join(source, "source.tar.gz"), "source fixture")
  ]);
  const archive = join(root, "editor.tar.gz");
  async function pack() {
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    return readFile(archive);
  }
  let bytes = await pack(),
    downloads = 0,
    mode = "normal";
  let artifact = {
    apiVersion: 1,
    id: "pptist",
    version: "1",
    hostVersion: "1.0.0",
    platform: "any",
    file: "editor.tar.gz",
    downloadBytes: bytes.length,
    installedBytes: 1024,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
  const credentials = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    credentials.push(request.headers.authorization);
    const requestPath = request.url.replace(
      /^\/ignorejjj\/Atria-Components\/releases\/download\/components-v1/,
      ""
    );
    if (requestPath.includes("/releases/download/")) {
      response.writeHead(404);
      response.end();
    } else if (requestPath.includes("/tags/")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          assets: [
            { name: "atria-components-darwin-arm64.json", id: 1 },
            { name: "editor.tar.gz", id: 2 }
          ]
        })
      );
    } else if (requestPath.endsWith("/assets/1")) {
      response.writeHead(302, {
        location: "https://release-assets.githubusercontent.com/catalog.json?synthetic=signed"
      });
      response.end();
    } else if (requestPath.endsWith("/assets/2")) {
      response.writeHead(302, {
        location: "https://release-assets.githubusercontent.com/editor.tar.gz?synthetic=signed"
      });
      response.end();
    } else if (requestPath.split("?")[0].endsWith(".json")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ schemaVersion: 1, artifacts: [artifact] }));
    } else {
      downloads++;
      if (mode === "offline") {
        response.writeHead(503);
        response.end();
      } else if (mode === "broken") {
        response.writeHead(200, { "content-length": bytes.length + 100 });
        response.end(bytes.subarray(0, 10));
      } else if (mode === "slow") {
        response.writeHead(200, { "content-length": bytes.length });
        response.write(bytes.subarray(0, 1));
      } else response.end(bytes);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    legacy: async () => undefined,
    home,
    hostVersion: "1.0.0",
    platform: "darwin-arm64",
    releaseRoot: privateRelease
      ? "https://github.com/ignorejjj/Atria-Cowork/releases/download/v1.0.0"
      : `http://127.0.0.1:${server.address().port}`,
    ...(privateRelease
      ? {
          githubToken: () => "synthetic-private-token",
          fetcher: (url, init) => {
            const parsed = new URL(url);
            return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
          }
        }
      : {})
  };
  const service = createComponentService(options);
  t.after(() => service.stop());
  return {
    root,
    home,
    source,
    options,
    credentials,
    httpRoot: `http://127.0.0.1:${server.address().port}`,
    service,
    get downloads() {
      return downloads;
    },
    set mode(value) {
      mode = value;
    },
    artifact,
    async repack() {
      bytes = await pack();
      Object.assign(artifact, {
        downloadBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  };
}
test("real HTTP + tar installation is reused across services, persists across host upgrade and preserves user documents", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "license with spaces.txt"), "legitimate license metadata");
  await f.repack();
  await writeFile(join(f.root, "user-document.pptx"), "user content");
  const other = createComponentService(f.options);
  t.after(() => other.stop());
  await Promise.all([f.service.install("pptist"), f.service.install("pptist"), other.install("pptist")]);
  assert.equal(f.downloads, 1);
  assert.equal((await f.service.status("pptist")).available, true);
  const current = JSON.parse(await readFile(join(f.home, "pptist/current.json")));
  assert.equal(
    await readFile(join(f.home, "pptist/versions", current.version, "index.html"), "utf8"),
    "<html>working editor</html>"
  );
  const upgradedHost = createComponentService({ ...f.options, hostVersion: "2.0.0" });
  assert.equal((await upgradedHost.status("pptist")).available, true);
  await f.service.action("pptist", "disable");
  assert.equal((await other.status("pptist")).available, false);
  await f.service.action("pptist", "enable");
  assert.equal((await other.status("pptist")).available, true);
  await f.service.action("pptist", "uninstall");
  assert.equal((await other.status("pptist")).available, false);
  assert.equal(await readFile(join(f.root, "user-document.pptx"), "utf8"), "user content");
  assert.ok(!(await readdir(join(f.home, "pptist"))).includes("versions"));
});
test("checksum, network and incompatible upgrade failures keep the existing usable version", async (t) => {
  const f = await fixture(t);
  await f.service.install("pptist");
  const current = await readFile(join(f.home, "pptist/current.json"), "utf8");
  f.artifact.sha256 = "0".repeat(64);
  await assert.rejects(f.service.install("pptist", true), /integrity/);
  assert.equal((await f.service.status("pptist")).available, true);
  assert.equal((await f.service.status("pptist")).phase, "failed");
  assert.equal(await readFile(join(f.home, "pptist/current.json"), "utf8"), current);
  f.mode = "offline";
  await assert.rejects(f.service.install("pptist", true), /503/);
  f.artifact.hostVersion = "9.0.0";
  const downloads = f.downloads;
  await assert.rejects(f.service.install("pptist", true), /incompatible/);
  assert.equal(f.downloads, downloads);
  assert.equal((await f.service.status("pptist")).available, true);
});
test("cross-service cancel interrupts a real HTTP response, removes partials and can retry", async (t) => {
  const f = await fixture(t);
  f.mode = "slow";
  const installing = f.service.install("pptist");
  while (!f.downloads) await new Promise((resolve) => setTimeout(resolve, 10));
  const other = createComponentService(f.options);
  await other.action("pptist", "cancel");
  await assert.rejects(installing);
  assert.equal((await f.service.status("pptist")).phase, "cancelled");
  assert.ok(
    (await readdir(join(f.home, "pptist"))).every(
      (name) => !name.startsWith(".download-") && !name.startsWith(".staging-")
    )
  );
  f.mode = "normal";
  await f.service.install("pptist");
  assert.equal((await f.service.status("pptist")).available, true);
});
test("space check rejects before downloading and leaves the previous component untouched", async (t) => {
  const f = await fixture(t);
  await f.service.install("pptist");
  const service = createComponentService({ ...f.options, freeBytes: async () => 0 });
  await assert.rejects(service.install("pptist", true), /disk space/);
  assert.equal(f.downloads, 1);
  assert.equal((await service.status("pptist")).available, true);
});
test("verified archives with escaping symlinks are rejected without touching files outside staging", async (t) => {
  const f = await fixture(t);
  await symlink("../../outside", join(f.source, "escape"));
  await f.repack();
  await assert.rejects(f.service.install("pptist"), /Unsafe component archive link/);
  assert.equal((await f.service.status("pptist")).available, false);
});
test("artifact validation rejects unsafe filenames, versions, architectures and missing integrity", () => {
  const a = {
    apiVersion: 1,
    id: "cadquery",
    version: "2.6.1",
    hostVersion: "1",
    platform: "darwin-arm64",
    file: "cad.tar.gz",
    sha256: "a".repeat(64),
    downloadBytes: 1,
    installedBytes: 1
  };
  assert.equal(validateArtifact(a, "cadquery", "1", "darwin-arm64"), a);
  assert.equal(
    validateArtifact({ ...a, hostVersion: "*" }, "cadquery", "2", "darwin-arm64").hostVersion,
    "*"
  );
  for (const patch of [
    { file: "../cad.tar.gz" },
    { version: ".." },
    { platform: "linux-x64" },
    { sha256: "" },
    { downloadBytes: -1 }
  ]) {
    assert.throws(() => validateArtifact({ ...a, ...patch }, "cadquery", "1", "darwin-arm64"));
  }
});
test("legacy compatible environments are reused without a download and unmanaged uninstall retains their files", async (t) => {
  const f = await fixture(t);
  const service = createComponentService({ ...f.options, legacy: async () => ({ version: "existing" }) });
  assert.equal((await service.status("pptist")).managed, false);
  await service.install("pptist");
  assert.equal(f.downloads, 0);
  await service.action("pptist", "disable");
  assert.equal((await service.status("pptist")).available, false);
  await service.action("pptist", "enable");
  assert.equal((await service.status("pptist")).available, true);
  await service.action("pptist", "uninstall");
  assert.equal(await readFile(join(f.source, "index.html"), "utf8"), "<html>working editor</html>");
});
test("storage symlinks and corrupt state cannot activate or delete an external runtime", async (t) => {
  const f = await fixture(t);
  await mkdir(f.home);
  await symlink(f.source, join(f.home, "pptist"));
  await assert.rejects(f.service.install("pptist"), /symlink/);
  await assert.rejects(f.service.action("pptist", "uninstall"), /symlink/);
  await assert.rejects(f.service.action("pptist", "cancel"), /symlink/);
  assert.equal(await readFile(join(f.source, "index.html"), "utf8"), "<html>working editor</html>");
});
test("HTTP component routes share real installation state and reject unknown IDs and foreign origins", async (t) => {
  const f = await fixture(t);
  const { createDashboardHandler } = await import("../dist/src/dashboard/routes.js");
  let handler;
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ dashboardUrl: base, components: f.service });
  assert.equal((await (await fetch(`${base}/api/components`)).json()).components.length, 3);
  assert.equal((await fetch(`${base}/api/components/nope/install`, { method: "POST" })).status, 400);
  assert.equal(
    (
      await fetch(`${base}/api/components/pptist/install`, {
        method: "POST",
        headers: { origin: "https://foreign.invalid" }
      })
    ).status,
    403
  );
  assert.equal(f.downloads, 0);
  assert.equal((await fetch(`${base}/api/components/pptist/install`, { method: "POST" })).status, 202);
  await f.service.install("pptist");
  assert.equal(
    (await (await fetch(`${base}/api/components`)).json()).components.find((c) => c.id === "pptist")
      .available,
    true
  );
});
test("a scoped HTTP component status stays available while unrelated runtime probes are pending", async (t) => {
  const f = await fixture(t);
  let releaseProbes;
  const probeGate = new Promise((resolve) => {
    releaseProbes = resolve;
  });
  let notifyStarted;
  const probesStarted = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const started = new Set();
  const service = createComponentService({
    ...f.options,
    legacy: async (id) => {
      if (id === "pptist") return { version: "bundled" };
      started.add(id);
      if (started.size === 2) notifyStarted();
      await probeGate;
      return undefined;
    }
  });
  t.after(() => {
    releaseProbes();
    service.stop();
  });
  const { createDashboardHandler } = await import("../dist/src/dashboard/routes.js");
  let handler;
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ dashboardUrl: base, components: service });
  const listing = fetch(`${base}/api/components`).then((response) => response.json());
  try {
    await probesStarted;
    const response = await fetch(`${base}/api/components?id=pptist`, {
      signal: AbortSignal.timeout(2000)
    });
    assert.equal(response.status, 200);
    const { components } = await response.json();
    assert.deepEqual(
      components.map((state) => state.id),
      ["pptist"]
    );
    assert.equal(components[0].available, true);
    assert.equal((await fetch(`${base}/api/components?id=nope`)).status, 400);
    assert.equal((await fetch(`${base}/api/components?id=`)).status, 400);
    assert.equal(f.downloads, 0);
  } finally {
    releaseProbes();
    assert.equal((await listing).components.length, 3);
  }
});
test("an abandoned download lock can recover with the same installer and does not hide retry", async (t) => {
  const f = await fixture(t);
  const lock = join(f.home, "pptist/.install-lock.lock");
  await mkdir(lock, { recursive: true });
  const { hostname } = await import("node:os");
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ token: "abandoned-test-install", pid: 2147483647, host: hostname() })
  );
  await writeFile(
    join(f.home, "pptist/install.json"),
    JSON.stringify({ phase: "downloading", message: "old download" })
  );
  assert.equal((await f.service.status("pptist")).installing, false);
  await f.service.install("pptist");
  assert.equal((await f.service.status("pptist")).available, true);
});
test("a portable PPT component catalog is compatible on a Linux host while native components are unavailable", async (t) => {
  const f = await fixture(t);
  const service = createComponentService({ ...f.options, platform: "linux-x64" });
  await service.install("pptist");
  assert.equal((await service.status("pptist")).available, true);
  assert.throws(() => service.install("cadquery"), /Apple Silicon/);
});

test("corrupt scalar component records do not block discovery or recovery installation", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, "pptist"), { recursive: true });
  await writeFile(join(f.home, "pptist/current.json"), "null");
  await writeFile(join(f.home, "pptist/install.json"), "[]");
  assert.equal((await f.service.status("pptist")).available, false);
  await f.service.install("pptist");
  assert.equal((await f.service.status("pptist")).available, true);
  assert.equal(f.downloads, 1);
});

test("same-artifact repair activates verified bytes in a new slot, survives restart and deduplicates concurrent installers", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "user-document.pptx"), "keep me");
  await f.service.install("pptist");
  const original = JSON.parse(await readFile(join(f.home, "pptist/current.json")));
  await rm(join(f.home, "pptist/versions", original.version, "index.html"));
  const broken = await f.service.status("pptist");
  assert.equal(broken.available, false);
  assert.equal(broken.phase, "missing");
  assert.match(broken.message, /缺失/);
  const validHash = f.artifact.sha256;
  f.artifact.sha256 = "0".repeat(64);
  await assert.rejects(f.service.install("pptist"), /integrity/);
  assert.equal(JSON.parse(await readFile(join(f.home, "pptist/current.json"))).version, original.version);
  f.artifact.sha256 = validHash;
  const other = createComponentService(f.options);
  t.after(() => other.stop());
  const before = f.downloads;
  await Promise.all([f.service.install("pptist"), other.install("pptist")]);
  assert.equal(f.downloads, before + 1);
  const repaired = JSON.parse(await readFile(join(f.home, "pptist/current.json")));
  assert.notEqual(repaired.version, original.version);
  assert.equal(
    await readFile(join(f.home, "pptist/versions", repaired.version, "index.html"), "utf8"),
    "<html>working editor</html>"
  );
  const restarted = createComponentService(f.options);
  t.after(() => restarted.stop());
  assert.equal((await restarted.status("pptist")).available, true);
  await restarted.install("pptist", true);
  const upgraded = JSON.parse(await readFile(join(f.home, "pptist/current.json")));
  assert.notEqual(upgraded.version, repaired.version);
  f.artifact.sha256 = "0".repeat(64);
  await assert.rejects(restarted.install("pptist", true), /integrity/);
  assert.equal((await restarted.status("pptist")).available, true);
  assert.equal(JSON.parse(await readFile(join(f.home, "pptist/current.json"))).version, upgraded.version);
  assert.equal(await readFile(join(f.root, "user-document.pptx"), "utf8"), "keep me");
});

test("explicit CAD and Blender executables determine status and consumers even with installed managed versions", async (t) => {
  const f = await fixture(t);
  const saved = Object.fromEntries(
    ["ATRIA_COMPONENTS_HOME", "COWORK_CADQUERY_PYTHON", "COWORK_BLENDER_EXECUTABLE"].map((key) => [
      key,
      process.env[key]
    ])
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  process.env.ATRIA_COMPONENTS_HOME = f.home;
  const service = createComponentService({ ...f.options, legacy: undefined });
  t.after(() => service.stop());
  const { cadQueryPython } = await import("../dist/src/software/cad/cadquery-engine.js");
  const { blenderExecutable } = await import("../dist/src/software/blender/engine.js");
  for (const [id, key, entry, managedText, externalText] of [
    ["cadquery", "COWORK_CADQUERY_PYTHON", "bin/python3", "2.6.1", "2.5.2"],
    [
      "blender",
      "COWORK_BLENDER_EXECUTABLE",
      "Blender.app/Contents/MacOS/Blender",
      "Blender 4.5.11",
      "Blender 4.4.3"
    ]
  ]) {
    const directory = join(f.home, id, "versions/managed"),
      executable = join(directory, entry),
      external = join(f.root, `external-${id}`);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, `#!/bin/sh\necho '${managedText}'\n`, { mode: 0o755 });
    await writeFile(
      join(f.home, id, "current.json"),
      JSON.stringify({
        apiVersion: 1,
        platform: "darwin-arm64",
        version: "managed",
        runtimeVersion: managedText,
        enabled: true
      })
    );
    await writeFile(external, `#!/bin/sh\necho '${externalText}'\n`, { mode: 0o755 });
    process.env[key] = external;
    const state = await service.status(id);
    assert.equal(state.available, true);
    assert.equal(state.managed, false);
    assert.equal(state.version, externalText.replace("Blender ", ""));
    assert.equal(
      await realpath(id === "cadquery" ? cadQueryPython() : await blenderExecutable()),
      await realpath(external)
    );
    assert.equal(execFileSync(external, ["--version"], { encoding: "utf8" }).trim(), externalText);
    await service.install(id);
    await rm(external);
    assert.equal((await service.status(id)).available, false);
    await assert.rejects(service.install(id), /显式组件路径/);
    assert.equal(f.downloads, 0);
    delete process.env[key];
    assert.equal((await service.status(id)).available, true);
    assert.equal(
      await realpath(id === "cadquery" ? cadQueryPython() : await blenderExecutable()),
      await realpath(executable)
    );
  }
});

test("authenticated refresh and real tar install survive cancel, retry, repeated installs and service restart without leaking credentials", async (t) => {
  const f = await fixture(t, true);
  const portable = createComponentService({ ...f.options, platform: "linux-x64" });
  t.after(() => portable.stop());
  assert.equal(
    (await portable.list(true)).find((v) => v.id === "pptist").downloadBytes,
    f.artifact.downloadBytes
  );
  f.mode = "slow";
  const pending = portable.install("pptist");
  while (f.downloads === 0) await new Promise((done) => setTimeout(done, 10));
  await portable.action("pptist", "cancel");
  await assert.rejects(pending);
  f.mode = "normal";
  await Promise.all([portable.install("pptist"), portable.install("pptist")]);
  const count = f.downloads;
  await portable.install("pptist");
  assert.equal(f.downloads, count);
  assert.equal(
    (await createComponentService({ ...f.options, platform: "linux-x64" }).status("pptist")).available,
    true
  );
  const records =
    (await readFile(join(f.home, "pptist/current.json"), "utf8")) +
    (await readFile(join(f.home, "pptist/install.json"), "utf8"));
  assert.equal(/synthetic-private-token|synthetic=signed/.test(records), false);
  assert.ok(f.credentials.includes("Bearer synthetic-private-token"));
  assert.ok(f.credentials.includes(undefined));
});

test("actual components CLI takes explicit credential environment and installs through authenticated HTTP without echoing the secret", async (t) => {
  const f = await fixture(t, true);
  f.artifact.hostVersion = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ).version;
  const shim = join(f.root, "fetch-shim.mjs");
  await writeFile(
    shim,
    `const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (process.env.ATRIA_COMPONENTS_GITHUB_TOKEN !== undefined) throw new Error("Credential environment was not removed");
  const parsed = new URL(url);
  return original(${JSON.stringify(f.httpRoot)} + parsed.pathname + parsed.search, init);
};`
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", shim, "scripts/atria.mjs", "components", "install", "pptist"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        ATRIA_COMPONENTS_HOME: f.home,
        ATRIA_COMPONENTS_RELEASE_ROOT: "https://github.com/ignorejjj/Atria-Cowork/releases/download/v1.0.0",
        ATRIA_COMPONENTS_GITHUB_TOKEN: "synthetic-private-token",
        COWORK_UI_DIR: join(f.root, "missing-ui")
      }
    }
  );
  assert.equal(/synthetic-private-token|synthetic=signed/.test(result.stdout + result.stderr), false);
  assert.equal(JSON.parse(result.stdout).available, true);
  assert.ok(f.credentials.includes("Bearer synthetic-private-token"));
});

test("actual components CLI uses the public release anonymously and reuses it after host upgrades", async (t) => {
  const f = await fixture(t);
  f.artifact.hostVersion = "*";
  const shim = join(f.root, "public-fetch-shim.mjs");
  await writeFile(
    shim,
    `const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (process.env.ATRIA_COMPONENTS_GITHUB_TOKEN !== undefined) throw new Error("Inherited credential was not discarded");
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com" || !parsed.pathname.startsWith("/ignorejjj/Atria-Components/releases/download/components-v1/")) throw new Error("Unexpected component source");
  return original(${JSON.stringify(f.httpRoot)} + parsed.pathname, init);
};`
  );
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const isolated = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:COWORK_|PI_|ATRIA_|SERPER_)/.test(name))
  );
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", shim, "scripts/atria.mjs", "components", "install", "pptist"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...isolated,
        ATRIA_HOME: join(f.root, "cli-home"),
        ATRIA_COMPONENTS_HOME: f.home,
        ATRIA_COMPONENTS_GITHUB_TOKEN: "synthetic-unused-token",
        COWORK_UI_DIR: join(f.root, "missing-ui")
      }
    }
  );
  assert.equal(JSON.parse(result.stdout).available, true);
  assert.equal(/synthetic-unused-token/.test(result.stdout + result.stderr), false);
  assert.equal(f.downloads, 1);
  assert.ok(f.credentials.every((value) => value === undefined));
  const upgraded = createComponentService({
    ...f.options,
    hostVersion: "99.0.0",
    fetcher: async () => assert.fail("compatible runtime should be reused")
  });
  t.after(() => upgraded.stop());
  await upgraded.prepareMissing(["pptist"]);
  assert.equal((await upgraded.status("pptist")).available, true);
});

test("real backend credential IPC changes authenticated catalog requests without restarting or exposing secrets", async (t) => {
  const f = await fixture(t, true);
  const hostVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  f.artifact.hostVersion = hostVersion;
  const cad = { ...f.artifact, id: "cadquery", platform: "darwin-arm64" };
  const shim = join(f.root, "backend-fetch-shim.mjs");
  // Exercise production download URLs using real local HTTP, never production credentials.
  await writeFile(
    shim,
    `const original = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = new URL(url);
  if (["github.com", "api.github.com", "release-assets.githubusercontent.com"].includes(target.hostname)) {
    const response = await original(${JSON.stringify(f.httpRoot)} + target.pathname + target.search, init);
    if (target.pathname === "/catalog.json") return new Response(JSON.stringify({ artifacts: [${JSON.stringify(cad)}, ${JSON.stringify(f.artifact)}] }), { headers: { "content-type": "application/json" } });
    return response;
  }
  if (target.hostname === "download.blender.org") return new Response(null, { headers: { "content-length": "1024" } });
  return original(url, init);
};`
  );
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { startBackend } = require("../desktop/backend.cjs");
  const { desktopPaths, prepareDesktopData } = require("../desktop/paths.cjs");
  const paths = desktopPaths(new URL("..", import.meta.url).pathname, join(f.root, "backend-data"), {});
  await prepareDesktopData(paths, hostVersion);
  await writeFile(paths.configPath, "{}");
  const before = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    ATRIA_COMPONENTS_RELEASE_ROOT: process.env.ATRIA_COMPONENTS_RELEASE_ROOT,
    ATRIA_COMPONENTS_GITHUB_TOKEN: process.env.ATRIA_COMPONENTS_GITHUB_TOKEN
  };
  let backend;
  try {
    process.env.NODE_OPTIONS = `--import=${shim}`;
    process.env.ATRIA_COMPONENTS_RELEASE_ROOT =
      "https://github.com/ignorejjj/Atria-Cowork/releases/download/v1.0.0";
    process.env.ATRIA_COMPONENTS_GITHUB_TOKEN = "synthetic-parent-env-marker";
    backend = await startBackend(paths, {}, process.execPath);
  } finally {
    for (const [key, value] of Object.entries(before))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
  t.after(() => backend.stop());
  const pid = backend.child.pid;
  const refresh = () =>
    fetch(`${backend.url}/api/components?refresh=1`, { headers: { "x-atria-token": backend.token } });
  assert.equal((await refresh()).ok, false);
  assert.equal(
    f.credentials.some((value) => value?.includes("synthetic-parent-env-marker")),
    false
  );
  await backend.componentAuth("synthetic-private-token");
  const response = await refresh();
  assert.equal(response.ok, true);
  assert.equal(JSON.stringify(await response.json()).includes("synthetic-private-token"), false);
  assert.ok(f.credentials.includes("Bearer synthetic-private-token"));
  await backend.componentAuth("");
  const count = f.credentials.length;
  assert.equal((await refresh()).ok, false);
  assert.equal(
    f.credentials.slice(count).every((v) => v === undefined),
    true
  );
  assert.equal(backend.child.pid, pid);
  assert.equal(
    (await readFile(join(paths.logs, "dashboard.log"), "utf8")).includes("synthetic-private-token"),
    false
  );
});

test("local component recheck bypasses cached probes without contacting the private release", async (t) => {
  const f = await fixture(t);
  let installed = false;
  const service = createComponentService({
    ...f.options,
    legacy: async (id) => (id === "pptist" && installed ? { version: "bundled" } : undefined),
    fetcher: async () => assert.fail("local recheck must not access the release server")
  });
  t.after(() => service.stop());
  const { createDashboardHandler } = await import("../dist/src/dashboard/routes.js");
  let handler;
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ dashboardUrl: base, components: service });
  const ppt = async (query = "") =>
    (await (await fetch(`${base}/api/components${query}`)).json()).components.find(
      (state) => state.id === "pptist"
    );
  assert.equal((await ppt()).available, false);
  installed = true;
  assert.equal((await ppt()).available, false);
  assert.equal((await ppt("?probe=1")).available, true);
  installed = false;
  assert.equal((await ppt("?probe=1")).available, false);
});

test("automatic preparation reuses compatible components, honors disable and cancel, and retries failed installs after restart", async (t) => {
  const f = await fixture(t);
  f.artifact.hostVersion = "*";
  const fresh = (options = {}) => {
    const service = createComponentService({ ...f.options, ...options });
    t.after(() => service.stop());
    return service;
  };
  await f.service.action("pptist", "disable");
  await fresh().prepareMissing(["pptist"]);
  assert.equal(f.downloads, 0);
  await f.service.action("pptist", "enable");
  await f.service.action("pptist", "cancel");
  await fresh().prepareMissing(["pptist"]);
  assert.equal(f.downloads, 0);
  // Manual retry clears cancellation; a failed network attempt can recover next launch.
  f.mode = "offline";
  await assert.rejects(f.service.install("pptist"), /503/);
  assert.equal((await f.service.status("pptist")).phase, "failed");
  f.mode = "normal";
  await fresh({ hostVersion: "2.0.0" }).prepareMissing(["pptist"]);
  assert.equal((await f.service.status("pptist")).available, true);
  const count = f.downloads;
  await fresh({ hostVersion: "3.0.0" }).prepareMissing(["pptist"]);
  assert.equal(f.downloads, count);
  assert.ok(f.credentials.every((value) => value === undefined));
});

test("desktop metadata alone opts into background preparation; source and full packages stay offline", () => {
  assert.equal(autoInstallComponentsEnabled({}), false);
  assert.equal(autoInstallComponentsEnabled({ atriaBundledComponents: false }), false);
  assert.equal(
    autoInstallComponentsEnabled({ atriaAutoInstallComponents: true, atriaBundledComponents: true }),
    false
  );
  assert.equal(
    autoInstallComponentsEnabled({ atriaAutoInstallComponents: true, atriaBundledComponents: false }),
    true
  );
});

test("cancelling a manual install during its runtime probe remains cancelled after restart", async (t) => {
  const f = await fixture(t);
  let releaseProbe,
    probeStarted,
    cancelReachedProbe,
    calls = 0;
  const probe = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const started = new Promise((resolve) => {
    probeStarted = resolve;
  });
  const cancelReached = new Promise((resolve) => {
    cancelReachedProbe = resolve;
  });
  const service = createComponentService({
    ...f.options,
    legacy: async () => {
      if (++calls === 1) probeStarted();
      else cancelReachedProbe();
      await probe;
      return undefined;
    }
  });
  t.after(() => service.stop());
  const installing = service.install("pptist");
  const rejected = assert.rejects(installing, /abort|cancel/i);
  await started;
  const cancelling = service.action("pptist", "cancel");
  // action() probes status only after writing the persistent cancel marker and aborting the job.
  await cancelReached;
  releaseProbe();
  await Promise.all([rejected, cancelling]);
  assert.equal(await readFile(join(f.home, "pptist/cancel"), "utf8"), "");
  const restarted = createComponentService(f.options);
  t.after(() => restarted.stop());
  await restarted.prepareMissing(["pptist"]);
  assert.equal(f.downloads, 0);
  assert.equal((await restarted.status("pptist")).available, false);
});

test("a user cancellation persists when a manual retry was already clearing the previous marker", async (t) => {
  const f = await fixture(t);
  const cancelFile = join(f.home, "pptist/cancel");
  const originalRm = fsPromises.rm;
  let startClear, finishClear;
  const clearing = new Promise((resolve) => {
    startClear = resolve;
  });
  const cleared = new Promise((resolve) => {
    finishClear = resolve;
  });
  fsPromises.rm = async (path, options) => {
    if (path === cancelFile) {
      startClear();
      await cleared;
    }
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  const installing = f.service.install("pptist");
  const rejection = assert.rejects(installing, /abort|cancel/i);
  try {
    await clearing;
    await f.service.action("pptist", "cancel");
    finishClear();
    await rejection;
    assert.equal(await readFile(cancelFile, "utf8"), "");
  } finally {
    finishClear();
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
    await rejection;
  }
  const restarted = createComponentService(f.options);
  t.after(() => restarted.stop());
  await restarted.prepareMissing(["pptist"]);
  assert.equal(f.downloads, 0);
});

test("automatic preparation never clears a user cancellation marker", async (t) => {
  const f = await fixture(t);
  f.mode = "slow";
  const cancelFile = join(f.home, "pptist/cancel");
  const originalRm = fsPromises.rm;
  let clears = 0;
  fsPromises.rm = async (path, options) => {
    if (path === cancelFile) clears++;
    return originalRm(path, options);
  };
  syncBuiltinESMExports();
  try {
    const preparation = f.service.prepareMissing(["pptist"]);
    for (let attempt = 0; !f.downloads && attempt < 200; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.downloads, 1);
    await f.service.action("pptist", "cancel");
    await preparation;
    assert.equal(clears, 0);
    assert.equal(await readFile(cancelFile, "utf8"), "");
  } finally {
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
  }
});

test("shutdown waits for background probes without starting downloads or propagating probe failures", async (t) => {
  for (const fail of [false, true]) {
    const f = await fixture(t);
    let finishProbe, enteredProbe;
    const entered = new Promise((resolve) => {
      enteredProbe = resolve;
    });
    const probe = new Promise((resolve, reject) => {
      finishProbe = () => (fail ? reject(new Error("fixture probe interrupted")) : resolve(undefined));
    });
    const service = createComponentService({
      ...f.options,
      legacy: async () => {
        enteredProbe();
        return probe;
      }
    });
    t.after(() => service.stop());
    const preparation = service.prepareMissing(["pptist"]);
    const outcome = preparation.catch((error) => error.message);
    await entered;
    const stopping = service.stop();
    finishProbe();
    await assert.doesNotReject(stopping);
    assert.equal(await outcome, fail ? "fixture probe interrupted" : undefined);
    assert.equal(f.downloads, 0);
    assert.throws(() => service.install("pptist"), /shutting down/);
  }
});

test("a listening Dashboard remains usable during real background HTTP download and shutdown cancels staging", async (t) => {
  const f = await fixture(t);
  const isolated = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(?:COWORK_|PI_|ATRIA_|SERPER_)/.test(key))
  );
  for (const key of Object.keys(isolated)) delete process.env[key];
  Object.assign(process.env, {
    ATRIA_HOME: join(f.root, "dashboard-home"),
    COWORK_CONFIG: join(f.root, "config.json"),
    COWORK_WORKSPACE: join(f.root, "workspace"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1"
  });
  await writeFile(process.env.COWORK_CONFIG, "{}");
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (/^(?:COWORK_|PI_|ATRIA_|SERPER_)/.test(key)) delete process.env[key];
    Object.assign(process.env, isolated);
  });
  const { createDashboardApplication } = await import("../dist/src/dashboard/application.js");
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // CAD/Blender are compatible fixtures; only PPT needs a real downloaded archive.
  const service = createComponentService({
    ...f.options,
    legacy: async (id) => (id === "pptist" ? undefined : { version: "compatible-fixture" })
  });
  f.mode = "slow";
  const dashboard = createDashboardApplication({
    projectRoot: f.root,
    port,
    components: service,
    autoInstallComponents: true
  });
  t.after(() => dashboard.stop());
  assert.equal(f.downloads, 0, "construction must not install");
  await new Promise((resolve) => dashboard.server.listen(port, "127.0.0.1", resolve));
  for (let attempt = 0; !f.downloads && attempt < 200; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.downloads, 1);
  const response = await fetch(`http://127.0.0.1:${port}/api/components`, {
    signal: AbortSignal.timeout(2000)
  });
  assert.equal(response.ok, true);
  assert.equal((await response.json()).components.find((state) => state.id === "pptist").installing, true);
  await dashboard.stop();
  assert.equal((await service.status("pptist")).phase, "cancelled");
  assert.ok((await readdir(join(f.home, "pptist"))).every((name) => !/^\.download-|^\.staging-/.test(name)));
  assert.throws(() => service.install("pptist"), /shutting down/);
  f.mode = "normal";
  const restarted = createComponentService(f.options);
  t.after(() => restarted.stop());
  await restarted.prepareMissing(["pptist"]);
  assert.equal((await restarted.status("pptist")).available, true);
});

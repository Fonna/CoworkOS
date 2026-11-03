import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import {
  createBlenderInstaller,
  installBlenderRuntime,
  BLENDER_INSTALL_SOURCE
} from "../dist/src/software/blender/installer.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-blender-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified fixture archive");
  return {
    root,
    directory: join(root, "blender"),
    bytes,
    source: {
      file: "fixture.dmg",
      urls: ["https://fixture.invalid/blender.dmg"],
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  };
}

test("corrupt Blender downloads never mount or replace an existing runtime and can be retried", async (t) => {
  const f = await fixture(t);
  let executions = 0;
  const execute = async () => {
    executions++;
  };
  await assert.rejects(
    installBlenderRuntime({ ...f, execute, fetcher: async () => new Response("tampered") }),
    /校验失败/
  );
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(join(f.root, "blender-download")), []);
  let downloads = 0;
  const calls = [];
  const native = async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith("ditto")) {
      const executable = join(args[1], "Contents/MacOS/Blender");
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(executable, "fixture executable", { mode: 0o755 });
    }
  };
  await installBlenderRuntime({
    ...f,
    execute: native,
    fetcher: async () => {
      downloads++;
      return new Response(f.bytes);
    }
  });
  assert.equal(downloads, 1);
  assert.equal(
    await readFile(join(f.directory, "Blender.app/Contents/MacOS/Blender"), "utf8"),
    "fixture executable"
  );
  assert.equal(calls.at(-1)[1][0], "detach");
  assert.ok(calls.some(([, args]) => args[0] === "--version"));
  assert.deepEqual(await readdir(f.root), ["blender", "blender-download"]);
});

test("fixed public Blender mirror falls back after a corrupt HTTP download and never sends credentials", async (t) => {
  assert.match(
    BLENDER_INSTALL_SOURCE.urls[0],
    /^https:\/\/github\.com\/ignorejjj\/Atria-Components\/releases\/download\/components-v1\//
  );
  assert.match(BLENDER_INSTALL_SOURCE.urls[1], /^https:\/\/download\.blender\.org\//);
  const f = await fixture(t);
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    response.end(request.url === "/mirror.dmg" ? Buffer.alloc(f.bytes.length, "x") : f.bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  await installBlenderRuntime({
    ...f,
    source: {
      ...f.source,
      downloadBytes: f.bytes.length,
      urls: [`${origin}/mirror.dmg`, `${origin}/official.dmg`]
    },
    execute: async (command, args) => {
      if (command.endsWith("ditto")) {
        const executable = join(args[1], "Contents/MacOS/Blender");
        await mkdir(dirname(executable), { recursive: true });
        await writeFile(executable, "fixture", { mode: 0o755 });
      }
    }
  });
  assert.deepEqual(seen, [
    { url: "/mirror.dmg", authorization: undefined },
    { url: "/official.dmg", authorization: undefined }
  ]);
  assert.equal(await readFile(join(f.directory, "Blender.app/Contents/MacOS/Blender"), "utf8"), "fixture");
});

test("an extraction failure detaches the image, retains the verified cache and leaves no partial installation", async (t) => {
  const f = await fixture(t);
  let detached = false;
  await assert.rejects(
    installBlenderRuntime({
      ...f,
      fetcher: async () => new Response(f.bytes),
      execute: async (command, args) => {
        if (command.endsWith("ditto")) throw new Error("insufficient space");
        if (args[0] === "detach") detached = true;
      }
    }),
    /insufficient space/
  );
  assert.equal(detached, true);
  assert.deepEqual(await readdir(f.root), ["blender-download"]);
  assert.deepEqual(await readdir(join(f.root, "blender-download")), ["fixture.dmg"]);
});

test("install requests share one job, report failure and retry to a verified ready state", async () => {
  let calls = 0,
    available = false,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createBlenderInstaller({
    supported: true,
    probe: async () => ({ available }),
    install: async ({ report }) => {
      calls++;
      report({ phase: "downloading", message: "下载中", progress: 42 });
      if (calls === 1) {
        await gate;
        throw new Error("offline");
      }
      available = true;
    }
  });
  const statuses = await Promise.all([service.start(), service.start()]);
  assert.ok(statuses.every((state) => state.installing));
  assert.equal(calls, 1);
  assert.equal((await service.status()).progress, 42);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status()).message, "offline");
  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.status()).available, true);
  assert.equal(calls, 2);
  await service.start();
  await service.stop();
  assert.equal(calls, 2);
});

test("unsupported systems cannot start a download and shutdown aborts an active job", async () => {
  const unsupported = createBlenderInstaller({ supported: false, probe: async () => ({ available: false }) });
  assert.equal((await unsupported.status()).canInstall, false);
  assert.throws(() => unsupported.start(), /Apple Silicon/);
  let aborted = false;
  const service = createBlenderInstaller({
    supported: true,
    probe: async () => ({ available: false }),
    install: async ({ signal }) => {
      await new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        )
      );
      signal.throwIfAborted();
    }
  });
  await service.start();
  await service.stop();
  assert.equal(aborted, true);
  assert.equal((await service.status()).phase, "failed");
});

test("an interrupted attach attempts detachment and never recursively deletes a still mounted image", async (t) => {
  const f = await fixture(t);
  const calls = [];
  let mountedFile;
  await assert.rejects(
    installBlenderRuntime({
      ...f,
      fetcher: async () => new Response(f.bytes),
      execute: async (_command, args) => {
        calls.push(args[0]);
        if (args[0] === "attach") {
          mountedFile = join(args[args.indexOf("-mountpoint") + 1], "mounted-content");
          await writeFile(mountedFile, "keep");
          throw new Error("attach interrupted");
        }
        if (args[0] === "detach") throw new Error("busy");
      }
    }),
    /attach interrupted/
  );
  assert.deepEqual(calls, ["attach", "detach", "detach"]);
  assert.equal(await readFile(mountedFile, "utf8"), "keep");
  assert.equal(
    (await readdir(f.root)).some((name) => name.includes("staging")),
    false
  );
});

test(
  "macOS installs a checksum-verified DMG using real mount, copy, executable verification and cleanup",
  {
    skip: process.platform !== "darwin",
    timeout: 60000
  },
  async (t) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const f = await fixture(t);
    const folder = join(f.root, "fixture-source");
    const executable = join(folder, "Blender.app/Contents/MacOS/Blender");
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "Blender fixture 4.5\\n"\n', { mode: 0o755 });
    const dmg = join(f.root, "native.dmg");
    await exec("/usr/bin/hdiutil", [
      "create",
      "-srcfolder",
      folder,
      "-format",
      "UDZO",
      "-volname",
      "AtriaInstallFixture",
      dmg
    ]);
    const bytes = await readFile(dmg);
    const source = { ...f.source, sha256: createHash("sha256").update(bytes).digest("hex") };
    await installBlenderRuntime({ directory: f.directory, source, fetcher: async () => new Response(bytes) });
    const result = await exec(join(f.directory, "Blender.app/Contents/MacOS/Blender"), ["--version"]);
    assert.match(result.stdout, /Blender fixture 4.5/);
    assert.deepEqual(await readdir(join(f.root, "blender-download")), ["fixture.dmg"]);
    assert.equal(
      (await readdir(f.root)).some((name) => name.includes("staging")),
      false
    );
  }
);

test("installation HTTP endpoints expose shared status and reject foreign origins before starting", async (t) => {
  const { createServer } = await import("node:http");
  const { createDashboardHandler } = await import("../dist/src/dashboard/routes.js");
  let handler,
    starts = 0;
  const state = {
    phase: "downloading",
    message: "downloading",
    available: false,
    installing: true,
    canInstall: true
  };
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({
    dashboardUrl: base,
    blenderInstaller: {
      status: async () => state,
      start: async () => {
        starts++;
        return state;
      }
    }
  });
  assert.deepEqual(await (await fetch(`${base}/api/applications/blender/runtime`)).json(), state);
  const accepted = await fetch(`${base}/api/applications/blender/install`, { method: "POST" });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), state);
  const rejected = await fetch(`${base}/api/applications/blender/install`, {
    method: "POST",
    headers: { origin: "https://foreign.invalid" }
  });
  assert.equal(rejected.status, 403);
  assert.equal(starts, 1);
});

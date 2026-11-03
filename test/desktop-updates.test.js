import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createDesktopUpdates } = createRequire(import.meta.url)("../desktop/updates.cjs");
const { prepareDesktopChange } = createRequire(import.meta.url)("../desktop/update-lifecycle.cjs");
const root = join(tmpdir(), "atria-update-controller-fixture");
const installer = join(root, "downloads", "CoworkOS-1.1.0-mac-arm64.dmg");
const sourceCheck = {
  mode: "source",
  available: true,
  currentVersion: "1.0.0",
  version: "1.0.0",
  currentCommit: "old-commit",
  remoteCommit: "new-commit",
  branch: "main"
};
const releaseCheck = {
  mode: "release",
  available: true,
  currentVersion: "1.0.0",
  version: "1.1.0",
  releaseUrl: "https://github.com/fixture/atria/releases/tag/v1.1.0",
  feedUrl: "https://github.com/fixture/atria/releases/download/v1.1.0/atria-update-mac-arm64.json",
  asset: {
    name: "CoworkOS-1.1.0-mac-arm64.dmg",
    url: "https://github.com/fixture/atria/releases/download/v1.1.0/CoworkOS-1.1.0-mac-arm64.dmg",
    size: 100,
    sha256: "0".repeat(64)
  },
  checksum: {
    name: "CoworkOS-1.1.0-mac-arm64.dmg.sha256",
    url: "https://github.com/fixture/atria/releases/download/v1.1.0/CoworkOS-1.1.0-mac-arm64.dmg.sha256"
  }
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise((done) => setImmediate(done));
function nativeUpdater() {
  const emitter = new EventEmitter();
  emitter.on("error", () => {});
  emitter.checks = 0;
  emitter.installs = 0;
  emitter.setFeedURL = (value) => {
    emitter.feed = value;
  };
  emitter.checkForUpdates = () => {
    emitter.checks++;
  };
  emitter.quitAndInstall = () => {
    emitter.installs++;
  };
  return emitter;
}
function packaged(options = {}) {
  return createDesktopUpdates({
    mode: "release",
    root,
    currentVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    downloadDirectory: join(root, "downloads"),
    managedInstaller: { stage: async () => {} },
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck }),
      downloadRelease: async () => installer
    },
    ...options
  });
}

test("the host manifest version is available before an update check", () => {
  const updates = packaged();
  assert.equal(updates.status().currentVersion, "1.0.0");
  assert.equal(updates.status().phase, "idle");
});

test("source updates detect same-version commits and wait for host preparation before promotion", async () => {
  const gate = deferred();
  const calls = [];
  const toolchain = { nodeExecutable: "/fixture/node", npmCli: "/fixture/npm-cli.js" };
  const commandRunner = () => {};
  let updates;
  updates = createDesktopUpdates({
    mode: "source",
    root,
    toolchain,
    commandRunner,
    sourceUpdater: async () => ({
      async checkSourceUpdate(input) {
        assert.equal(input.root, root);
        assert.equal(input.target, "desktop");
        input.onProgress("Fetched upstream");
        return { ...sourceCheck };
      },
      async updateSource(input) {
        calls.push("promote");
        assert.equal(input.target, "desktop");
        assert.equal(input.toolchain, toolchain);
        assert.equal(input.commandRunner, commandRunner);
        input.onProgress("Building candidate");
        return { ...sourceCheck, updated: true, needsRelaunch: true };
      }
    }),
    async beforeApply(state) {
      calls.push("prepare");
      assert.equal(state.busy, true);
      assert.equal(state.installMethod, "source");
      await gate.promise;
    }
  });
  const checked = await updates.check();
  assert.equal(checked.available, true);
  assert.equal(checked.currentVersion, checked.version);
  assert.notEqual(checked.currentCommit, checked.remoteCommit);
  const applied = updates.apply();
  await nextTurn();
  assert.deepEqual(calls, ["prepare"]);
  await assert.rejects(updates.apply(), /already running/);
  await assert.rejects(updates.check(), /already running/);
  assert.equal(
    updates.status().error,
    undefined,
    "a competing request cannot overwrite the active operation"
  );
  gate.resolve();
  const result = await applied;
  assert.deepEqual(calls, ["prepare", "promote"]);
  assert.equal(result.updated, true);
  assert.equal(result.needsRelaunch, true);
  assert.equal(result.busy, false);
  await updates.apply();
  assert.deepEqual(
    calls,
    ["prepare", "promote", "prepare"],
    "another relaunch attempt requires preparation without another promotion"
  );
});

test("failed source preparation never calls the updater and a retry can succeed", async () => {
  let writable = false;
  let promotions = 0;
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck }),
      updateSource: async () => {
        promotions++;
        return { ...sourceCheck, updated: true };
      }
    },
    beforeApply: async () => {
      if (!writable) throw new Error("Documents are not saved");
    }
  });
  await assert.rejects(updates.apply(), /not saved/);
  assert.equal(promotions, 0);
  assert.equal(updates.status().busy, false);
  assert.equal(updates.status().available, true);
  assert.equal(updates.status().needsRelaunch, false);
  writable = true;
  assert.equal((await updates.apply()).updated, true);
  assert.equal(promotions, 1);
});

test("source updates require a host gate and failures remain retryable without a false relaunch", async () => {
  let attempts = 0;
  const sourceUpdater = {
    checkSourceUpdate: async () => ({ ...sourceCheck }),
    updateSource: async () => {
      if (++attempts === 1) throw new Error("Candidate build failed");
      return { ...sourceCheck, updated: true };
    }
  };
  const ungated = createDesktopUpdates({ mode: "source", root, sourceUpdater });
  await assert.rejects(ungated.apply(), /host must prepare/);
  assert.equal(attempts, 0);
  const updates = createDesktopUpdates({ mode: "source", root, sourceUpdater, beforeApply: async () => {} });
  await assert.rejects(updates.apply(), /Candidate build failed/);
  assert.equal(updates.status().updated, false);
  assert.equal(updates.status().needsRelaunch, false);
  assert.equal(updates.status().busy, false);
  assert.equal((await updates.apply()).needsRelaunch, true);
});

test("a promoted source update rechecks new activity when the host retries a failed restart", async () => {
  let builds = 0;
  let backendRunning = true;
  let taskActive = false;
  let draft = "before promotion";
  let savedDraft;
  let stops = 0;
  const backend = {
    url: "http://127.0.0.1:43210",
    token: "fixture-source-retry",
    stop() {
      stops++;
      backendRunning = false;
    }
  };
  const task = { taskId: "new-task", status: "waiting", activeRunId: "new-run" };
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck }),
      updateSource: async () => {
        assert.equal(backendRunning, false);
        builds++;
        return { ...sourceCheck, updated: true };
      }
    },
    async beforeApply() {
      assert.equal(backendRunning, true);
      await prepareDesktopChange({
        backend,
        documents: {
          async request() {
            savedDraft = draft;
            return true;
          }
        },
        fetchImpl: async (url) =>
          Response.json(
            url.endsWith("/api/tasks") ? { tasks: [task] } : { task, runtime: { active: taskActive } }
          )
      });
      backend.stop();
    }
  });
  assert.equal((await updates.apply()).updated, true);
  assert.equal(builds, 1);
  assert.equal(savedDraft, "before promotion");
  backendRunning = true; // The host's failed restart recovered a usable backend.
  draft = "draft after recovery";
  taskActive = true;
  await assert.rejects(updates.apply(), /任务正在运行/);
  assert.equal(stops, 1);
  assert.equal(builds, 1);
  assert.equal(savedDraft, "before promotion");
  assert.equal(updates.status().updated, true);
  assert.equal(updates.status().needsRelaunch, false);
  taskActive = false;
  const retry = await updates.apply();
  assert.equal(savedDraft, "draft after recovery");
  assert.equal(stops, 2);
  assert.equal(builds, 1, "retrying the restart must not rebuild or promote the source again");
  assert.equal(retry.updated, true);
  assert.equal(retry.needsRelaunch, true);
});

test("an up-to-date source checkout does not stop the backend or run a build", async () => {
  let prepared = 0,
    built = 0;
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async () => ({ ...sourceCheck, available: false }),
      updateSource: async () => built++
    },
    beforeApply: async () => prepared++
  });
  assert.equal((await updates.apply()).phase, "up-to-date");
  assert.equal(prepared, 0);
  assert.equal(built, 0);
});

test("a CLI-only source build can request the App build at the current commit", async () => {
  let built = 0;
  const current = {
    ...sourceCheck,
    remoteCommit: sourceCheck.currentCommit,
    rebuildRequired: true
  };
  const updates = createDesktopUpdates({
    mode: "source",
    root,
    sourceUpdater: {
      checkSourceUpdate: async ({ target }) => {
        assert.equal(target, "desktop");
        return { ...current };
      },
      updateSource: async ({ target }) => {
        assert.equal(target, "desktop");
        built++;
        return { ...current, updated: true };
      }
    },
    beforeApply: async () => {}
  });
  const checked = await updates.check();
  assert.equal(checked.available, true);
  assert.equal(checked.rebuildRequired, true);
  assert.equal(checked.currentCommit, checked.remoteCommit);
  const result = await updates.apply();
  assert.equal(built, 1);
  assert.equal(result.updated, true);
  assert.equal(result.rebuildRequired, false);
  assert.equal(result.needsRelaunch, true);
});

test("managed packages stage a verified update without stopping edits and gate installation separately", async () => {
  const native = nativeUpdater();
  const notices = [];
  let downloads = 0,
    preparations = 0;
  const updates = packaged({
    signed: false,
    autoUpdater: native,
    beforeApply: async () => preparations++,
    onStatus: (state) => {
      notices.push(state);
      if (state.progress) state.progress.downloaded = -1;
    },
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck }),
      async downloadRelease(input) {
        downloads++;
        assert.equal(input.directory, join(root, "downloads"));
        input.onProgress({ phase: "download", message: "Downloading", downloaded: 25, total: 100 });
        assert.equal(updates.status().progress.percent, 25);
        assert.equal(
          updates.status().progress.downloaded,
          25,
          "UI snapshots cannot mutate coordinator state"
        );
        return installer;
      }
    }
  });
  const check = await updates.check();
  assert.equal(check.installMethod, "managed");
  assert.equal(native.checks, 0);
  const result = await updates.apply();
  assert.equal(result.phase, "ready");
  assert.equal(result.downloadPath, installer);
  assert.equal(result.requiresManualInstall, false);
  assert.equal(result.needsRelaunch, true);
  assert.equal(result.installReady, false);
  assert.equal(preparations, 0);
  assert.equal(native.installs, 0);
  assert.ok(notices.some((state) => state.phase === "downloading" && state.busy));
  assert.equal((await updates.apply()).installReady, true);
  assert.equal(preparations, 1);
  assert.equal(downloads, 1, "installation reuses the verified staged update");
});

test("packaged Mac updates check and download the npm desktop package", async () => {
  const calls = [];
  let staged;
  const npmCheck = {
    mode: "release",
    source: "npm-registry",
    package: "coworkos-desktop-darwin-arm64",
    tag: "latest",
    currentVersion: "1.0.0",
    version: "1.1.0",
    available: true,
    manifest: {
      schemaVersion: 1,
      appVersion: "1.1.0",
      platform: "darwin",
      arch: "arm64",
      artifact: {
        name: "CoworkOS-1.1.0-mac-arm64.dmg",
        size: 100,
        sha256: "0".repeat(64)
      }
    },
    asset: { name: "CoworkOS-1.1.0-mac-arm64.dmg" },
    tarball: {
      url: "https://registry.npmjs.org/coworkos-desktop-darwin-arm64/-/coworkos-desktop-darwin-arm64-1.1.0.tgz",
      integrity: "sha512-" + "A".repeat(88)
    }
  };
  const updates = packaged({
    managedInstaller: {
      async stage(input) {
        staged = input;
      }
    },
    npmDesktopUpdater: {
      async checkNpmDesktopRelease(input) {
        calls.push(["check", input]);
        return { ...npmCheck };
      },
      async downloadNpmDesktopRelease(input) {
        calls.push(["download", input]);
        return installer;
      }
    },
    releaseUpdater: {
      checkRelease: async () => assert.fail("GitHub release checks are not used"),
      downloadRelease: async () => assert.fail("GitHub release downloads are not used")
    }
  });

  const checked = await updates.check();
  assert.equal(checked.available, true);
  assert.equal(checked.installMethod, "managed");
  assert.equal(calls[0][0], "check");
  assert.equal(calls[0][1].kind, "mac");
  assert.equal(calls[0][1].arch, "arm64");
  const result = await updates.apply();
  assert.equal(result.downloadPath, installer);
  assert.equal(calls[1][0], "download");
  assert.equal(calls[1][1].check.source, "npm-registry");
  assert.equal(calls[1][1].directory, join(root, "downloads"));
  assert.deepEqual(staged, { archive: installer, check: npmCheck });
});

test("checksum failures never expose an installer and retries keep the selected release", async () => {
  let calls = 0;
  const updates = packaged({
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck }),
      downloadRelease: async () => {
        if (++calls === 1) throw new Error("Checksum mismatch");
        return installer;
      }
    }
  });
  await assert.rejects(updates.apply(), /Checksum mismatch/);
  assert.equal(updates.status().downloadPath, undefined);
  assert.equal(updates.status().downloaded, false);
  assert.equal(updates.status().phase, "error");
  assert.equal((await updates.apply()).downloadPath, installer);
});

test("renderer checks cannot select channels or repositories and use the public-feed contract", async () => {
  const checks = [];
  const updates = packaged({
    releaseUpdater: {
      async checkRelease(input) {
        checks.push(input);
        return { ...releaseCheck, source: "public-feed" };
      },
      async downloadRelease() {
        return installer;
      }
    }
  });
  for (const input of [
    { channel: "preview" },
    { url: "https://example.invalid/feed" },
    { repository: "other/repo" }
  ])
    await assert.rejects(updates.check(input), /do not accept renderer configuration/);
  await assert.rejects(updates.check(null), /Invalid update check/);
  assert.equal(checks.length, 0);
  await updates.check({});
  assert.equal(checks.length, 1);
  assert.equal(checks[0].channel, undefined);
  assert.equal(checks[0].kind, "mac");
  assert.equal(checks[0].arch, "arm64");
  assert.equal((await updates.apply()).channel, undefined);
});

test("a failed fresh check clears stale availability while a staged installer survives automatic checks", async () => {
  let available = true,
    calls = 0,
    downloads = 0;
  const updates = packaged({
    releaseUpdater: {
      async checkRelease() {
        calls++;
        if (!available) throw Error("Public feed unavailable");
        return { ...releaseCheck };
      },
      async downloadRelease() {
        downloads++;
        return installer;
      }
    }
  });
  await updates.check();
  available = false;
  await assert.rejects(updates.check(), /Public feed unavailable/);
  assert.equal(updates.status().available, false);
  assert.equal(updates.status().version, undefined);
  available = true;
  await updates.apply();
  available = false;
  const staged = await updates.check();
  assert.equal(staged.downloaded, true);
  assert.equal(staged.available, true);
  assert.equal(downloads, 1);
  assert.equal(calls, 3, "ready download does not recheck or get replaced");
});

test("signed updates separate metadata, native download and host-gated installation", async () => {
  const native = nativeUpdater();
  let preparations = 0;
  const updates = packaged({ signed: true, autoUpdater: native, beforeApply: async () => preparations++ });
  const check = await updates.check();
  assert.equal(check.installMethod, "native");
  assert.equal(native.checks, 0, "checking metadata must not start a native download");
  const downloading = updates.apply();
  await nextTurn();
  assert.equal(native.checks, 1);
  assert.equal(preparations, 0, "background download does not stop the backend");
  assert.deepEqual(native.feed, { url: releaseCheck.feedUrl, serverType: "json" });
  await assert.rejects(updates.apply(), /already running/);
  native.emit("update-available");
  assert.equal(updates.status().progress.phase, "downloading");
  native.emit("update-downloaded", {}, "notes", "1.1.0");
  const ready = await downloading;
  assert.equal(ready.phase, "ready");
  assert.equal(ready.downloaded, true);
  assert.equal(ready.installReady, false);
  assert.equal(ready.needsRelaunch, false);
  assert.equal(native.listenerCount("update-downloaded"), 0);
  assert.equal(native.listenerCount("error"), 1, "only coordinator-owned listeners are removed");
  const install = await updates.apply();
  assert.equal(preparations, 1);
  assert.equal(install.installReady, true);
  assert.equal(install.needsRelaunch, true);
  assert.equal(native.installs, 0, "the main host installs after IPC delivery");
});

test("a downloaded native update survives blocked installation and rejects renderer configuration", async () => {
  const native = nativeUpdater();
  let canInstall = false;
  const updates = packaged({
    signed: true,
    autoUpdater: native,
    beforeApply: async () => {
      if (!canInstall) throw new Error("A task is active");
    }
  });
  await updates.check();
  const download = updates.apply();
  await nextTurn();
  native.emit("update-downloaded");
  await download;
  await assert.rejects(updates.check({ channel: "preview" }), /do not accept renderer configuration/);
  assert.equal(updates.status().channel, undefined);
  await assert.rejects(updates.apply(), /task is active/);
  assert.equal(updates.status().downloaded, true);
  assert.equal(updates.status().installReady, false);
  canInstall = true;
  assert.equal((await updates.apply()).installReady, true);
  assert.equal(native.checks, 1, "installation retries reuse the staged signed update");
});

test("failed native installation preserves the download but rechecks recovered documents and tasks", async () => {
  const native = nativeUpdater();
  let draft = "initial draft";
  let savedDraft;
  let documentsWritable = true;
  let taskActive = false;
  let backendRunning = true;
  let stops = 0;
  let preparations = 0;
  const backend = {
    url: "http://127.0.0.1:43210",
    token: "fixture-native-retry",
    stop() {
      stops++;
      backendRunning = false;
    }
  };
  const task = { taskId: "fixture-task", status: "waiting", activeRunId: "fixture-run" };
  const updates = packaged({
    signed: true,
    autoUpdater: native,
    async beforeApply() {
      preparations++;
      assert.equal(backendRunning, true, "the host recovered its backend before another attempt");
      await prepareDesktopChange({
        backend,
        documents: {
          async request() {
            if (!documentsWritable) return false;
            savedDraft = draft;
            return true;
          }
        },
        fetchImpl: async (url) =>
          Response.json(
            url.endsWith("/api/tasks") ? { tasks: [task] } : { task, runtime: { active: taskActive } }
          )
      });
      backend.stop();
    }
  });
  const download = updates.apply();
  await nextTurn();
  native.emit("update-downloaded");
  await download;
  assert.equal((await updates.apply()).installReady, true);
  assert.equal(savedDraft, "initial draft");
  assert.equal(stops, 1);

  const failed = updates.installationFailed(new Error("Native installation failed"));
  assert.equal(failed.phase, "error");
  assert.equal(failed.error, "Native installation failed");
  assert.equal(failed.available, true);
  assert.equal(failed.downloaded, true);
  assert.equal(failed.installReady, false);
  assert.equal(failed.needsRelaunch, false);
  backendRunning = true;
  draft = "draft typed after backend recovery";
  documentsWritable = false;
  await assert.rejects(updates.apply(), /文档和草稿未能保存/);
  assert.equal(savedDraft, "initial draft");
  assert.equal(stops, 1);

  documentsWritable = true;
  taskActive = true;
  await assert.rejects(updates.apply(), /任务正在运行/);
  assert.equal(savedDraft, "initial draft");
  assert.equal(stops, 1);
  assert.equal(updates.status().installReady, false);
  taskActive = false;
  const retried = await updates.apply();
  assert.equal(savedDraft, "draft typed after backend recovery");
  assert.equal(preparations, 4);
  assert.equal(stops, 2);
  assert.equal(retried.installReady, true);
  assert.equal(retried.needsRelaunch, true);
  assert.equal(native.checks, 1, "a retry never downloads the staged update again");
});

test("an install-ready state cannot bypass fresh host preparation on another apply", async () => {
  const native = nativeUpdater();
  let taskActive = false;
  let preparations = 0;
  const updates = packaged({
    signed: true,
    autoUpdater: native,
    beforeApply: async () => {
      preparations++;
      if (taskActive) throw new Error("A new task is active");
    }
  });
  const download = updates.apply();
  await nextTurn();
  native.emit("update-downloaded");
  await download;
  assert.equal((await updates.apply()).installReady, true);
  taskActive = true;
  await assert.rejects(updates.apply(), /new task is active/);
  assert.equal(preparations, 2);
  assert.equal(updates.status().installReady, false);
  assert.equal(updates.status().needsRelaunch, false);
  taskActive = false;
  assert.equal((await updates.apply()).installReady, true);
  assert.equal(preparations, 3);
  assert.equal(native.checks, 1);
});

test("native failures release the operation and a metadata race does not install an absent update", async () => {
  const native = nativeUpdater();
  const updates = packaged({ signed: true, autoUpdater: native });
  await updates.check();
  let operation = updates.apply();
  await nextTurn();
  native.emit("error", new Error("Signature validation failed"));
  await assert.rejects(operation, /Signature validation/);
  assert.equal(updates.status().busy, false);
  assert.equal(updates.status().downloaded, false);
  assert.equal(native.listenerCount("update-downloaded"), 0);
  operation = updates.apply();
  await nextTurn();
  native.emit("update-not-available");
  const result = await operation;
  assert.equal(result.phase, "up-to-date");
  assert.equal(result.available, false);
  assert.equal(result.installReady, false);
});

test("native updater refuses untrusted feeds and falls back when a release has no signed feed", async () => {
  const native = nativeUpdater();
  const updates = packaged({
    signed: true,
    autoUpdater: native,
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck, feedUrl: "https://example.invalid/feed.json" })
    }
  });
  await assert.rejects(updates.apply(), /not a GitHub release asset/);
  assert.equal(native.checks, 0);
  assert.equal(native.listenerCount("update-downloaded"), 0);
  const fallback = packaged({
    signed: true,
    autoUpdater: native,
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck, feedUrl: undefined }),
      downloadRelease: async () => installer
    }
  });
  assert.equal((await fallback.apply()).installMethod, "managed");
});

test("disposing native waits removes listeners and stale UI observers cannot break updates", async () => {
  const native = nativeUpdater();
  const updates = packaged({
    signed: true,
    autoUpdater: native,
    onStatus: () => {
      throw new Error("Renderer is closed");
    }
  });
  await updates.check();
  const download = updates.apply();
  await nextTurn();
  updates.dispose();
  await assert.rejects(download, /disposed/);
  assert.equal(native.listenerCount("update-downloaded"), 0);
  assert.equal(native.listenerCount("error"), 1);
  await assert.rejects(updates.check(), /disposed/);
  await assert.rejects(updates.apply(), /disposed/);
});

test("unsupported packaged platforms fail before contacting a release service", async () => {
  let calls = 0;
  const updates = packaged({
    platform: "linux",
    releaseUpdater: { checkRelease: async () => calls++ }
  });
  await assert.rejects(updates.check(), /macOS only/);
  assert.equal(calls, 0);
  assert.equal(updates.status().busy, false);
});

test("quitting aborts release downloads and waits for partial cleanup without staging or preparing", async () => {
  let started,
    cleaned = false,
    stages = 0,
    prepared = 0;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const updates = packaged({
    managedInstaller: { stage: async () => stages++ },
    beforeApply: async () => prepared++,
    releaseUpdater: {
      checkRelease: async ({ signal }) => {
        assert.ok(signal instanceof AbortSignal);
        return { ...releaseCheck };
      },
      downloadRelease: async ({ signal }) => {
        assert.ok(signal instanceof AbortSignal);
        started();
        try {
          await new Promise((resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          );
        } finally {
          await nextTurn();
          cleaned = true;
        }
      }
    }
  });
  const download = updates.apply();
  const rejected = assert.rejects(download, /abort/i);
  await began;
  await updates.dispose();
  await rejected;
  assert.equal(cleaned, true);
  assert.equal(stages, 0);
  assert.equal(prepared, 0);
  assert.equal(updates.status().downloaded, false);
});
test("a late non-cooperative download cannot stage after the updater was disposed", async () => {
  const gate = deferred();
  let started,
    stages = 0;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const updates = packaged({
    managedInstaller: { stage: async () => stages++ },
    releaseUpdater: {
      checkRelease: async () => ({ ...releaseCheck }),
      downloadRelease: async () => {
        started();
        await gate.promise;
        return installer;
      }
    }
  });
  const download = updates.apply();
  const rejected = assert.rejects(download, /disposed/);
  await began;
  let disposed = false;
  const close = updates.dispose().then(() => {
    disposed = true;
  });
  await nextTurn();
  assert.equal(disposed, false);
  gate.resolve();
  await close;
  await rejected;
  assert.equal(stages, 0);
});

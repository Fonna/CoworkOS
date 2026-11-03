import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { createDesktopSpeechInput } = require("../desktop/speech-input.cjs");
const macOnly = process.platform === "darwin" ? false : "macOS Swift/Speech framework is required";
const compilationTimeout = 180_000;
let builderPrefix, builderFixture;

function actualBuilderFixture() {
  builderFixture ??= (async () => {
    // Clang PCM files embed absolute module-cache paths. Keep one canonical
    // cache from this actual build; relocating or symlinking it duplicates SDK
    // modules. Protocol compilation reuses only these system modules.
    builderPrefix = await realpath(await mkdtemp(join(tmpdir(), "atria-speech-helper-")));
    const source = join(builderPrefix, "src/gui/macos-speech.swift");
    const build = join(builderPrefix, "scripts/build-speech-input.mjs");
    const binary = join(builderPrefix, "dist/src/gui/atria-speech-input");
    for (const file of [source, build]) await mkdir(dirname(file), { recursive: true });
    await copyFile(resolve("src/gui/macos-speech.swift"), source);
    await copyFile(resolve("scripts/build-speech-input.mjs"), build);
    await assert.rejects(stat(binary), { code: "ENOENT" });
    await run(process.execPath, [build], { cwd: builderPrefix, timeout: compilationTimeout });
    return {
      prefix: builderPrefix,
      build,
      binary,
      sdkModuleCache: await realpath(join(builderPrefix, ".tmp/speech-input-build/modules"))
    };
  })();
  return builderFixture;
}

after(async () => {
  // Keep the SDK cache until both tests and all their owned processes settle.
  await builderFixture?.catch(() => {});
  if (builderPrefix) await rm(builderPrefix, { recursive: true, force: true });
});

/** execFile's timeout kills only the wrapper, leaving swiftc descendants alive.
 * Own a process group and complete escalation even if its leader closes early. */
function run(command, args, { cwd, env, timeout = 10_000, killGrace = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure,
      cleanup;
    const signal = (value) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, value);
        else child.kill(value);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const terminate = (error) => {
      if (cleanup) return;
      failure = error;
      cleanup = (async () => {
        signal("SIGTERM");
        await delay(killGrace);
        // The leader may exit first while a compiler has ignored SIGTERM.
        signal("SIGKILL");
      })();
      // close awaits and reports this promise; avoid an unhandled rejection
      // while descendants still hold the inherited stdout/stderr pipes.
      cleanup.catch(() => {});
    };
    const timer = setTimeout(
      () =>
        terminate(
          Object.assign(new Error(`Command timed out after ${timeout}ms: ${command}`), {
            code: "ETIMEDOUT",
            killed: true
          })
        ),
      timeout
    );
    const collect = (field, chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        terminate(
          Object.assign(new Error(`Command output exceeded 1 MiB: ${command}`), {
            code: "ERR_CHILD_OUTPUT_LIMIT",
            killed: true
          })
        );
        return;
      }
      if (field === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signalName) => {
      clearTimeout(timer);
      void (async () => {
        try {
          await cleanup;
        } catch (error) {
          failure ??= error;
        }
        if (failure || code !== 0) {
          const error = failure ?? Object.assign(new Error(`Command failed: ${command}`), { code });
          reject(Object.assign(error, { stdout, stderr, signal: signalName, pid: child.pid }));
        } else resolve({ stdout, stderr });
      })();
    });
  });
}

test(
  "speech test command timeout reaps its wrapper and TERM-resistant descendants",
  { skip: process.platform === "win32" ? "POSIX process-group cleanup" : false, timeout: 15_000 },
  async (t) => {
    const prefix = await mkdtemp(join(tmpdir(), "atria-speech-timeout-"));
    const pids = join(prefix, "pids.json");
    const leaf = `process.on('SIGTERM',()=>{});process.send({pid:process.pid});setInterval(()=>{},1000);`;
    const middle = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',value=>process.send({pid:process.pid,leaf:value.pid}));setInterval(()=>{},1000);`;
    const wrapper = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',value=>fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify({wrapper:process.pid,...value})));setInterval(()=>{},1000);`;
    let owned;
    t.after(async () => {
      if (owned) {
        try {
          process.kill(-owned.wrapper, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await rm(prefix, { recursive: true, force: true });
    });
    await assert.rejects(run(process.execPath, ["-e", wrapper], { timeout: 2000 }), (error) => {
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.killed, true);
      return true;
    });
    owned = JSON.parse(await readFile(pids, "utf8"));
    assert.equal(new Set(Object.values(owned)).size, 3, "all three fixture processes started");
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return false;
      }
    };
    const deadline = Date.now() + 5000;
    while (Object.values(owned).some(alive) && Date.now() < deadline) await delay(20);
    assert.equal(Object.values(owned).some(alive), false, "timeout must not leave a child or grandchild");
  }
);

function embeddedInfo(binary) {
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf, "expected a native little-endian Mach-O");
  let command = 32;
  for (let index = 0; index < binary.readUInt32LE(16); index++) {
    if (binary.readUInt32LE(command) === 0x19) {
      for (let section = 0; section < binary.readUInt32LE(command + 64); section++) {
        const position = command + 72 + section * 80;
        if (
          binary
            .subarray(position, position + 16)
            .toString()
            .replace(/\0.*$/, "") !== "__info_plist"
        )
          continue;
        const offset = binary.readUInt32LE(position + 48);
        const size = Number(binary.readBigUInt64LE(position + 40));
        return binary.subarray(offset, offset + size).toString("utf8");
      }
    }
    command += binary.readUInt32LE(command + 4);
  }
  throw new Error("native helper is missing its embedded permission descriptions");
}

test(
  "Mac speech helper builds, relocates and reports status without requesting permission or audio",
  { skip: macOnly, timeout: 300_000 },
  async (t) => {
    const { prefix, build, binary } = await actualBuilderFixture();
    const initial = await stat(binary);
    const bytes = await readFile(binary);
    assert.notEqual(initial.mode & 0o111, 0);
    // A cache hit must leave the compiled executable intact, even from another cwd.
    await run(process.execPath, [build], { cwd: tmpdir(), timeout: 10_000 });
    assert.equal((await stat(binary)).mtimeMs, initial.mtimeMs);
    assert.deepEqual(await readFile(binary), bytes);
    const info = embeddedInfo(bytes);
    assert.match(info, /<key>NSMicrophoneUsageDescription<\/key><string>[^<]+<\/string>/);
    assert.match(info, /<key>NSSpeechRecognitionUsageDescription<\/key><string>[^<]*Apple[^<]*<\/string>/);
    assert.match(info, /org\.atria\.cowork\.speech-input/);
    const signature = await run("/usr/bin/codesign", ["-d", "--entitlements", "-", binary]);
    assert.match(signature.stdout, /com\.apple\.security\.device\.audio-input/);
    await run("/usr/bin/codesign", ["--verify", "--strict", binary]);
    const moved = join(prefix, "relocated", "atria-speech-input");
    await mkdir(dirname(moved));
    await copyFile(binary, moved);
    await run("/usr/bin/codesign", ["--verify", "--strict", moved]);

    const inspect = async () => {
      const { stdout } = await run(moved, ["--status", "--locale", "zh-CN"], { timeout: 10_000 });
      assert.equal(stdout.trim().split("\n").length, 1);
      const value = JSON.parse(stdout);
      for (const field of ["supported", "available", "localRecognitionAvailable", "inputAvailable"])
        assert.equal(typeof value[field], "boolean", field);
      assert.equal(value.audioCaptureStarted, false);
      assert.equal(value.locale, "zh-CN");
      for (const field of ["authorizationStatus", "microphoneStatus"])
        assert.ok(["authorized", "denied", "restricted", "not-determined", "unknown"].includes(value[field]));
      assert.equal(value.mode, value.localRecognitionAvailable ? "on-device" : "apple-network");
      return value;
    };
    const before = await inspect();
    // Every --listen case is invalid before authorization; never run a valid
    // production recording command in this test, even when permissions exist.
    for (const args of [
      [],
      ["--status", "--listen"],
      ["--listen", "--locale"],
      ["--listen", "--locale", "zh-CN/../../tmp"],
      ["--listen", "--locale", "zh-CN\n"],
      ["--listen", "--locale", "x".repeat(36)],
      ["--status", "--locale", "zh_CN"]
    ]) {
      await assert.rejects(run(moved, args, { timeout: 5000 }), (error) => {
        assert.equal(error.code, 2);
        const events = error.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(
          events.map((event) => event.type),
          ["error", "ended"]
        );
        assert.equal(events[0].code, "invalid_arguments");
        assert.equal(events[1].reason, "error");
        return true;
      });
    }
    const unsupported = JSON.parse((await run(moved, ["--status", "--locale", "zz-ZZ"])).stdout);
    assert.equal(unsupported.supported, false);
    assert.equal(unsupported.audioCaptureStarted, false);
    assert.equal(unsupported.code, "unsupported_locale");
    const after = await inspect();
    assert.equal(after.authorizationStatus, before.authorizationStatus);
    assert.equal(after.microphoneStatus, before.microphoneStatus);
  }
);

test(
  "actual Swift final Chinese/emoji and error events are consumed by the desktop host without audio",
  { skip: macOnly, timeout: 300_000 },
  async (t) => {
    const prefix = await mkdtemp(join(tmpdir(), "atria-speech-protocol-"));
    t.after(() => rm(prefix, { recursive: true, force: true }));
    const { sdkModuleCache } = await actualBuilderFixture();
    const probe = join(prefix, "protocol-helper");
    await run(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-target",
        `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
        "-swift-version",
        "5",
        "-parse-as-library",
        "-D",
        "SPEECH_PROTOCOL_TEST",
        "-O",
        "-module-cache-path",
        sdkModuleCache,
        resolve("src/gui/macos-speech.swift"),
        "-o",
        probe
      ],
      { timeout: compilationTimeout }
    );
    // The compile-only entry point uses the production event constructors and
    // cannot query authorization or start a recognizer/audio engine.
    const wire = (await run(probe, [])).stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(wire, [
      { type: "started", locale: "zh-cn", mode: "on-device" },
      { type: "result", transcript: "协议测试，中文和 emoji 🎙️。", final: true },
      { type: "ended", reason: "completed" }
    ]);
    for (const flags of [[], ["--network"], ["--error"]]) {
      const events = [];
      let resolveEnded;
      const ended = new Promise((resolve) => {
        resolveEnded = resolve;
      });
      const host = createDesktopSpeechInput({
        appRoot: prefix,
        development: true,
        env: { COWORK_SPEECH_INPUT_EXECUTABLE: probe },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "ended") resolveEnded();
        },
        spawnProcess: (executable, args, options) => {
          // Fail closed if this fixture could ever start the recording binary.
          assert.equal(executable, probe);
          return spawn(executable, [...args, ...flags], options);
        },
        startupTimeout: 5000,
        sessionTimeout: 8000
      });
      try {
        assert.equal(await host.start({ sessionId: "native-protocol" }), true);
        await ended;
        await host.dispose();
        assert.deepEqual(
          events.map((event) => event.type),
          ["started", flags.includes("--error") ? "error" : "result", "ended"]
        );
        assert.equal(events[0].locale, "zh-CN");
        assert.equal(events[0].mode, flags.includes("--network") ? "apple-network" : "on-device");
        if (flags.includes("--error")) assert.equal(events[1].code, "no_speech");
        else {
          assert.equal(events[1].transcript, "协议测试，中文和 emoji 🎙️。");
          assert.equal(events[1].final, true);
        }
        assert.equal(
          events.some((event) => event.code === "invalid_response"),
          false
        );
      } finally {
        await host.dispose();
      }
    }
  }
);

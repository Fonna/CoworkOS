import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { createDesktopSpeechInput } = require("../desktop/speech-input.cjs");
const run = promisify(execFile);
// The real Swift helper normalizes BCP47 locale identifiers to lowercase.
const started = { type: "started", locale: "zh-cn", mode: "on-device" };

function fixture(t, options = {}) {
  const events = [],
    children = [],
    calls = [];
  const host = createDesktopSpeechInput({
    appRoot: "/fixture/app",
    platform: "darwin",
    onEvent: (event) => events.push(event),
    executableAccess: async () => {},
    startupTimeout: 1000,
    sessionTimeout: 2000,
    stopTimeout: 30,
    terminationDelay: 2,
    killDelay: 10,
    spawnProcess: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.commands = "";
      child.stdin.on("data", (chunk) => {
        child.commands += chunk.toString();
      });
      child.kill = (signal) => {
        child.signal = signal;
        queueMicrotask(() => child.emit("close", null, signal));
        return true;
      };
      child.event = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
      children.push(child);
      return child;
    },
    ...options
  });
  t.after(() => host.dispose());
  return { host, events, children, calls };
}

test("desktop speech routes one final result and ends, keeping model credentials out of the helper", async (t) => {
  const { host, events, children, calls } = fixture(t, {
    env: {
      PATH: "/fixture/bin",
      HOME: "/fixture/home",
      COWORK_API_KEY: "fixture-only",
      NODE_OPTIONS: "fixture-only"
    }
  });
  assert.equal(await host.start({ sessionId: "voice-17234567890-1" }), true);
  assert.equal(calls[0][0], "/fixture/app/dist/src/gui/atria-speech-input");
  assert.deepEqual(calls[0][1], ["--listen", "--locale", "zh-CN"]);
  assert.deepEqual(calls[0][2].env, { PATH: "/fixture/bin", HOME: "/fixture/home" });
  assert.equal(calls[0][2].detached, undefined);
  const child = children[0];
  child.event(started);
  assert.deepEqual(events[0], {
    sessionId: "voice-17234567890-1",
    type: "started",
    locale: "zh-CN",
    mode: "on-device"
  });
  assert.equal(host.stop({ sessionId: "voice-17234567890-1" }), true);
  assert.equal(child.commands, "stop\n");
  child.event({ type: "result", transcript: "这是一段测试文字", final: true, unrelated: "discarded" });
  child.event({ type: "result", transcript: "重复结果", final: true });
  child.event({ type: "ended", reason: "completed" });
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "result", "ended"]
  );
  assert.deepEqual(events[1], {
    sessionId: "voice-17234567890-1",
    type: "result",
    transcript: "这是一段测试文字",
    final: true
  });
  assert.equal(await host.start({ sessionId: "voice-17234567890-1" }), false);
});

test("Apple helper locale spelling is normalized for both recognition modes", async (t) => {
  for (const locale of ["zh-cn", "zh_CN", "zh-CN"]) {
    const { host, events, children } = fixture(t);
    await host.start({ sessionId: `locale-${locale}` });
    children[0].event({ type: "started", locale, mode: "apple-network" });
    assert.equal(events[0].locale, "zh-CN");
    assert.equal(events[0].mode, "apple-network");
    children[0].event({ type: "result", transcript: "规范化语言测试", final: true });
    children[0].event({ type: "ended", reason: "completed" });
    assert.deepEqual(
      events.map((event) => event.type),
      ["started", "result", "ended"]
    );
  }
});

test("cancel during executable preparation prevents a late native start and cancel-before-start is remembered", async (t) => {
  let ready;
  const { host, events, calls } = fixture(t, {
    executableAccess: () =>
      new Promise((resolve) => {
        ready = resolve;
      })
  });
  const pending = host.start({ sessionId: "pending-a" });
  await Promise.resolve();
  host.cancel({ sessionId: "pending-a" });
  ready();
  assert.equal(await pending, false);
  assert.deepEqual(events, [{ sessionId: "pending-a", type: "ended", reason: "cancelled" }]);
  assert.equal(calls.length, 0);
  host.cancel({ sessionId: "before-start" });
  assert.equal(await host.start({ sessionId: "before-start" }), false);
  assert.equal(calls.length, 0);
});

test("only one process listens, and cancellation drops late text before the next session", async (t) => {
  const { host, events, children } = fixture(t);
  await host.start({ sessionId: "first" });
  children[0].event(started);
  await assert.rejects(host.start({ sessionId: "busy" }), /已有语音输入/);
  assert.equal(host.stop({ sessionId: "another" }), false);
  host.cancel({ sessionId: "first" });
  const next = host.start({ sessionId: "second" });
  children[0].event({ type: "result", transcript: "迟到文字", final: true });
  assert.equal(await next, true);
  assert.equal(children.length, 2);
  assert.equal(children[0].signal, "SIGTERM");
  children[1].event(started);
  children[1].event({ type: "result", transcript: "当前会话文字", final: true });
  children[1].event({ type: "ended", reason: "completed" });
  assert.deepEqual(
    events.filter((event) => event.type === "result").map((event) => event.transcript),
    ["当前会话文字"]
  );
});

test("stop watchdog ends a recognizer that never returns a result", async (t) => {
  const { host, events, children } = fixture(t);
  await host.start({ sessionId: "hung-stop" });
  children[0].event(started);
  host.stop({ sessionId: "hung-stop" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "error", "ended"]
  );
  assert.equal(events[1].code, "recognition_timeout");
  assert.equal(children[0].signal, "SIGTERM");
});

test("startup and whole-session watchdogs recover a silent helper", async (t) => {
  for (const phase of ["startup", "session"]) {
    const { host, events, children } = fixture(t, { startupTimeout: 20, sessionTimeout: 30 });
    await host.start({ sessionId: phase });
    if (phase === "session") children[0].event(started);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.at(-2).code, "recognition_timeout");
    assert.equal(events.at(-1).type, "ended");
  }
});

test("missing helper and abnormal exits report friendly errors and allow another session", async (t) => {
  const missing = fixture(t, {
    executableAccess: async () => {
      throw Object.assign(new Error("fixture"), { code: "ENOENT" });
    }
  });
  assert.equal(await missing.host.start({ sessionId: "missing" }), false);
  assert.equal(missing.events[0].code, "helper_missing");
  assert.equal(missing.events[1].type, "ended");
  const { host, events, children } = fixture(t);
  await host.start({ sessionId: "crashed" });
  children[0].emit("close", 1);
  assert.equal(events[0].code, "helper_failed");
  assert.equal(await host.start({ sessionId: "retry" }), true);
});

test("permission denial is specific and never forwards arbitrary helper fields", async (t) => {
  const { host, events, children } = fixture(t);
  await host.start({ sessionId: "denied" });
  children[0].event({
    type: "error",
    code: "speech_denied",
    message: "fixture internal path",
    transcript: "ignored"
  });
  assert.equal(events[0].code, "speech_denied");
  assert.match(events[0].message, /语音识别.*系统设置/);
  assert.equal(events[0].transcript, undefined);
  assert.equal(events[0].message.includes("fixture"), false);
  assert.equal(events[1].type, "ended");
});

test("malformed, excessive and empty responses fail closed without appending text", async (t) => {
  for (const [id, line, expected] of [
    ["json", "plain fixture text\n", "invalid_response"],
    ["unknown", JSON.stringify({ type: "other" }) + "\n", "invalid_response"],
    ["size", "x".repeat(128 * 1024 + 1), "response_limit"],
    [
      "text",
      JSON.stringify({ type: "result", transcript: "x".repeat(16_001), final: true }) + "\n",
      "response_limit"
    ],
    ["empty", JSON.stringify({ type: "result", transcript: "  ", final: true }) + "\n", "no_speech"]
  ]) {
    const { host, events, children } = fixture(t);
    await host.start({ sessionId: id });
    children[0].event(started);
    children[0].stdout.write(line);
    assert.equal(events.at(-2).code, expected);
    assert.equal(events.at(-1).type, "ended");
    assert.equal(
      events.some((event) => event.type === "result"),
      false
    );
  }
});

test("platform, session IDs, stop-before-spawn and dispose are bounded", async (t) => {
  const { host, calls } = fixture(t);
  for (const sessionId of ["", "x".repeat(81), "space id", "slash/id", "line\nbreak"])
    await assert.rejects(host.start({ sessionId }), /无效/);
  assert.throws(() => host.cancel({ sessionId: "bad id" }), /无效/);
  const pending = host.start({ sessionId: "stop-before-spawn" });
  host.stop({ sessionId: "stop-before-spawn" });
  assert.equal(await pending, false);
  assert.equal(calls.length, 0);
  await host.dispose();
  await assert.rejects(host.start({ sessionId: "after-dispose" }), /关闭/);
  await assert.rejects(fixture(t, { platform: "linux" }).host.start({ sessionId: "linux" }), /Mac/);
});

test("executable override is accepted only in the development profile", async (t) => {
  for (const development of [false, true]) {
    const { host, calls } = fixture(t, {
      development,
      env: { COWORK_SPEECH_INPUT_EXECUTABLE: "/fixture/mock" }
    });
    await host.start({ sessionId: "path-check" });
    assert.equal(calls[0][0], development ? "/fixture/mock" : "/fixture/app/dist/src/gui/atria-speech-input");
  }
});

test("real disposable helper process receives stop and is reaped on dispose without audio", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-speech-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "fake-speech");
  const commands = join(directory, "commands.txt");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const readline=require('node:readline');const emit=value=>console.log(JSON.stringify(value));emit({type:'started',locale:'zh-CN',mode:'on-device'});readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(${JSON.stringify(commands)},line+'\\n');if(line==='stop'){emit({type:'result',transcript:'假识别结果',final:true});emit({type:'ended',reason:'completed'});process.exit(0);}else if(line==='cancel'){emit({type:'ended',reason:'cancelled'});process.exit(0);}});`,
    { mode: 0o700 }
  );
  const events = [];
  const host = createDesktopSpeechInput({
    appRoot: directory,
    development: true,
    env: { PATH: process.env.PATH, COWORK_SPEECH_INPUT_EXECUTABLE: executable },
    platform: "darwin",
    onEvent: (event) => events.push(event)
  });
  t.after(() => host.dispose());
  assert.equal(await host.start({ sessionId: "real-fake" }), true);
  const deadline = Date.now() + 3000;
  while (!events.some((event) => event.type === "started") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events[0]?.type, "started");
  host.stop({ sessionId: "real-fake" });
  while (!events.some((event) => event.type === "ended") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await host.dispose();
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "result", "ended"]
  );
  assert.equal((await readFile(commands, "utf8")).startsWith("stop\n"), true);
});

test(
  "Mac release and development metadata declare both privacy purposes and preserve existing signing capabilities",
  { skip: process.platform !== "darwin" },
  async () => {
    const config = require("../electron-builder.config.cjs");
    assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /语音输入/);
    assert.match(config.mac.extendInfo.NSSpeechRecognitionUsageDescription, /Apple/);
    assert.equal(config.mac.entitlements, config.mac.entitlementsInherit);
    const { stdout } = await run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      resolve(config.mac.entitlements)
    ]);
    const entitlements = JSON.parse(stdout);
    for (const key of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.audio-input"
    ])
      assert.equal(entitlements[key], true);
    const { developmentExecutable } = await import("../scripts/desktop-dev.mjs");
    const executable = await developmentExecutable();
    const plist = join(executable, "../../Info.plist");
    for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"])
      assert.match((await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout, /CoworkOS/);
    const signature = await run("/usr/bin/codesign", [
      "-d",
      "--entitlements",
      "-",
      resolve(executable, "../../..")
    ]);
    assert.match(signature.stdout, /com\.apple\.security\.device\.audio-input/);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", resolve(executable, "../../..")]);
  }
);

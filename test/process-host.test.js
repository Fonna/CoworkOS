import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { ProcessHost } from "../dist/src/runtime/process-host.js";

test("process ownership refuses duplicates and drains child process groups on shutdown", async () => {
  const host = new ProcessHost();
  const child = host.start(
    "task",
    process.execPath,
    ["-e", `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)`],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  child.on("error", () => {});
  const closed = once(child, "close");
  await once(child.stdout, "data");
  assert.throws(() => host.start("task", process.execPath, [], {}), /already active/);
  await host.stop(20);
  await closed;
  assert.notEqual(child.signalCode, null);
  assert.throws(() => host.start("next", process.execPath, [], {}), /shutting down/);
});

test(
  "a wrapper exiting before its descendants still has its process group cleaned up",
  { skip: process.platform === "win32" },
  async () => {
    const host = new ProcessHost();
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); console.log(child.pid); setTimeout(()=>process.exit(),150);`;
    const wrapper = host.start("wrapper", process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const exited = once(wrapper, "close");
    const [chunk] = await once(wrapper.stdout, "data");
    const pid = Number(String(chunk).trim());
    await exited;
    try {
      await host.stop(20);
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      assert.fail("descendant remained alive after shutdown");
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
);

test("stopping one task kills an uncooperative process and leaves another task running", async () => {
  const host = new ProcessHost();
  const args = ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"];
  const first = host.start("first", process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const other = host.start("other", process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await Promise.all([once(first.stdout, "data"), once(other.stdout, "data")]);
    await Promise.all([host.stopKey("first", 25), host.stopKey("first", 25)]);
    assert.notEqual(first.signalCode, null);
    assert.equal(other.signalCode, null);
    const next = host.start("next", process.execPath, ["-e", "console.log('next')"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    await once(next, "close");
    assert.equal(next.exitCode, 0);
  } finally {
    await host.stop(25);
  }
});

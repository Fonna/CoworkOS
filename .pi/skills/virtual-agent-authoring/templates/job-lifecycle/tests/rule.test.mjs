import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import check, { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

async function jobFixture(t) {
  const lab = await fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  let clock = Date.now() + 100;
  const logPath = join(lab.directory, "train.log");
  await writeFile(logPath, "training started\n");
  const record = {
    jobId: "job-1",
    command: "training",
    cwd: lab.directory,
    pid: child.pid,
    startedAt: new Date(clock - 1_000).toISOString(),
    logPath
  };
  await lab.write(record);
  return {
    lab,
    child,
    record,
    logPath,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    }
  };
}

test("a real running job stays quiet; silence is reported once and recovery permits a later incident", async (t) => {
  const { lab, logPath, now, advance } = await jobFixture(t);
  let rule = createWatcher({ quietAfterMs: 60_000, now });
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.poll(rule), []);
  advance(61_000);
  const [first] = await lab.poll(rule);
  assert.equal(first.type, "job.quiet");
  assert.equal(first.payload.status, "running");
  assert.deepEqual(await lab.poll(rule), []);
  await utimes(logPath, new Date(now()), new Date(now()));
  // New factory instance, same on-disk state: a restart cannot replay the alert.
  rule = createWatcher({ quietAfterMs: 60_000, now });
  assert.deepEqual(await lab.poll(rule), []);
  advance(61_000);
  const [second] = await lab.poll(rule);
  assert.notEqual(second.dedupeKey, first.dedupeKey);
});

for (const exitCode of [0, 7]) {
  test(`recorded exit ${exitCode} produces evidence once`, async (t) => {
    const { lab, record, now } = await jobFixture(t);
    const rule = createWatcher({ now });
    await lab.poll(rule);
    await lab.write({ ...record, finishedAt: new Date(now()).toISOString(), exitCode });
    const [event] = await lab.poll(rule);
    assert.equal(event.type, "job.finished");
    assert.equal(event.payload.exitCode, exitCode);
    assert.deepEqual(await lab.poll(createWatcher({ now })), []);
  });
}

test("a disappeared process has an unknown exit, never a fabricated success", async (t) => {
  const { lab, child, now } = await jobFixture(t);
  const rule = createWatcher({ now });
  await lab.poll(rule);
  child.kill();
  await once(child, "exit");
  const [event] = await lab.poll(rule);
  assert.equal(event.type, "job.unobserved_exit");
  assert.equal(event.payload.exitCode, undefined);
});

test("a new run identity establishes a new baseline", async (t) => {
  const { lab, record, now } = await jobFixture(t);
  const rule = createWatcher({ now });
  await lab.poll(rule);
  await lab.write({ ...record, jobId: "job-2", startedAt: new Date(now()).toISOString() });
  assert.deepEqual(await lab.poll(rule), []);
});

test("a job already silent at registration is reported on the next check", async (t) => {
  const { lab, now, advance } = await jobFixture(t);
  advance(61_000);
  const rule = createWatcher({ quietAfterMs: 60_000, now });
  assert.deepEqual(await lab.poll(rule), []);
  assert.equal((await lab.poll(rule))[0].type, "job.quiet");
  assert.deepEqual(await lab.poll(rule), []);
});

test("invalid, absent and oversized records fail without advancing state", async (t) => {
  const lab = await fixture(t);
  await assert.rejects(lab.poll(check), /ENOENT/);
  for (const data of ["{", "null", { jobId: "job-1" }, " ".repeat(32_769)]) {
    await lab.write(data);
    await assert.rejects(lab.poll(check));
  }
  await assert.rejects(lab.poll(createWatcher({ quietAfterMs: 0 })), /configuration|quietAfterMs/);
});

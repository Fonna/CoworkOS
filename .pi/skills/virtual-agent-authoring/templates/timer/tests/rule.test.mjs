import assert from "node:assert/strict";
import { test } from "node:test";
import check, { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

const START = Date.parse("2026-10-10T00:00:00Z");

test("a one-shot fires at its deadline, once, including after a restart", async (t) => {
  const lab = await fixture(t, "clock");
  let clock = START - 1;
  const config = { startAt: new Date(START).toISOString(), now: () => clock };
  const rule = createWatcher(config);
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.poll(rule), []);
  clock = START;
  const [event] = await lab.poll(rule);
  assert.equal(event.type, "timer.due");
  assert.equal(event.payload.scheduledAt, config.startAt);
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
});

test("recurrence is anchored; downtime coalesces missed ticks and clock rollback cannot replay them", async (t) => {
  const lab = await fixture(t, "clock");
  let clock = START - 1;
  const config = { startAt: new Date(START).toISOString(), intervalMs: 60_000, now: () => clock };
  await lab.poll(createWatcher(config));
  clock = START + 180_000;
  const [event] = await lab.poll(createWatcher(config));
  assert.equal(event.payload.skippedIntervals, 3);
  assert.equal(event.payload.scheduledAt, new Date(clock).toISOString());
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
  clock = START + 120_000;
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
  clock = START + 240_000;
  assert.notEqual((await lab.poll(createWatcher(config)))[0].dedupeKey, event.dedupeKey);
});

test("registration establishes the current interval baseline; expiry permanently stops triggers", async (t) => {
  const lab = await fixture(t, "clock");
  let clock = START + 120_000;
  const config = {
    startAt: new Date(START).toISOString(),
    intervalMs: 60_000,
    endAt: new Date(START + 180_000).toISOString(),
    now: () => clock
  };
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
  clock = START + 180_000;
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
  assert.equal((await lab.readState()).finished, true);
  clock = START + 150_000;
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
});

test("invalid configuration and already-due one-shots are refused", async (t) => {
  const lab = await fixture(t, "clock");
  await assert.rejects(lab.poll(check), /configuration/);
  for (const config of [
    { startAt: "bad" },
    { startAt: new Date(START).toISOString(), now: () => START },
    { startAt: new Date(START).toISOString(), intervalMs: 1 },
    { startAt: new Date(START).toISOString(), endAt: "bad" },
    { startAt: new Date(START).toISOString(), endAt: new Date(START - 1).toISOString() }
  ])
    await assert.rejects(lab.poll(createWatcher(config)));
});

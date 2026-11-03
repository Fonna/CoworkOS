import assert from "node:assert/strict";
import { test } from "node:test";
import check, { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

const START = Date.parse("2026-10-10T00:00:00Z");
const config = { metric: "loss", unit: "ratio", threshold: 10, clearThreshold: 8, consecutiveSamples: 2 };
function sample(value, time = START, extra = {}) {
  return { metric: "loss", unit: "ratio", value, observedAt: new Date(time).toISOString(), ...extra };
}

test("only independent consecutive samples alert; hysteresis and restart prevent duplicates", async (t) => {
  const lab = await fixture(t);
  const now = () => START + 100_000;
  let rule = createWatcher({ ...config, now });
  await lab.write(sample(1));
  assert.deepEqual(await lab.poll(rule), []);
  await lab.write(sample(11, START + 1_000));
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.poll(rule), [], "polling one sample twice cannot satisfy the streak");
  await lab.write(sample(12, START + 2_000));
  const [first] = await lab.poll(rule);
  assert.equal(first.type, "metric.threshold");
  rule = createWatcher({ ...config, now });
  assert.deepEqual(await lab.poll(rule), []);
  await lab.write(sample(9, START + 3_000));
  assert.deepEqual(await lab.poll(rule), [], "near-threshold noise leaves the alert latched");
  await lab.write(sample(7, START + 4_000));
  await lab.poll(rule);
  await lab.write(sample(12, START + 5_000));
  await lab.poll(rule);
  await lab.write(sample(11, START + 6_000));
  const [second] = await lab.poll(rule);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
});

test("below thresholds work and out-of-order samples do not change the streak", async (t) => {
  const lab = await fixture(t);
  const rule = createWatcher({
    ...config,
    direction: "below",
    clearThreshold: 12,
    now: () => START + 100_000
  });
  await lab.write(sample(15));
  await lab.poll(rule);
  await lab.write(sample(8, START + 3_000));
  await lab.poll(rule);
  const before = await lab.readState();
  await lab.write(sample(15, START + 2_000));
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.readState(), before);
  await lab.write(sample(7, START + 4_000));
  assert.equal((await lab.poll(rule))[0].payload.direction, "below");
});

test("initial matching data is a baseline, and a policy change resets the streak", async (t) => {
  const lab = await fixture(t);
  const now = () => START + 100_000;
  await lab.write(sample(11));
  assert.deepEqual(await lab.poll(createWatcher({ ...config, consecutiveSamples: 1, now })), []);
  await lab.write(sample(20, START + 1_000));
  assert.deepEqual(await lab.poll(createWatcher({ ...config, threshold: 15, now })), []);
});

test("malformed, mismatched, stale and future samples fail without cursor advancement", async (t) => {
  const lab = await fixture(t);
  const rule = createWatcher({ ...config, maxAgeMs: 5_000, now: () => START });
  await lab.write(sample(1));
  await lab.poll(rule);
  for (const data of [
    "{",
    "null",
    sample(null),
    sample(1, START, { unit: "percent" }),
    sample(1, START - 6_000),
    sample(1, START + 1),
    " ".repeat(16_385)
  ]) {
    await lab.write(data);
    await assert.rejects(lab.poll(rule));
  }
  await assert.rejects(lab.poll(check), /configuration/);
});

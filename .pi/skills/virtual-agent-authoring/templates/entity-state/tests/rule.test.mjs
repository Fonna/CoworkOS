import assert from "node:assert/strict";
import { test } from "node:test";
import check, { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

const START = Date.parse("2026-10-10T00:00:00Z");
const config = { entityId: "order-1", targetStates: ["filled"], now: () => START + 100_000 };
const snapshot = (status, revision, time = START) => ({
  id: "order-1",
  status,
  revision,
  observedAt: new Date(time).toISOString()
});

test("state transitions, higher revisions with unchanged status, re-entry and restart", async (t) => {
  const lab = await fixture(t, "https://example.test/order/1");
  const rule = createWatcher(config);
  lab.response(snapshot("open", 1));
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(snapshot("filled", 2));
  const [first] = await lab.poll(rule);
  assert.equal(first.payload.previousStatus, "open");
  assert.deepEqual(await lab.poll(createWatcher(config)), []);
  lab.response(snapshot("filled", 3));
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(snapshot("open", 4));
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(snapshot("filled", 5));
  const [second] = await lab.poll(rule);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
});

test("an existing target state is a baseline; stale revisions and older observations are ignored", async (t) => {
  const lab = await fixture(t, "https://example.test/order/1");
  const rule = createWatcher(config);
  lab.response(snapshot("filled", 3, START + 2_000));
  assert.deepEqual(await lab.poll(rule), []);
  const before = await lab.readState();
  lab.response(snapshot("open", 2, START + 3_000));
  assert.deepEqual(await lab.poll(rule), []);
  lab.response(snapshot("open", 4, START + 1_000));
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.readState(), before);
});

test("disappearance, source failures, conflicting revisions and malformed snapshots cannot fabricate transitions", async (t) => {
  const lab = await fixture(t, "https://example.test/order/1");
  const rule = createWatcher(config);
  lab.response(snapshot("open", 1));
  await lab.poll(rule);
  for (const value of [
    "{",
    "null",
    { ...snapshot("filled", 2), id: "another" },
    snapshot("filled", 1),
    snapshot("filled", 2, START - 400_000),
    snapshot("filled", 2, START + 200_000)
  ]) {
    lab.response(value);
    await assert.rejects(lab.poll(rule));
  }
  lab.response({}, 404);
  await assert.rejects(lab.poll(rule), /response/);
  lab.fail();
  await assert.rejects(lab.poll(rule), /unavailable/);
  lab.response(snapshot("filled", 2));
  assert.equal((await lab.poll(rule)).length, 1);
  await assert.rejects(lab.poll(check), /configuration/);
});

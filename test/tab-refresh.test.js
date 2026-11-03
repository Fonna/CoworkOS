import assert from "node:assert/strict";
import { test } from "node:test";
import { createTabRefresh } from "../web/assets/workbench/tab-refresh.js";
import { createWorkbenchRegistry } from "../web/assets/workbench/registry.js";

test("periodic polls reuse a slow read so its result can still reach the workbench", async () => {
  let release;
  let reads = 0;
  const applied = [];
  const refresh = createTabRefresh({
    read: () =>
      ++reads === 1
        ? new Promise((done) => {
            release = done;
          })
        : Promise.resolve({ revision: 2 }),
    apply: (result) => applied.push(result)
  });
  const pending = refresh({ poll: true });
  // Several periodic ticks arrive while the first network response is outstanding.
  for (let tick = 0; tick < 5; tick++) {
    assert.equal(refresh({ poll: true }), pending);
    await Promise.resolve();
  }
  release({ revision: 1 });
  await pending;
  assert.deepEqual(applied, [{ revision: 1 }]);
  assert.equal(reads, 1);
  // The next ordinary tick starts a fresh read once the previous one has settled.
  await refresh({ poll: true });
  assert.deepEqual(applied, [{ revision: 1 }, { revision: 2 }]);
  assert.equal(reads, 2);
});

test("a user refresh replaces a pending stale poll and preserves deliberate focus", async () => {
  let release;
  let reads = 0;
  const applied = [];
  const refresh = createTabRefresh({
    read: () =>
      ++reads === 1
        ? new Promise((done) => {
            release = done;
          })
        : Promise.resolve({ revision: 2 }),
    apply: (result, options) => applied.push({ ...result, ...options })
  });
  const polling = refresh({ poll: true });
  const user = refresh({ follow: true });
  const laterPoll = refresh({ poll: true });
  assert.equal(polling, user);
  assert.equal(polling, laterPoll);
  release({ revision: 1 });
  await polling;
  assert.deepEqual(applied, [{ revision: 2, follow: true }]);
});

test("polls preserve a slow read's failure and allow a later periodic retry", async () => {
  let reject;
  let reads = 0;
  const errors = [];
  const applied = [];
  const refresh = createTabRefresh({
    read: () =>
      ++reads === 1
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : Promise.resolve("recovered"),
    apply: (result) => applied.push(result),
    onError: (error) => errors.push(error.message)
  });
  const pending = refresh({ poll: true });
  assert.equal(refresh({ poll: true }), pending);
  reject(new Error("offline"));
  await pending;
  assert.deepEqual(errors, ["offline"]);
  assert.equal(reads, 1);
  await refresh({ poll: true });
  assert.deepEqual(applied, ["recovered"]);
});

test("an obsolete failed poll cannot hide a later successful refresh", async () => {
  let reject;
  let reads = 0;
  const errors = [];
  const applied = [];
  const refresh = createTabRefresh({
    read: () =>
      ++reads === 1
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : Promise.resolve("current tabs"),
    apply: (result) => applied.push(result),
    onError: (error) => errors.push(error)
  });
  const first = refresh({ follow: true });
  refresh();
  reject(new Error("network unavailable"));
  await first;
  assert.deepEqual(errors, []);
  assert.deepEqual(applied, ["current tabs"]);
});

test("a failed refresh reports the error and permits later retries", async () => {
  let failed = true;
  const errors = [];
  const applied = [];
  const refresh = createTabRefresh({
    read: async () => {
      if (failed) throw new Error("offline");
      return "recovered";
    },
    apply: (result) => applied.push(result),
    onError: (error) => errors.push(error.message)
  });
  await refresh();
  failed = false;
  await refresh();
  assert.deepEqual(errors, ["offline"]);
  assert.deepEqual(applied, ["recovered"]);
});

test("UI registration accepts another application without changing the main page", () => {
  const adapter = { definition: { appType: "another-app" }, mount() {} };
  const registry = createWorkbenchRegistry([adapter]);
  assert.equal(registry["another-app"], adapter);
  assert.throws(() => createWorkbenchRegistry([adapter, adapter]), /already registered/);
  assert.throws(() => createWorkbenchRegistry([{ definition: {} }]), /requires appType/);
});

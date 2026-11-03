import assert from "node:assert/strict";
import { test } from "node:test";
import { createVisiblePoll } from "../web/assets/ui/visible-poll.js";

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function fixture(t, run, hidden = false) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = new EventTarget();
  document.hidden = hidden;
  const window = new EventTarget();
  const poll = createVisiblePoll({ run, intervalMs: 100, document, window, immediate: true });
  t.after(() => poll.dispose());
  return {
    poll,
    document,
    window,
    visibility(hidden) {
      document.hidden = hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  };
}

test("slow automatic reads never overlap and their result is not starved by later ticks", async (t) => {
  let calls = 0,
    finish;
  const results = [];
  fixture(t, async () => {
    calls++;
    results.push(
      await new Promise((resolve) => {
        finish = resolve;
      })
    );
  });
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  finish("ready");
  await flush();
  assert.deepEqual(results, ["ready"]);
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
  finish("next");
  await flush();
});

test("hidden pages stop automatic reads and returning refreshes immediately", async (t) => {
  let calls = 0;
  const f = fixture(
    t,
    async () => {
      calls++;
    },
    true
  );
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
  f.visibility(false);
  assert.equal(calls, 1);
  await flush();
  f.visibility(true);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  f.visibility(false);
  assert.equal(calls, 2);
  await flush();
});

test("returning during a pending read queues one catch-up and disposal removes lifecycle listeners", async (t) => {
  let calls = 0,
    finish;
  const f = fixture(t, () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.visibility(true);
  f.visibility(false);
  f.window.dispatchEvent(new Event("pageshow"));
  assert.equal(calls, 1);
  finish();
  await flush();
  assert.equal(calls, 2);
  f.poll.dispose();
  finish();
  await flush();
  f.visibility(false);
  f.window.dispatchEvent(new Event("pageshow"));
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
});

test("a failed read can recover and a page restored from pagehide resumes", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    if (++calls === 1) throw new Error("offline");
  });
  await flush();
  f.window.dispatchEvent(new Event("pagehide"));
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  f.window.dispatchEvent(new Event("pageshow"));
  assert.equal(calls, 2);
  await flush();
  t.mock.timers.tick(100);
  assert.equal(calls, 3);
  await flush();
});

test("local visibility pauses polling without duplicating the initial application load", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = new EventTarget();
  document.hidden = false;
  let calls = 0;
  const poll = createVisiblePoll({
    run: async () => {
      calls++;
    },
    intervalMs: 100,
    document
  });
  t.after(() => poll.dispose());
  poll.setActive(true);
  assert.equal(calls, 0, "mount can perform its own initial read");
  poll.setActive(false);
  t.mock.timers.tick(1000);
  assert.equal(calls, 0);
  poll.setActive(true);
  assert.equal(calls, 1);
  await flush();
  poll.setActive(true);
  assert.equal(calls, 1);
  poll.setActive(false);
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
});

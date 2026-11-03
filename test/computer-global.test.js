import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse } from "../dist/src/gui/computer-use.js";

const target = {
  pid: 11,
  windowId: 12,
  bundleId: "org.atria.fixture",
  application: "Fixture",
  title: "Test"
};
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const frame = { width: 1, height: 1, image, frame: { x: 0, y: 0, width: 1, height: 1 } };
function fixture(overrides = {}) {
  let now = 1;
  const effects = [];
  const computer = new ComputerUse(
    {
      status: async () => ({
        available: true,
        screenRecording: true,
        accessibility: true,
        windows: [target]
      }),
      observe: async (selected) => {
        effects.push(["observe", selected.windowId]);
        return frame;
      },
      act: async (selected, action) => effects.push([action.type, selected.windowId]),
      ...overrides
    },
    () => now
  );
  return {
    computer,
    effects,
    advance: (ms) => {
      now += ms;
    }
  };
}

test("global access defaults off, consumes human policy and renews without reusing observation credentials", async () => {
  const { computer, advance, effects } = fixture();
  assert.equal(computer.access().policy.enabled, false);
  await assert.rejects(computer.select("old", target.pid, target.windowId, "control"), /全局/);
  computer.configurePolicy({ enabled: true, mode: "observe" });
  await assert.rejects(computer.select("old", target.pid, target.windowId, "control"), /仅观察/);
  const granted = await computer.select("old", target.pid, target.windowId, "observe");
  const first = await computer.observe("old", granted.sessionId);
  advance(300_001);
  assert.equal(computer.current("old").state, "active");
  const fresh = await computer.observe("old", granted.sessionId);
  assert.notEqual(first.observationId, fresh.observationId);
  computer.release("old", granted.sessionId);
  const next = await computer.select("new", target.pid, target.windowId, "observe");
  await assert.rejects(computer.observe("old", next.sessionId), /未授权/);
  assert.deepEqual(effects, [
    ["observe", 12],
    ["observe", 12]
  ]);
  computer.configurePolicy({ enabled: false, mode: "observe" });
  await assert.rejects(computer.observe("new", next.sessionId), /未授权/);
});

test("global desktop ownership spans observations and consecutive actions; waiting tasks cannot steal it", async () => {
  const { computer, effects } = fixture();
  computer.configurePolicy({ enabled: true, mode: "control" });
  const a = await computer.select("a", 11, 12, "control");
  let acquired = false;
  const waiting = computer.select("b", 11, 12, "control").then((session) => {
    acquired = true;
    return session;
  });
  const first = await computer.observe("a", a.sessionId);
  await computer.act("a", a.sessionId, first.observationId, { type: "activate" });
  const second = await computer.observe("a", a.sessionId);
  assert.equal(acquired, false);
  await computer.act("a", a.sessionId, second.observationId, { type: "type", text: "probe" });
  computer.release("a", a.sessionId);
  const b = await waiting;
  await computer.observe("b", b.sessionId);
  assert.deepEqual(
    effects.map(([type]) => type),
    ["observe", "activate", "observe", "type", "observe"]
  );
});

test("takeover cancels active and waiting work; policy alone cannot undo pause or task cancellation", async () => {
  let started, release;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { computer } = fixture({
    observe: async (_target, signal) => {
      started();
      await held;
      signal.throwIfAborted();
      return frame;
    }
  });
  computer.configurePolicy({ enabled: true, mode: "control" });
  const a = await computer.select("a", 11, 12, "control");
  const observing = assert.rejects(computer.observe("a", a.sessionId), { name: "AbortError" });
  const queued = assert.rejects(computer.select("b", 11, 12, "control"), /暂停|取消/);
  await began;
  computer.takeOver();
  release();
  await Promise.all([observing, queued]);
  await assert.rejects(computer.select("b", 11, 12, "control"), /暂停/);
  await computer.resume();
  computer.stop("a", "ended");
  await assert.rejects(computer.select("a", 11, 12, "control"), /取消/);
  const b = await computer.select("b", 11, 12, "control");
  assert.equal(b.state, "active");
});

test("late global selection cannot reinstate revoked policy; restarted managers reject old IDs", async () => {
  let release, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const { computer } = fixture({
    status: () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      })
  });
  computer.configurePolicy({ enabled: true, mode: "control" });
  const selecting = assert.rejects(computer.select("a", 11, 12, "control"), { name: "AbortError" });
  await began;
  computer.configurePolicy({ enabled: false, mode: "control" });
  release({ available: true, screenRecording: true, accessibility: true, windows: [target] });
  await selecting;
  assert.equal(computer.current("a"), null);
  const original = fixture().computer;
  original.configurePolicy({ enabled: true, mode: "control" });
  const old = await original.select("a", 11, 12, "control");
  const observation = await original.observe("a", old.sessionId);
  const restarted = fixture().computer;
  restarted.configurePolicy({ enabled: true, mode: "control" });
  const current = await restarted.select("a", 11, 12, "control");
  assert.notEqual(old.sessionId, current.sessionId);
  await assert.rejects(
    restarted.act("a", current.sessionId, observation.observationId, { type: "activate" }),
    /观察结果/
  );
});

test("the owner can switch windows while another task waits; release invalidates its previous credentials", async () => {
  const second = { ...target, windowId: 22 };
  const { computer } = fixture({
    status: async () => ({
      available: true,
      screenRecording: true,
      accessibility: true,
      windows: [target, second]
    })
  });
  computer.configurePolicy({ enabled: true, mode: "control" });
  const a = await computer.select("a", 11, 12, "control");
  const observed = await computer.observe("a", a.sessionId);
  const waiting = computer.select("b", 11, 12, "control");
  const switched = await computer.select("a", 11, 22, "control");
  assert.notEqual(switched.sessionId, a.sessionId);
  assert.equal(switched.target.windowId, 22);
  await assert.rejects(
    computer.act("a", switched.sessionId, observed.observationId, { type: "activate" }),
    /观察结果/
  );
  computer.finishTask("a");
  assert.equal((await waiting).taskId, "b");
});

test("global renewal checks current target identity, system permissions and secure input before any effect", async () => {
  let windows = [target],
    recording = true,
    secureInput = false;
  const { computer, advance, effects } = fixture({
    status: async () => ({
      available: true,
      screenRecording: recording,
      accessibility: true,
      secureInput,
      windows
    })
  });
  computer.configurePolicy({ enabled: true, mode: "control" });
  const grant = await computer.select("a", 11, 12, "control");
  const observed = await computer.observe("a", grant.sessionId);
  secureInput = true;
  await assert.rejects(
    computer.act("a", grant.sessionId, observed.observationId, { type: "activate" }),
    /解锁/
  );
  secureInput = false;
  recording = false;
  advance(300_001);
  await assert.rejects(computer.observe("a", grant.sessionId), /系统设置/);
  recording = true;
  windows = [{ ...target, bundleId: "org.atria.other" }];
  await assert.rejects(computer.observe("a", grant.sessionId), /身份/);
  assert.equal(computer.current("a").state, "ended");
  assert.deepEqual(effects, [["observe", 12]]);
});

test("aborting a waiting selection releases its FIFO slot without cancelling the owner", async () => {
  const { computer } = fixture();
  computer.configurePolicy({ enabled: true, mode: "control" });
  const a = await computer.select("a", 11, 12, "control");
  const cancel = new AbortController();
  const rejected = assert.rejects(computer.select("b", 11, 12, "control", cancel.signal), /取消/);
  cancel.abort();
  await rejected;
  assert.equal(computer.current("a").state, "active");
  computer.release("a", a.sessionId);
  assert.equal((await computer.select("c", 11, 12, "control")).taskId, "c");
});

test("valid global policy keeps an in-flight observation alive across the temporary five-minute boundary", async () => {
  const { computer, advance } = fixture({
    observe: async (_target, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      signal.throwIfAborted();
      return frame;
    }
  });
  computer.configurePolicy({ enabled: true, mode: "observe" });
  const grant = await computer.select("a", 11, 12, "observe");
  advance(299_999);
  assert.equal(typeof (await computer.observe("a", grant.sessionId)).observationId, "string");
});

test("a waiting global selection acquires an expired legacy grant without an external status read", async () => {
  const { computer, advance } = fixture();
  computer.configurePolicy({ enabled: true, mode: "observe" });
  await computer.authorize("legacy", 11, 12, "observe");
  advance(299_999);
  const waiting = computer.select("next", 11, 12, "observe");
  await new Promise((done) => setImmediate(done));
  advance(2);
  assert.equal((await waiting).taskId, "next");
  computer.close();
});

test("renderer cleanup releases ownership and old credentials without pausing global access", async () => {
  const { computer } = fixture();
  computer.configurePolicy({ enabled: true, mode: "control" });
  const old = await computer.select("a", 11, 12, "control");
  await computer.observe("a", old.sessionId);
  const waiting = computer.select("b", 11, 12, "control");
  const rejected = assert.rejects(waiting);
  await new Promise((done) => setImmediate(done));
  computer.releaseSessions();
  await rejected;
  assert.equal(computer.access().policy.enabled, true);
  assert.equal(computer.access().paused, false);
  await assert.rejects(computer.observe("a", old.sessionId));
  const next = await computer.select("a", 11, 12, "control");
  assert.notEqual(next.sessionId, old.sessionId);
  assert.equal(typeof (await computer.observe("a", next.sessionId)).observationId, "string");
  computer.close();
});

test("renderer cleanup does not undo a human pause or disabled policy", async () => {
  const { computer } = fixture();
  computer.configurePolicy({ enabled: true, mode: "control" });
  computer.takeOver();
  computer.releaseSessions();
  assert.equal(computer.access().paused, true);
  await assert.rejects(computer.select("a", 11, 12, "control"));
  computer.configurePolicy({ enabled: false, mode: "control" });
  computer.releaseSessions();
  assert.equal(computer.access().policy.enabled, false);
  await assert.rejects(computer.select("a", 11, 12, "control"));
});

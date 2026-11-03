import assert from "node:assert/strict";
import { test } from "node:test";
import { ComputerUse, computerAction } from "../dist/src/gui/computer-use.js";

const target = {
  pid: 100,
  windowId: 200,
  bundleId: "org.atria.fixture",
  application: "Fixture",
  title: "Probe"
};
const frame = {
  width: 100,
  height: 80,
  image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  frame: { x: 20, y: 30, width: 100, height: 80 }
};
function fixture(overrides = {}, clock) {
  const effects = [];
  const driver = {
    status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [target] }),
    observe: async () => {
      effects.push("observe");
      return { ...frame };
    },
    act: async (_target, action) => {
      effects.push(action.type);
    },
    ...overrides
  };
  return { effects, computer: new ComputerUse(driver, clock) };
}
test("computer grants are tied to one Task/window; read-only sessions cannot input", async () => {
  const { computer, effects } = fixture();
  await assert.rejects(computer.observe("task", "invented"), /未授权/);
  await assert.rejects(computer.authorize("task", 100, 999, "control"), /目标窗口/);
  const grant = await computer.authorize("task", 100, 200, "observe");
  await assert.rejects(computer.observe("other-task", grant.sessionId), /未授权/);
  const observation = await computer.observe("task", grant.sessionId);
  await assert.rejects(
    computer.act("task", grant.sessionId, observation.observationId, { type: "activate" }),
    /只允许观察/
  );
  assert.deepEqual(effects, ["observe"]);
});
test("computer inputs consume fresh observations and validate image coordinates", async () => {
  let now = 1;
  const { computer, effects } = fixture({}, () => now);
  const grant = await computer.authorize("task", 100, 200, "control");
  const observe = () => computer.observe("task", grant.sessionId);
  let observed = await observe();
  await assert.rejects(computer.act("task", grant.sessionId, "forged", { type: "activate" }), /观察结果/);
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, {
      type: "click",
      x: 100,
      y: 1,
      button: "left"
    }),
    /超出/
  );
  await computer.act("task", grant.sessionId, observed.observationId, {
    type: "type",
    text: "sensitive text"
  });
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, { type: "type", text: "sensitive text" }),
    /观察结果/
  );
  observed = await observe();
  now += 30_001;
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, { type: "activate" }),
    /观察结果/
  );
  assert.deepEqual(effects, ["observe", "type", "observe"]);
  assert.equal(JSON.stringify(computer.current("task")).includes("sensitive text"), false);
});
test("pausing computer use aborts active input and rejects all queued effects", async () => {
  let started, release;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { computer, effects } = fixture({
    act: async (_target, _action, _frame, signal) => {
      started();
      await held;
      signal.throwIfAborted();
    }
  });
  const grant = await computer.authorize("task", 100, 200, "control");
  const observed = await computer.observe("task", grant.sessionId);
  const active = computer.act("task", grant.sessionId, observed.observationId, { type: "activate" });
  const queued = computer.observe("task", grant.sessionId);
  const activeCheck = assert.rejects(active, { name: "AbortError" });
  const queuedCheck = assert.rejects(queued, /已暂停/);
  await began;
  computer.takeOver();
  release();
  await Promise.all([activeCheck, queuedCheck]);
  assert.deepEqual(effects, ["observe"]);
  assert.equal(computer.current("task").state, "paused");
  assert.equal(computer.current("task").activity.at(-1).outcome, "failed");
});
test("expired or replaced computer grants cannot publish a late observation", async () => {
  let now = 1,
    release,
    started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { computer } = fixture(
    {
      observe: async () => {
        started();
        await held;
        return frame;
      }
    },
    () => now
  );
  const old = await computer.authorize("task", 100, 200, "observe");
  const observing = computer.observe("task", old.sessionId);
  const rejected = assert.rejects(observing, { name: "AbortError" });
  await began;
  const fresh = await computer.authorize("task", 100, 200, "control");
  release();
  await rejected;
  assert.notEqual(fresh.sessionId, old.sessionId);
  await assert.rejects(computer.observe("task", old.sessionId), /未授权/);
  now += 300_001;
  assert.equal(computer.current("task").state, "ended");
  await assert.rejects(computer.observe("task", fresh.sessionId), /已过期/);
});
test("failed physical delivery is never repeated against the same observation", async () => {
  let attempted = 0;
  const { computer } = fixture({
    act: async () => {
      attempted++;
      throw new Error("focus changed");
    }
  });
  const grant = await computer.authorize("task", 100, 200, "control");
  const observed = await computer.observe("task", grant.sessionId);
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, { type: "activate" }),
    /focus changed/
  );
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, { type: "activate" }),
    /观察结果/
  );
  assert.equal(attempted, 1);
});
test("computer input rejects unsupported actions, arbitrary shortcuts and unbounded text", () => {
  for (const value of [
    null,
    {},
    { type: "shell", command: "test" },
    { type: "click", x: Infinity, y: 1, button: "left" },
    { type: "type", text: "x".repeat(16_385) },
    { type: "type", text: "a\0b" },
    { type: "key", keys: ["Meta"] },
    { type: "key", keys: ["Meta", "q", "w"] },
    { type: "key", keys: ["run shell"] }
  ])
    assert.throws(() => computerAction(value));
  assert.deepEqual(computerAction({ type: "key", keys: ["Meta", "Shift", "a"] }), {
    type: "key",
    keys: ["Meta", "Shift", "a"]
  });
});

test("manual takeover cancels a grant still waiting for Task authorization", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const driver = {
    status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [target] })
  };
  const computer = new ComputerUse(driver, Date.now, () => waiting);
  const pending = computer.authorize("task", 100, 200, "control");
  const rejected = assert.rejects(pending, /授权请求已取消/);
  computer.takeOver();
  release();
  await rejected;
  assert.equal(computer.current("task"), null);
  const grant = await computer.authorize("task", 100, 200, "control");
  assert.equal(grant.state, "active");
});

test("Task cancellation cancels a delayed native grant; locked desktops permit observation only", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const { computer } = fixture({ status: () => waiting });
  const pending = computer.authorize("task", 100, 200, "control");
  const rejected = assert.rejects(pending, /授权请求已取消/);
  computer.stop("task", "ended");
  release({ available: true, screenRecording: true, accessibility: true, windows: [target] });
  await rejected;
  assert.equal(computer.current("task"), null);
  const locked = fixture({
    status: async () => ({
      available: true,
      screenRecording: true,
      accessibility: true,
      controlAvailable: false,
      windows: [target]
    })
  }).computer;
  await assert.rejects(locked.authorize("task", 100, 200, "control"), /解锁/);
  assert.equal((await locked.authorize("task", 100, 200, "observe")).mode, "observe");
});

test("post-action feedback is atomic; preview reads do not replace the next observation", async () => {
  const { computer, effects } = fixture();
  const grant = await computer.authorize("task", 100, 200, "control");
  const first = await computer.observe("task", grant.sessionId);
  const result = await computer.act(
    "task",
    grant.sessionId,
    first.observationId,
    { type: "type", text: "probe" },
    undefined,
    true
  );
  assert.equal(result.dispatched, true);
  assert.equal(result.effectVerified, false);
  assert.equal(result.requiresObservation, false);
  assert.notEqual(result.observation.observationId, first.observationId);
  const preview = computer.preview("task");
  assert.equal(preview.image, frame.image);
  assert.equal(preview.observationId, undefined);
  assert.equal(computer.preview("other"), null);
  await assert.rejects(
    computer.act("task", grant.sessionId, first.observationId, { type: "activate" }),
    /观察结果/
  );
  await computer.act("task", grant.sessionId, result.observation.observationId, { type: "activate" });
  assert.deepEqual(effects, ["observe", "type", "observe", "activate"]);
  assert.equal(computer.current("task").activity.at(-1).outcome, "dispatched");
  computer.takeOver();
  assert.equal(computer.preview("task"), null);
});

test("capture failure after delivery reports an unverified effect and never resends input", async () => {
  let captures = 0,
    inputs = 0;
  const { computer } = fixture({
    observe: async () => {
      if (++captures > 1) throw new Error("window closed after click");
      return frame;
    },
    act: async () => {
      inputs++;
    }
  });
  const grant = await computer.authorize("task", 100, 200, "control");
  const observed = await computer.observe("task", grant.sessionId);
  const result = await computer.act(
    "task",
    grant.sessionId,
    observed.observationId,
    { type: "click", x: 1, y: 1, button: "left" },
    undefined,
    true
  );
  assert.equal(result.dispatched, true);
  assert.equal(result.effectVerified, false);
  assert.equal(result.requiresObservation, true);
  assert.match(result.observationError, /window closed/);
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, { type: "activate" }),
    /观察结果/
  );
  assert.equal(inputs, 1);
});

test("takeover during post-action capture drops late feedback and cached previews", async () => {
  let captures = 0,
    started,
    release;
  const began = new Promise((done) => {
    started = done;
  });
  const held = new Promise((done) => {
    release = done;
  });
  const { computer } = fixture({
    observe: async () => {
      if (++captures > 1) {
        started();
        await held;
      }
      return frame;
    }
  });
  const grant = await computer.authorize("task", 100, 200, "control");
  const observed = await computer.observe("task", grant.sessionId);
  const active = computer.act(
    "task",
    grant.sessionId,
    observed.observationId,
    { type: "activate" },
    undefined,
    true
  );
  const rejected = assert.rejects(active, { name: "AbortError" });
  await began;
  computer.takeOver();
  release();
  await rejected;
  assert.equal(computer.preview("task"), null);
  assert.equal(computer.current("task").state, "paused");
});

test("control denial preserves the native secure-input reason while observation remains available", async () => {
  const { computer } = fixture({
    status: async () => ({
      available: true,
      screenRecording: true,
      accessibility: true,
      controlAvailable: false,
      reason: "系统正在使用安全键盘输入",
      windows: [target]
    })
  });
  await assert.rejects(computer.authorize("task", 100, 200, "control"), /安全键盘输入/);
  const grant = await computer.authorize("task", 100, 200, "observe");
  assert.equal((await computer.observe("task", grant.sessionId)).image, frame.image);
});

test("a human screenshot refresh preserves the agent's pending action and never grants new input credentials", async () => {
  const { computer, effects } = fixture();
  const grant = await computer.authorize("task", 100, 200, "control");
  const observed = await computer.observe("task", grant.sessionId);
  const preview = await computer.refreshPreview("task", grant.sessionId);
  assert.equal(preview.image, frame.image);
  assert.equal(preview.sessionId, grant.sessionId);
  assert.equal(preview.observationId, undefined);
  assert.equal(preview.frame, undefined);
  await computer.act("task", grant.sessionId, observed.observationId, { type: "activate" });
  await assert.rejects(computer.refreshPreview("other", grant.sessionId), /未授权/);
  computer.takeOver();
  await assert.rejects(computer.refreshPreview("task", grant.sessionId), /未授权/);
  assert.deepEqual(effects, ["observe", "observe", "activate"]);
});

test("invalid screenshot data is an explicit driver failure and cannot leave an old agent observation usable", async () => {
  for (const image of [undefined, "", "not-a-png"]) {
    let captures = 0;
    const { computer } = fixture({
      observe: async () => ({ ...frame, image: ++captures === 1 ? frame.image : image })
    });
    const grant = await computer.authorize("task", 100, 200, "control");
    const observed = await computer.observe("task", grant.sessionId);
    await assert.rejects(computer.observe("task", grant.sessionId), { status: 502 });
    await assert.rejects(
      computer.act("task", grant.sessionId, observed.observationId, { type: "activate" }),
      /观察结果/
    );
    assert.equal(computer.current("task").activity.at(-2).outcome, "failed");
  }
});

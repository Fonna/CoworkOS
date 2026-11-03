import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUse, ComputerUseError, computerAction } from "../dist/src/gui/computer-use.js";

const target = {
  pid: 100,
  windowId: 200,
  bundleId: "org.atria.fixture",
  application: "Fixture",
  title: "Probe"
};
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const node = (fields = {}) => ({
  elementId: "root",
  role: "AXButton",
  name: "Save",
  enabled: true,
  actions: ["press"],
  path: [],
  identity: "native-1",
  fingerprint: "state-1",
  ...fields
});
const frame = (elements = [node()], fields = {}) => ({
  width: 1,
  height: 1,
  image,
  frame: { x: 0, y: 0, width: 1, height: 1 },
  accessibilityText: "AXButton · Save",
  accessibility: { elements, available: true, truncated: false },
  ...fields
});
function fixture(overrides = {}) {
  const effects = [];
  const driver = {
    status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [target] }),
    observe: async () => frame(),
    act: async (_target, action) => {
      effects.push(action);
    },
    ...overrides
  };
  return { computer: new ComputerUse(driver), effects };
}
const authorize = (computer, mode = "control") =>
  computer.authorize("task", target.pid, target.windowId, mode);

test("AX actions use observation-scoped IDs, preserve internal native identity, and never expose native references", async () => {
  const { computer, effects } = fixture();
  const grant = await authorize(computer);
  const first = await computer.observe("task", grant.sessionId);
  const element = first.accessibility.elements[0];
  assert.equal(element.elementId, `${first.observationId}:root`);
  assert.equal(element.path, undefined);
  assert.equal(element.identity, undefined);
  assert.equal(element.fingerprint, undefined);
  const second = await computer.observe("task", grant.sessionId);
  await assert.rejects(
    computer.act("task", grant.sessionId, second.observationId, {
      type: "press",
      elementId: element.elementId
    }),
    { errorCode: "stale_element", dispatchStatus: "not_sent" }
  );
  await computer.act("task", grant.sessionId, second.observationId, {
    type: "press",
    elementId: second.accessibility.elements[0].elementId
  });
  assert.deepEqual(effects, [{ type: "press", elementId: "root" }]);
  await assert.rejects(
    computer.act("task", grant.sessionId, second.observationId, {
      type: "press",
      elementId: second.accessibility.elements[0].elementId
    }),
    { errorCode: "stale_observation" }
  );
});

test("AX actions reject unsupported/disabled/secure controls and observation-only grants", async () => {
  for (const fields of [
    { enabled: false },
    { actions: [] },
    { role: "AXSecureTextField", value: "DO_NOT_EXPOSE", actions: ["set_value"] }
  ]) {
    const { computer, effects } = fixture({ observe: async () => frame([node(fields)]) });
    const grant = await authorize(computer);
    const observed = await computer.observe("task", grant.sessionId);
    const element = observed.accessibility.elements[0];
    const type = fields.role ? "set_value" : "press";
    await assert.rejects(
      computer.act("task", grant.sessionId, observed.observationId, {
        type,
        elementId: element.elementId,
        value: "replacement"
      }),
      { errorCode: "element_unavailable", dispatchStatus: "not_sent" }
    );
    assert.equal(effects.length, 0);
    if (fields.role) {
      assert.equal(element.value, undefined);
      assert.deepEqual(element.actions, []);
      assert.equal(JSON.stringify(computer.preview("task")).includes("DO_NOT_EXPOSE"), false);
    }
  }
  const { computer } = fixture();
  const grant = await authorize(computer, "observe");
  const observed = await computer.observe("task", grant.sessionId);
  await assert.rejects(
    computer.act("task", grant.sessionId, observed.observationId, {
      type: "press",
      elementId: observed.accessibility.elements[0].elementId
    }),
    { status: 403 }
  );
});

test("wait polls a changing AX control until enabled, returns fresh IDs, and does not send input", async () => {
  let captures = 0;
  const { computer, effects } = fixture({ observe: async () => frame([node({ enabled: ++captures >= 3 })]) });
  const grant = await authorize(computer);
  const old = await computer.observe("task", grant.sessionId);
  const result = await computer.wait(
    "task",
    grant.sessionId,
    { type: "element", role: "AXButton", name: "Save", state: "enabled" },
    1000
  );
  assert.equal(result.status, "condition_met");
  assert.ok(captures >= 3);
  assert.notEqual(result.observation.observationId, old.observationId);
  assert.equal(result.observation.accessibility.elements[0].enabled, true);
  assert.deepEqual(effects, []);
  await assert.rejects(computer.act("task", grant.sessionId, old.observationId, { type: "activate" }), {
    errorCode: "stale_observation"
  });
  await computer.act("task", grant.sessionId, result.observation.observationId, {
    type: "press",
    elementId: result.observation.accessibility.elements[0].elementId
  });
});

test("text/value waits and timeout supply current observation without claiming task success", async () => {
  const { computer } = fixture({
    observe: async () =>
      frame([node({ role: "AXTextField", name: "Filename", value: "report.pdf", actions: ["set_value"] })], {
        accessibilityText: "Export complete"
      })
  });
  const grant = await authorize(computer);
  for (const condition of [
    { type: "accessibility_text", text: "Export complete", state: "present" },
    { type: "element", name: "Filename", value: "report.pdf", state: "present" },
    { type: "element", name: "Missing dialog", state: "absent" }
  ])
    assert.equal((await computer.wait("task", grant.sessionId, condition, 100)).status, "condition_met");
  const timeout = await computer.wait(
    "task",
    grant.sessionId,
    { type: "element", name: "Export failed", state: "present" },
    30
  );
  assert.equal(timeout.status, "timeout");
  assert.equal(typeof timeout.observation.observationId, "string");
  assert.equal(timeout.observation.image, image);
  assert.equal(timeout.effectVerified, undefined);
  assert.ok(timeout.waitedMs < 300, "polling must respect the deadline");
});

test("incomplete/unavailable AX observations cannot prove text or element absence", async () => {
  for (const fields of [
    { available: false, truncated: false },
    { available: true, truncated: true }
  ]) {
    const { computer } = fixture({
      observe: async () =>
        frame([], { accessibilityText: "visible prefix", accessibility: { elements: [], ...fields } })
    });
    const grant = await authorize(computer, "observe");
    for (const condition of [
      { type: "element", name: "missing", state: "absent" },
      { type: "accessibility_text", text: "not in visible prefix", state: "absent" }
    ])
      assert.equal((await computer.wait("task", grant.sessionId, condition, 10)).status, "timeout");
  }
  const { computer } = fixture({
    observe: async () =>
      frame([], {
        accessibilityText: "visible prefix",
        accessibility: { elements: [], available: true, truncated: true }
      })
  });
  const grant = await authorize(computer, "observe");
  assert.equal(
    (
      await computer.wait(
        "task",
        grant.sessionId,
        { type: "accessibility_text", text: "visible prefix", state: "present" },
        10
      )
    ).status,
    "condition_met"
  );
});

test("wait deadline bounds a stuck later capture and preserves its last fresh credential", async () => {
  let captures = 0;
  const { computer } = fixture({
    observe: async (_target, signal) => {
      if (++captures > 1) await delay(10_000, undefined, { signal });
      return frame();
    }
  });
  const grant = await authorize(computer);
  const result = await computer.wait(
    "task",
    grant.sessionId,
    { type: "element", name: "missing", state: "present" },
    350
  );
  assert.equal(result.status, "timeout");
  assert.ok(result.waitedMs < 1000);
  await computer.act("task", grant.sessionId, result.observation.observationId, {
    type: "press",
    elementId: result.observation.accessibility.elements[0].elementId
  });
});

test("takeover and caller abort stop wait and invalidate old observations", async () => {
  for (const takeover of [true, false]) {
    let captures = 0,
      started;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const { computer, effects } = fixture({
      observe: async (_target, signal) => {
        if (++captures > 1) {
          started();
          await delay(10_000, undefined, { signal });
        }
        return frame();
      }
    });
    const grant = await authorize(computer);
    const old = await computer.observe("task", grant.sessionId);
    const abort = new AbortController();
    const waiting = computer.wait(
      "task",
      grant.sessionId,
      { type: "element", name: "missing", state: "present" },
      1000,
      abort.signal
    );
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    await began;
    if (takeover) computer.takeOver();
    else abort.abort();
    await rejected;
    await assert.rejects(computer.act("task", grant.sessionId, old.observationId, { type: "activate" }));
    assert.deepEqual(effects, []);
  }
});

test("wait rejects empty, overlong or invalid conditions before observing", async () => {
  let observed = 0;
  const { computer } = fixture({
    observe: async () => {
      observed++;
      return frame();
    }
  });
  const grant = await authorize(computer);
  for (const condition of [
    null,
    [],
    {},
    { type: "element", state: "present" },
    { type: "element", name: " ", state: "absent" },
    { type: "accessibility_text", text: "", state: "absent" },
    { type: "accessibility_text", text: "x".repeat(513), state: "present" }
  ])
    assert.throws(() => computer.wait("task", grant.sessionId, condition, 10), {
      errorCode: "invalid_argument"
    });
  for (const timeout of [0, -1, 30_001, 1.5, "10"])
    assert.throws(
      () =>
        computer.wait("task", grant.sessionId, { type: "element", name: "Save", state: "present" }, timeout),
      { status: 400 }
    );
  assert.equal(observed, 0);
  for (const action of [
    { type: "press", elementId: "" },
    { type: "set_value", elementId: "x", value: "a\0b" },
    { type: "set_value", elementId: "x", value: "中".repeat(6000) }
  ])
    assert.throws(() => computerAction(action));
  assert.deepEqual(computerAction({ type: "set_value", elementId: "id", value: "" }), {
    type: "set_value",
    elementId: "id",
    value: ""
  });
});

test("invalid driver AX trees fail explicitly and revoke prior observations", async () => {
  for (const nodes of [
    Array.from({ length: 201 }, (_, index) => node({ elementId: String(index) })),
    [node(), node()],
    [node({ path: [-1] })],
    [node({ name: "x".repeat(513) })]
  ]) {
    let captures = 0;
    const { computer } = fixture({ observe: async () => (++captures === 1 ? frame() : frame(nodes)) });
    const grant = await authorize(computer);
    const old = await computer.observe("task", grant.sessionId);
    await assert.rejects(computer.observe("task", grant.sessionId), {
      status: 502,
      errorCode: "invalid_driver_response"
    });
    await assert.rejects(computer.act("task", grant.sessionId, old.observationId, { type: "activate" }), {
      errorCode: "stale_observation"
    });
  }
});

test("unknown native delivery stays unknown, explicit sent failure stays sent, neither credential can be reused", async () => {
  for (const failure of [
    new Error("driver connection lost"),
    new ComputerUseError(409, "partial delivery", "native_action_failed", "sent", true)
  ]) {
    let attempts = 0;
    const { computer } = fixture({
      act: async () => {
        attempts++;
        throw failure;
      }
    });
    const grant = await authorize(computer);
    const observed = await computer.observe("task", grant.sessionId);
    const action = { type: "press", elementId: observed.accessibility.elements[0].elementId };
    await assert.rejects(computer.act("task", grant.sessionId, observed.observationId, action), {
      dispatchStatus: failure instanceof ComputerUseError ? "sent" : "unknown",
      requiresObservation: true
    });
    await assert.rejects(computer.act("task", grant.sessionId, observed.observationId, action), {
      errorCode: "stale_observation"
    });
    assert.equal(attempts, 1);
  }
});

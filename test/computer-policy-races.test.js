import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createDashboardApplication } from "../dist/src/dashboard/application.js";

const { createComputerPolicyController, createComputerPolicyStore } = createRequire(import.meta.url)(
  "../desktop/computer-policy.cjs"
);
const target = { pid: 11, windowId: 12, bundleId: "org.atria.race", application: "Fixture", title: "Test" };
const status = {
  available: true,
  screenRecording: true,
  accessibility: true,
  windows: [target, { ...target, windowId: 13 }]
};
const frame = {
  width: 1,
  height: 1,
  image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  frame: { x: 0, y: 0, width: 1, height: 1 }
};
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("isolated HTTP selection did not finish")), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "isolated HTTP selection was not admitted");
    await new Promise((done) => setImmediate(done));
  }
}
async function fixture(t, driver, cleanup = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-computer-races-"));
  await writeFile(join(root, "config.json"), "{}");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const dashboard = createDashboardApplication({ projectRoot: root, port, computerDriver: driver });
  t.after(async () => {
    cleanup();
    await dashboard.stop();
    await rm(root, { recursive: true, force: true });
  });
  dashboard.server.listen(port, "127.0.0.1");
  await once(dashboard.server, "listening");
  const base = dashboard.dashboardUrl;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const task = async (id) => {
    assert.equal((await post("/api/tasks", { taskId: id, goal: "Isolated CUA race" })).status, 201);
  };
  const request = (id, operation, body) => post(`/api/tasks/${id}/computer/${operation}`, body);
  const admitted = () =>
    new Promise((done) => {
      dashboard.server.once("request", (message) => message.once("end", () => setImmediate(done)));
    });
  return { root, dashboard, task, request, admitted };
}

test("HTTP admission invalidates incomplete desktop requests across stop and resume", async (t) => {
  for (const boundary of ["stop", "pause", "disable"])
    for (const operation of ["select", "discover"])
      await t.test(`${boundary} then resume rejects the old ${operation} request`, async (t) => {
        let pending;
        let probes = 0;
        const { dashboard, task, request } = await fixture(
          t,
          {
            status: async () => {
              probes++;
              return status;
            },
            observe: async () => frame,
            act: async () => assert.fail("read-only request must never dispatch input")
          },
          () => pending?.destroy()
        );
        await task("late");
        await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "observe" });
        assert.equal((await request("late", "select", { ...target, mode: "observe" })).status, 200);
        const body = JSON.stringify(
          operation === "select" ? { ...target, windowId: 13, mode: "observe" } : {}
        );
        pending = httpRequest(`${dashboard.dashboardUrl}/api/tasks/late/computer/${operation}`, {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
        });
        const response = new Promise((resolve, reject) => {
          pending.once("response", async (incoming) => {
            for await (const _chunk of incoming) {
              /* drain the actual HTTP response */
            }
            resolve(incoming.statusCode);
          });
          pending.once("error", reject);
        });
        const arrived = once(dashboard.server, "request");
        pending.write(body.slice(0, 1));
        await arrived;
        if (boundary === "stop") dashboard.routePorts.computer.stop("late", "ended");
        else if (boundary === "pause") await dashboard.computerHostRequest({ operation: "pause" });
        else await dashboard.computerHostRequest({ operation: "policy", enabled: false, mode: "observe" });
        if (boundary === "disable")
          await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "observe" });
        else await dashboard.computerHostRequest({ operation: "resume" });
        const before = probes;
        const session = dashboard.routePorts.computer.current("late");
        pending.end(body.slice(1));
        assert.equal(await bounded(response), 403, "resuming cannot readmit a pre-boundary request");
        assert.equal(probes, before, "rejected requests cannot reach the native driver");
        assert.deepEqual(dashboard.routePorts.computer.current("late"), session);
        assert.equal(
          (
            await request(
              "late",
              operation,
              operation === "select" ? { ...target, windowId: 13, mode: "observe" } : {}
            )
          ).status,
          200,
          "a fresh request after human resume remains usable"
        );
      });
});

test("saving disabled desktop policy revokes legacy input, queued work and late authorization through HTTP", async (t) => {
  let statusGate;
  const inputStarted = gate(),
    inputFinished = gate(),
    authorizationStarted = gate();
  const effects = [];
  const { root, dashboard, task, request, admitted } = await fixture(
    t,
    {
      status: async () => {
        if (statusGate) {
          authorizationStarted.resolve();
          await statusGate.promise;
        }
        return status;
      },
      observe: async () => frame,
      act: async (_target, _action, _frame, signal) => {
        inputStarted.resolve();
        await inputFinished.promise;
        signal.throwIfAborted();
        effects.push("input");
      }
    },
    () => {
      inputFinished.resolve();
      statusGate?.resolve();
    }
  );
  await task("legacy");
  const store = createComputerPolicyStore(join(root, "desktop"));
  await store.load();
  const backend = { computer: (input) => dashboard.computerHostRequest(input) };
  let shortcut;
  const controller = createComputerPolicyController({
    store,
    getBackend: () => backend,
    registerTakeover: (enabled) => {
      shortcut = enabled;
    }
  });
  await controller.initialize(backend);
  const authorize = () =>
    controller.request({ operation: "authorize", taskId: "legacy", ...target, mode: "control" });
  const close = () => controller.request({ operation: "policy", enabled: false, mode: "observe" });
  const old = await authorize();
  const observation = await request("legacy", "observe", { sessionId: old.sessionId });
  const input = request("legacy", "act", {
    sessionId: old.sessionId,
    observationId: observation.body.observationId,
    action: { type: "activate" }
  });
  await inputStarted.promise;
  const queuedAdmitted = admitted();
  const queued = request("legacy", "observe", { sessionId: old.sessionId });
  await queuedAdmitted;
  await close();
  inputFinished.resolve();
  assert.notEqual((await input).status, 200);
  assert.equal((await queued).status, 403);
  assert.equal(shortcut, false);
  assert.deepEqual(effects, []);
  assert.equal((await request("legacy", "observe", { sessionId: old.sessionId })).status, 403);
  assert.equal(
    (
      await request("legacy", "act", {
        sessionId: old.sessionId,
        observationId: observation.body.observationId,
        action: { type: "activate" }
      })
    ).status,
    403
  );
  assert.equal(dashboard.routePorts.computer.current("legacy").state, "ended");

  statusGate = gate();
  const late = assert.rejects(authorize(), /取消/);
  await authorizationStarted.promise;
  await close();
  const held = statusGate;
  statusGate = undefined;
  held.resolve();
  await late;
  assert.equal(dashboard.routePorts.computer.current("legacy").state, "ended");
  assert.equal((await request("legacy", "observe", { sessionId: old.sessionId })).status, 403);

  // A human resume still restores a legacy grant while global policy stays off.
  const legacy = await authorize();
  await controller.request({ operation: "pause" });
  await controller.request({ operation: "resume" });
  const resumed = dashboard.routePorts.computer.current("legacy");
  assert.equal(resumed.state, "active");
  assert.notEqual(resumed.sessionId, legacy.sessionId);
  assert.equal((await request("legacy", "observe", { sessionId: resumed.sessionId })).status, 200);
  assert.equal(store.snapshot().enabled, false);
  await close();
  assert.equal((await request("legacy", "observe", { sessionId: resumed.sessionId })).status, 403);
});

test("a delayed first selection lets its Task switch windows while other Tasks retain FIFO ownership through HTTP", async (t) => {
  const firstStarted = gate(),
    firstFinished = gate();
  let calls = 0;
  const effects = [];
  const { dashboard, task, request, admitted } = await fixture(
    t,
    {
      status: async () => {
        if (++calls === 1) {
          firstStarted.resolve();
          await firstFinished.promise;
        }
        return status;
      },
      observe: async (selected) => {
        effects.push(["observe", selected.windowId]);
        return frame;
      },
      act: async (selected, action) => effects.push([action.type, selected.windowId])
    },
    () => firstFinished.resolve()
  );
  for (const id of ["a", "b", "c"]) await task(id);
  await dashboard.computerHostRequest({ operation: "policy", enabled: true, mode: "control" });
  const select = (id, windowId) => request(id, "select", { pid: 11, windowId, mode: "control" });
  const first = select("a", 12);
  await firstStarted.promise;
  const b = select("b", 12);
  await waitFor(() => dashboard.routePorts.computer.access().waitingTaskIds.includes("b"));
  const c = select("c", 13);
  await waitFor(() => dashboard.routePorts.computer.access().waitingTaskIds.includes("c"));
  const nextAdmitted = admitted();
  const next = select("a", 13);
  await nextAdmitted;
  firstFinished.resolve();
  const original = (await first).body.session;
  const switched = await bounded(next);
  assert.equal(switched.status, 200);
  const a = switched.body.session;
  assert.notEqual(a.sessionId, original.sessionId);
  assert.equal(a.target.windowId, 13);
  assert.deepEqual(dashboard.routePorts.computer.access().waitingTaskIds, ["b", "c"]);
  assert.equal((await request("a", "observe", { sessionId: original.sessionId })).status, 403);
  assert.equal((await request("a", "observe", { sessionId: a.sessionId })).status, 200);
  assert.equal((await request("a", "release", { sessionId: a.sessionId })).status, 200);

  const bSession = (await bounded(b)).body.session;
  assert.equal(dashboard.routePorts.computer.access().owner.taskId, "b");
  assert.deepEqual(dashboard.routePorts.computer.access().waitingTaskIds, ["c"]);
  const bObserved = await request("b", "observe", { sessionId: bSession.sessionId });
  assert.equal(
    (
      await request("b", "act", {
        sessionId: bSession.sessionId,
        observationId: bObserved.body.observationId,
        action: { type: "activate" }
      })
    ).status,
    200
  );
  assert.equal((await request("b", "release", { sessionId: bSession.sessionId })).status, 200);
  const cSession = (await bounded(c)).body.session;
  assert.equal(dashboard.routePorts.computer.access().owner.taskId, "c");
  assert.equal((await request("b", "observe", { sessionId: cSession.sessionId })).status, 403);
  assert.equal((await request("c", "observe", { sessionId: cSession.sessionId })).status, 200);
  assert.deepEqual(effects, [
    ["observe", 13],
    ["observe", 12],
    ["activate", 12],
    ["observe", 13]
  ]);
  assert.equal((await request("c", "release", { sessionId: cSession.sessionId })).status, 200);
});

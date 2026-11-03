import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CadKernelClient } from "../web/assets/cad/kernel-client.js";
import { createApplicationApi } from "../web/assets/workbench/api.js";

const model = { engine: "cadquery" };
const geometry = () => ({ positions: [0, 0, 0], features: [{ positions: [0, 0, 0] }] });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};

test("preview HTTP preserves body read failures instead of returning empty success", async (t) => {
  let failure;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => {
      throw failure;
    }
  }));
  const api = createApplicationApi();
  for (const error of [new SyntaxError("Invalid JSON"), new DOMException("Body aborted", "AbortError")]) {
    failure = error;
    await assert.rejects(
      api.previewResource("task-a", "resource-a", model),
      (received) => received === error
    );
  }
});

test("malformed native preview replies reject normally and a later preview can recover", async () => {
  let response = {};
  const client = new CadKernelClient({ preview: async () => response });
  await assert.rejects(client.request("mesh", model), /预览响应不完整/);
  assert.equal(client.pending, null);
  response = geometry();
  const result = await client.request("mesh", model);
  assert.ok(result.positions instanceof Float32Array);
  assert.ok(result.features[0].positions instanceof Float32Array);
  client.dispose();
});

for (const completion of ["malformed reply", "body read failure"])
  test(`a cancelled preview ignores a late ${completion} without disrupting its replacement`, async () => {
    const obsolete = deferred(),
      current = deferred();
    let calls = 0,
      obsoleteSignal;
    const client = new CadKernelClient({
      preview: (_model, _options, signal) => {
        if (calls++ === 0) {
          obsoleteSignal = signal;
          return obsolete.promise;
        }
        return current.promise;
      }
    });
    const first = client.request("mesh", model);
    const second = client.request("mesh", model);
    assert.equal(await first, null);
    assert.equal(obsoleteSignal.aborted, true);
    if (completion === "malformed reply") obsolete.resolve({});
    else obsolete.reject(new DOMException("Body read aborted", "AbortError"));
    await delay(0);
    assert.ok(client.pending, "replacement remains active");
    current.resolve(geometry());
    assert.ok((await second).positions instanceof Float32Array);
    assert.equal(client.pending, null);
    client.dispose();
  });

test("native previews get the same 180 second default as the model tools and explicit deadlines stay explicit", async () => {
  const budgets = [];
  const client = new CadKernelClient({
    preview: async (_model, options) => {
      budgets.push(options.timeoutMs);
      return geometry();
    }
  });
  await client.request("mesh", model);
  await client.request("mesh", model, undefined, { timeoutMs: 20000 });
  await client.request("mesh", model, undefined, { timeoutMs: 600000 });
  assert.deepEqual(budgets, [180000, 20000, 600000]);
  client.dispose();
});

test("native preview budgets reject invalid values before starting or cancelling a job", async () => {
  let calls = 0;
  const pending = deferred();
  const client = new CadKernelClient({
    preview: async () => {
      calls++;
      return pending.promise;
    }
  });
  const result = client.request("mesh", model, undefined, { timeoutMs: 600000 });
  for (const timeoutMs of [0, -1, 600001, 180000.5, "180000", NaN, Infinity])
    await assert.rejects(client.request("mesh", model, undefined, { timeoutMs }), /预算/);
  assert.equal(calls, 1);
  assert.ok(client.pending, "invalid input does not cancel the valid preview");
  pending.resolve(geometry());
  assert.ok((await result).positions instanceof Float32Array);
  client.dispose();
});

test("browser geometry timeout includes worker startup, terminates the job and allows recovery", async (t) => {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
      this.terminated = false;
    }
    postMessage(message) {
      this.message = message;
    }
    terminate() {
      this.terminated = true;
    }
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.Worker;
    else globalThis.Worker = previous;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new CadKernelClient();
  const program = { version: 2, engine: "jscad" };
  const timedOut = assert.rejects(client.request("mesh", program, undefined, { timeoutMs: 50 }), /预览超时/);
  t.mock.timers.tick(49);
  assert.equal(workers[0].terminated, false);
  t.mock.timers.tick(1);
  await timedOut;
  assert.equal(workers[0].terminated, true);
  assert.equal(client.pending, null);
  const next = client.request("mesh", program, undefined, { timeoutMs: 50 });
  workers[1].onmessage({ data: { id: workers[1].message.id, ...geometry() } });
  assert.deepEqual((await next).features, geometry().features);
  assert.equal(workers[1].terminated, true);
  client.dispose();
});

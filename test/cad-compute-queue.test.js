import assert from "node:assert/strict";
import { test } from "node:test";
import { CadComputeQueue } from "../dist/src/software/cad/compute-queue.js";

test("CAD admission limits active work and preserves FIFO without duplicate releases", async () => {
  const queue = new CadComputeQueue({ maxConcurrent: 1, maxQueued: 2, maxQueueWaitMs: 1000 });
  const first = await queue.acquire();
  const order = [];
  const second = queue.acquire().then((release) => {
    order.push("second");
    return release;
  });
  const third = queue.acquire().then((release) => {
    order.push("third");
    return release;
  });
  await assert.rejects(queue.acquire(), /队列已满/);
  assert.deepEqual(order, []);
  first();
  first();
  const releaseSecond = await second;
  assert.deepEqual(order, ["second"]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, ["second", "third"]);
  releaseThird();
  (await queue.acquire())();
});

test("CAD queued cancellation removes the job and leaves its slot usable", async () => {
  const queue = new CadComputeQueue({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 1000 });
  const release = await queue.acquire();
  const controller = new AbortController();
  const cancelled = assert.rejects(queue.acquire(controller.signal), /已取消/);
  controller.abort();
  await cancelled;
  const admitted = queue.acquire();
  release();
  (await admitted)();
  await assert.rejects(queue.acquire(controller.signal), { name: "AbortError" });
  (await queue.acquire())();
});

test("CAD queue waits expire without consuming or leaking a compute slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CadComputeQueue({ maxConcurrent: 1, maxQueued: 1, maxQueueWaitMs: 1000 });
  const release = await queue.acquire();
  const expired = assert.rejects(queue.acquire(), /排队超时/);
  t.mock.timers.tick(1000);
  await expired;
  const admitted = queue.acquire();
  release();
  const finish = await admitted;
  t.mock.timers.tick(1000);
  finish();
  (await queue.acquire())();
});

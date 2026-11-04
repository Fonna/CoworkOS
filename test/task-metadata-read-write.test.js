import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

test("task metadata and state transitions survive a concurrent polling burst", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-task-read-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalWorkspaceStore(root);
  await store.createTask("task", { goal: "durable task state" });
  let writing = true;
  const deadline = Date.now() + 200;
  const readers = Array.from({ length: 4 }, async () => {
    while (writing && Date.now() < deadline) {
      const task = JSON.parse(await readFile(join(root, "task", "task.json"), "utf8"));
      assert.equal(task.taskId, "task");
    }
  });
  try {
    for (let index = 0; index < 80; index++) {
      if (index % 2 === 0) await store.updateTask("task", { title: `title-${index}` });
      else await store.transitionTask("task", Math.floor(index / 2) % 2 === 0 ? "running" : "waiting");
    }
  } finally {
    writing = false;
    await Promise.all(readers);
  }
  const task = await store.readTask("task");
  assert.equal(task.title, "title-78");
  assert.equal(task.status, "waiting");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-workspace-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new LocalWorkspaceStore(root) };
}

test("a new Task creates Main's advertised scratch directory before any files are written", async (t) => {
  const { root, store } = await fixture(t);
  await store.createTask("task", { goal: "prepare a presentation" });
  assert.equal((await stat(join(root, "task", "agents", "main", "work"))).isDirectory(), true);
});

test("starting a legacy Task restores its missing scratch directory and preserves saved state", async (t) => {
  const { root, store } = await fixture(t);
  await store.createTask("task", { goal: "keep the original goal" });
  const taskRoot = join(root, "task");
  const work = join(taskRoot, "agents", "main", "work");
  const memory = join(taskRoot, "agents", "main", "context", "memory.md");
  const artifact = join(taskRoot, "artifacts", "result.txt");
  await writeFile(memory, "SAVED_MEMORY");
  await writeFile(artifact, "SAVED_ARTIFACT");
  await rm(work, { recursive: true, force: true });
  await store.createRun("task", "resumed-run");
  assert.equal((await stat(work)).isDirectory(), true);
  assert.equal((await store.readTask("task")).goal, "keep the original goal");
  assert.equal(await readFile(memory, "utf8"), "SAVED_MEMORY");
  assert.equal(await readFile(artifact, "utf8"), "SAVED_ARTIFACT");
  await writeFile(join(work, "draft.txt"), "SAVED_DRAFT");
  await store.createTask("task");
  assert.equal(await readFile(join(work, "draft.txt"), "utf8"), "SAVED_DRAFT");
});

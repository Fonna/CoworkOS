import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkbenchTabStore } from "../dist/src/applications/tab-store.js";
import { atomicWrite } from "../dist/src/applications/fs-utils.js";

test("tab updates survive concurrent readers and leave complete JSON without temporary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-tab-read-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "tabs.json");
  const tabs = new WorkbenchTabStore(path);
  await tabs.open({ kind: "conversation", taskId: "initial" });
  let writing = true;
  let reads = 0;
  const readerDeadline = Date.now() + 200;
  const readers = Array.from({ length: 4 }, async () => {
    while (writing && Date.now() < readerDeadline) {
      const document = JSON.parse(await readFile(path, "utf8"));
      assert.equal(document.version, 2);
      assert.ok(document.tabs.length > 0);
      reads++;
    }
  });
  try {
    for (let index = 0; index < 80; index++) {
      await tabs.open({ kind: "conversation", taskId: `task-${index}` });
    }
  } finally {
    writing = false;
    await Promise.all(readers);
  }
  assert.ok(reads > 0);
  assert.equal((await tabs.read()).activeTabId, "conversation:task-79");
  assert.deepEqual(await readdir(root), ["tabs.json"]);
});

test("failed atomic replacement preserves the destination and cleans its temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cowork-atomic-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protectedPath = join(root, "protected");
  await mkdir(protectedPath);
  await writeFile(join(protectedPath, "original.txt"), "keep this content");
  await assert.rejects(atomicWrite(protectedPath, "must not replace the directory"));
  assert.equal(await readFile(join(protectedPath, "original.txt"), "utf8"), "keep this content");
  assert.deepEqual(await readdir(root), ["protected"]);
  const existing = join(root, "existing.txt");
  await writeFile(existing, "original");
  await assert.rejects(atomicWrite(existing, "replacement", { exclusive: true }), { code: "EEXIST" });
  assert.equal(await readFile(existing, "utf8"), "original");
  assert.deepEqual((await readdir(root)).sort(), ["existing.txt", "protected"]);
});

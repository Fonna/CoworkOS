import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rm } from "node:fs/promises";
import { createWatcher } from "../watcher/rule.mjs";
import { fixture } from "./support.mjs";

test("new files, stable updates, deletion and recreation produce distinct transitions", async (t) => {
  const lab = await fixture(t);
  const rule = createWatcher({ stableChecks: 2, maxBytes: 100 });
  assert.deepEqual(await lab.poll(rule), []);
  await lab.write("checkpoint-v1");
  assert.deepEqual(await lab.poll(rule), []);
  const [created] = await lab.poll(rule);
  assert.equal(created.type, "resource.created");
  assert.deepEqual(await lab.poll(createWatcher({ stableChecks: 2, maxBytes: 100 })), []);
  await lab.write("partial");
  await lab.poll(rule);
  await lab.write("checkpoint-v2");
  assert.deepEqual(await lab.poll(rule), [], "changing content must settle again");
  assert.equal((await lab.poll(rule))[0].type, "resource.changed");
  await rm(lab.input);
  await lab.poll(rule);
  assert.equal((await lab.poll(rule))[0].type, "resource.deleted");
  await lab.write("checkpoint-v1");
  await lab.poll(rule);
  const [recreated] = await lab.poll(rule);
  assert.equal(recreated.type, "resource.created");
  assert.notEqual(recreated.dedupeKey, created.dedupeKey);
});

test("the first existing file is a baseline and identical content is unchanged", async (t) => {
  const lab = await fixture(t);
  await lab.write("existing");
  const rule = createWatcher();
  assert.deepEqual(await lab.poll(rule), []);
  await lab.write("existing");
  assert.deepEqual(await lab.poll(rule), []);
  assert.deepEqual(await lab.poll(rule), []);
});

test("directories, oversized files and invalid settings fail without hiding observation errors", async (t) => {
  const lab = await fixture(t);
  const rule = createWatcher({ maxBytes: 10 });
  await lab.poll(rule);
  await lab.write("x".repeat(11));
  await assert.rejects(lab.poll(rule), /maxBytes/);
  await rm(lab.input);
  await mkdir(lab.input);
  await assert.rejects(lab.poll(rule), /regular file/);
  await assert.rejects(lab.poll(createWatcher({ stableChecks: 0 })), /configuration/);
});

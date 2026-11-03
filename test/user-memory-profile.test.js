import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UserMemoryStore,
  userMemoryText,
  userMemoryRevision,
  userMemoryContext
} from "../dist/src/runtime/user-memory-store.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-memory-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new UserMemoryStore(join(root, "memory.json"));
}
const source = { taskId: "settings", runId: "settings", quote: "manual", origin: "settings" };

test("one profile supports 2000 characters, replacement and clearing while disabled", async (t) => {
  const store = await fixture(t);
  await store.saveText("字".repeat(2000), userMemoryRevision(await store.read()));
  assert.equal(userMemoryText(await store.read()).length, 2000);
  assert.equal((await store.read()).enabled, false);
  await assert.rejects(store.saveText("字".repeat(2001), userMemoryRevision(await store.read())));
  await store.saveText("新的偏好", userMemoryRevision(await store.read()));
  assert.equal(userMemoryText(await store.read()), "新的偏好");
  assert.equal((await store.read()).entries.length, 1);
  await store.saveText("", userMemoryRevision(await store.read()));
  assert.equal(userMemoryText(await store.read()), "");
});

test("the aggregate limit applies to tools and automatic learning, not per entry", async (t) => {
  const store = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  await store.remember({ content: "字".repeat(1990), category: "preference", scope: "user", source });
  await assert.rejects(
    store.remember({ content: "x".repeat(10), category: "background", scope: "user", source })
  );
  const text = "我长期希望简洁地回答技术问题";
  await store.enqueueLearning({ taskId: "task", runId: "run", text }, 0);
  const job = (await store.read()).pending[0];
  assert.equal(
    await store.applyLearning(job, [
      {
        action: "remember",
        content: "希望简洁地回答技术问题",
        category: "preference",
        scope: "user",
        quote: text,
        durability: "persistent",
        evidence: "direct"
      }
    ]),
    0
  );
  assert.equal(userMemoryText(await store.read()).length, 1990);
});

test("manual save rejects stale edits and in-flight automatic results without losing queued input", async (t) => {
  const store = await fixture(t);
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  const revision = userMemoryRevision(await store.read());
  const text = "我平时喜欢用中文进行交流";
  await store.enqueueLearning({ taskId: "task", runId: "run", text }, 0);
  const job = (await store.read()).pending[0];
  await store.saveText("我喜欢英文", revision);
  await assert.rejects(store.saveText("过期编辑", revision));
  assert.equal(
    await store.applyLearning(job, [
      {
        action: "remember",
        content: "喜欢中文",
        category: "preference",
        scope: "user",
        quote: text,
        durability: "persistent",
        evidence: "direct"
      }
    ]),
    0
  );
  assert.equal(userMemoryText(await store.read()), "我喜欢英文");
  assert.equal((await store.read()).pending.length, 1);
});

test("old fragments remain readable, over-limit legacy content is never silently truncated", async (t) => {
  const store = await fixture(t);
  await store.remember({ content: "旧偏好", category: "preference", scope: "user", source });
  await store.remember({ content: "旧背景", category: "background", scope: "user", source });
  assert.equal(userMemoryText(await store.read()), "旧偏好\n旧背景");
  const legacy = await store.read();
  legacy.entries[0].content = "a".repeat(1500);
  legacy.entries[1].content = "b".repeat(1500);
  await writeFile(store.path, JSON.stringify(legacy));
  const original = await readFile(store.path, "utf8");
  assert.equal(userMemoryText(await store.read()).length, 3001);
  assert.equal(await readFile(store.path, "utf8"), original);
  await store.saveText("已精简的记忆", userMemoryRevision(await store.read()));
  assert.equal(userMemoryText(await store.read()), "已精简的记忆");
});

test("editing user profile does not promote or erase legacy project-scoped facts", async (t) => {
  const store = await fixture(t);
  await store.remember({
    content: "项目约定",
    category: "constraint",
    scope: "project",
    projectDirectory: "/fixture/one",
    source
  });
  await store.saveText("个人偏好", userMemoryRevision(await store.read()));
  await store.setEnabled(true);
  await store.setLearningEnabled(true);
  assert.equal(userMemoryText(await store.read()), "个人偏好");
  assert.match(await userMemoryContext(store, "/fixture/one"), /项目约定/);
  assert.doesNotMatch(await userMemoryContext(store, "/fixture/two"), /项目约定/);
});

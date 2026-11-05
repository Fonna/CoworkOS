import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalContextChat } from "../dist/src/runtime/personal-context-chat.js";
import { PersonalContextStore } from "../dist/src/runtime/personal-context-store.js";
import { PersonalContextManagement } from "../dist/src/runtime/personal-context-management.js";
import { personalContextWithinBudget } from "../dist/src/runtime/user-memory-context.js";

const fact = {
  kind: "arrangement",
  status: "confirmed",
  title: "上海出差",
  content: "BOOKED_TRIP",
  visibility: "user",
  quote: "请保存我的上海出差安排",
  observedAt: "2026-11-05T08:00:00Z",
  startsAt: "2026-11-20T08:00:00+08:00",
  endsAt: "2026-11-22T18:00:00+08:00",
  timeZone: "Asia/Shanghai"
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "personal-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PersonalContextStore({ path: join(root, "context.json") });
  await store.transaction((d) => {
    d.settings.enabled = true;
  });
  const create = (taskId = "a", assess) =>
    new PersonalContextChat({
      store,
      workspaceRoot: root,
      taskId,
      runId: `run-${taskId}`,
      assess: assess ?? (async () => ({ authorized: true, sensitive: false, statement: "self_report" })),
      now: () => Date.parse("2026-11-05T08:00:00Z")
    });
  return { store, create };
}
function source(id, text = fact.quote) {
  return { messageId: id, receivedAt: "2026-11-05T08:00:00Z", text };
}
test("chat saves once, projects only relevant requests across Tasks and refreshes cancellation", async (t) => {
  const { store, create } = await fixture(t);
  const a = create();
  a.setSource(source("m1"));
  const saved = await a.tool.execute({ action: "save", context: fact });
  assert.deepEqual(await a.tool.execute({ action: "save", context: fact }), saved);
  const b = create("b");
  b.setSource(source("m2", "帮我安排上海出差期间的会议"));
  assert.match(await b.project(), /BOOKED_TRIP/);
  b.setSource(source("m3", "帮我修复 Python 文件"));
  assert.doesNotMatch(await b.project(), /BOOKED_TRIP/);
  a.setSource(source("m4", "取消上海出差，请更新记录"));
  await a.tool.execute({
    action: "update",
    id: saved.id,
    revision: saved.revision,
    context: { ...fact, status: "cancelled", quote: "取消上海出差，请更新记录" }
  });
  b.setSource(source("m5", "查看上海出差安排"));
  assert.match(await b.project(), /cancelled/);
  assert.equal((await store.read()).records.length, 1);
});
test("chat cannot turn arbitrary tool text, a hypothetical or denied assessment into saved context", async (t) => {
  const { store, create } = await fixture(t);
  const chat = create();
  await assert.rejects(chat.tool.execute({ action: "save", context: fact }));
  chat.setSource(source("m1", "假如我去上海，请保存我的上海出差安排"));
  await assert.rejects(chat.tool.execute({ action: "save", context: fact }));
  const denied = create("b", async () => ({ authorized: false, sensitive: true, statement: "self_report" }));
  denied.setSource(source("m2"));
  await assert.rejects(denied.tool.execute({ action: "save", context: fact }));
  assert.equal((await store.read()).records.length, 0);
});
test("old in-flight classifier cannot write after a new user turn or deletion", async (t) => {
  const { create } = await fixture(t);
  let release;
  const chat = create(
    "a",
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  chat.setSource(source("m1"));
  const write = chat.tool.execute({ action: "save", context: fact });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  chat.setSource(source("m2", "停止"));
  release({ authorized: true, sensitive: false, statement: "self_report" });
  await assert.rejects(write);
});

test("historical query results are revoked after deletion, consent changes or a new unrelated user message", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1"));
  const saved = await chat.tool.execute({ action: "save", context: fact });
  chat.setSource(source("m2", "查看我的上海出差安排"));
  const query = await chat.tool.execute({ action: "query" });
  const messages = [
    {
      role: "toolResult",
      toolCallId: "t",
      toolName: "manage_personal_context",
      timestamp: 1,
      content: [{ type: "text", text: JSON.stringify(query) }],
      details: query,
      isError: false
    }
  ];
  assert.match(JSON.stringify(await chat.refreshMessages(messages)), /BOOKED_TRIP/);
  chat.setSource(source("m3", "帮我修复 Python 代码"));
  assert.doesNotMatch(JSON.stringify(await chat.refreshMessages(messages)), /BOOKED_TRIP/);
  chat.setSource(source("m2", "查看我的上海出差安排"));
  const manager = new PersonalContextManagement(store),
    view = await manager.overview();
  await manager.change({
    basis: view.basis,
    snapshotRevision: view.snapshotRevision,
    change: { action: "forget", id: saved.id, revision: saved.revision }
  });
  assert.doesNotMatch(JSON.stringify(await chat.refreshMessages(messages)), /BOOKED_TRIP/);
  assert.doesNotMatch(await chat.project(), /BOOKED_TRIP/);
});
test("changing global settings while a classifier is running blocks its late commit", async (t) => {
  const { create, store } = await fixture(t);
  let release;
  const chat = create(
    "a",
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  chat.setSource(source("m1"));
  const pending = chat.tool.execute({ action: "save", context: fact });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  const manager = new PersonalContextManagement(store),
    view = await manager.overview();
  await manager.change({
    basis: view.basis,
    snapshotRevision: view.snapshotRevision,
    change: { action: "settings", settings: { enabled: false } }
  });
  release({ authorized: true, sensitive: false, statement: "self_report" });
  await assert.rejects(pending);
  assert.equal((await store.read()).records.length, 0);
});
test("private/task data is filtered, model-provided source fields reject, and repeated save payloads cannot create duplicates", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1"));
  await assert.rejects(
    chat.tool.execute({ action: "save", context: fact, authorized: true, messageId: "forged" })
  );
  await chat.tool.execute({ action: "save", context: { ...fact, visibility: "task" } });
  await assert.rejects(
    chat.tool.execute({
      action: "save",
      context: { ...fact, visibility: "task", title: "changed duplicate" }
    })
  );
  const other = create("other");
  other.setSource(source("m2", "查看我的上海出差安排"));
  assert.doesNotMatch(await other.project(), /BOOKED_TRIP/);
  const sensitive = create("s", async () => ({
    authorized: true,
    sensitive: true,
    statement: "self_report"
  }));
  sensitive.setSource(source("s1"));
  await assert.rejects(sensitive.tool.execute({ action: "save", context: fact }));
  assert.equal((await store.read()).records.length, 1);
});
test("budget omission keeps the conversation and marks the personal check incomplete", () => {
  const messages = [
    { role: "system", content: "test", sections: { identity: "test" } },
    { role: "user", content: "请安排我的行程", timestamp: 1 }
  ];
  const result = personalContextWithinBudget(messages, "X".repeat(20000), {
    contextWindow: 1500,
    reserveTokens: 100,
    maxTokens: 100
  });
  assert.match(result[0].sections.personal_context, /omitted for input budget/);
  assert.equal(result[1].content, messages[1].content);
});

test("registration switch permits clear reports only through the independent assessment and never enables use", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1", "我的上海出差已经确认"));
  await assert.rejects(
    chat.tool.execute({ action: "save", context: { ...fact, quote: "我的上海出差已经确认" } })
  );
  const manager = new PersonalContextManagement(store),
    view = await manager.overview();
  await manager.change({
    basis: view.basis,
    snapshotRevision: view.snapshotRevision,
    change: { action: "settings", settings: { enabled: false, registrationEnabled: true } }
  });
  chat.setSource(source("m2", "我的上海出差已经确认"));
  await chat.tool.execute({ action: "save", context: { ...fact, quote: "我的上海出差已经确认" } });
  const doc = await store.read();
  assert.equal(doc.records.length, 1);
  assert.equal(doc.settings.enabled, false);
  assert.doesNotMatch(await chat.project(), /BOOKED_TRIP/);
});

test("an old chat read cannot reactivate after an off/on generation change", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1"));
  await chat.tool.execute({ action: "save", context: fact });
  chat.setSource(source("m2", "查看我的上海出差安排"));
  assert.match(await chat.project(), /BOOKED_TRIP/);
  const manager = new PersonalContextManagement(store);
  for (const enabled of [false, true]) {
    const view = await manager.overview();
    await manager.change({
      basis: view.basis,
      snapshotRevision: view.snapshotRevision,
      change: { action: "settings", settings: { enabled } }
    });
  }
  assert.doesNotMatch(await chat.project(), /BOOKED_TRIP/);
  await assert.rejects(chat.tool.execute({ action: "query" }));
  chat.setSource(source("m3", "查看我的上海出差安排"));
  assert.match(await chat.project(), /BOOKED_TRIP/);
});

test("a failed tool call keeps its real error after settings revoke the current request", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1"));
  await chat.project();
  const manager = new PersonalContextManagement(store);
  const view = await manager.overview();
  await manager.change({
    basis: view.basis,
    snapshotRevision: view.snapshotRevision,
    change: { action: "settings", settings: { registrationEnabled: true } }
  });
  let failure;
  await assert.rejects(chat.tool.execute({ action: "save", context: fact }), (error) => {
    failure = error;
    return error.code === "conflict";
  });
  const message = {
    role: "toolResult",
    toolCallId: "failed-save",
    toolName: "manage_personal_context",
    timestamp: 1,
    content: [{ type: "text", text: failure.message }],
    isError: true
  };
  assert.deepEqual(await chat.refreshMessages([message]), [message]);
  assert.match(failure.message, /resend/i);
  assert.equal((await store.read()).records.length, 0);
});

test("every trusted source gets its receipt time even when use is off or the topic is unrelated", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  await store.transaction((doc) => {
    doc.settings.enabled = false;
  });
  chat.setSource(source("m1", "我本月15号要去办理一项手续"));
  assert.match(await chat.project(), /receivedAt=2026-11-05T08:00:00Z; timezone=/);
  chat.setSource(source("m2", "帮我写一个程序"));
  assert.match(await chat.project(), /receivedAt=2026-11-05T08:00:00Z; timezone=/);
  assert.doesNotMatch(await chat.project(), /BOOKED_TRIP/);
});

test("first-person dated intentions can query arrangements without a special schedule keyword", async (t) => {
  const { create } = await fixture(t);
  const chat = create();
  chat.setSource(source("m1"));
  await chat.tool.execute({ action: "save", context: fact });
  chat.setSource(source("m2", "我本月15号要去办理手续"));
  assert.equal((await chat.tool.execute({ action: "query" })).records.length, 1);
  chat.setSource(source("m3", "假如我本月15号要去办理手续"));
  await assert.rejects(chat.tool.execute({ action: "query" }));
  chat.setSource(source("m4", "我本月15号要去写一段代码"));
  await assert.rejects(chat.tool.execute({ action: "query" }));
});

test("an authorized sensitive arrangement still requires the separate sensitive processing switch", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create("a", async () => ({ authorized: true, sensitive: true, statement: "self_report" }));
  chat.setSource(source("m1"));
  await assert.rejects(
    chat.tool.execute({ action: "save", context: fact }),
    (error) => error.code === "permission_denied"
  );
  assert.equal((await store.read()).records.length, 0);
});

test("personal overviews read across chats without requiring schedule vocabulary", async (t) => {
  const { create } = await fixture(t);
  const writer = create();
  writer.setSource(source("save"));
  await writer.tool.execute({ action: "save", context: { ...fact, status: "tentative" } });
  for (const text of [
    "最近我有什么事",
    "我最近有哪些事情要处理",
    "我接下来要做什么",
    "今天我有什么待办",
    "最近有什么事",
    "这周有什么需要我注意的事",
    "帮我回顾一下近期事项",
    "帮我记录下，晚上提醒家人是否参加寒假研学营",
    "What do I need to do next?",
    "What's coming up for me?",
    "Show my upcoming tasks."
  ]) {
    await t.test(text, async () => {
      const reader = create("other");
      reader.setSource(source(text, text));
      const projection = await reader.project();
      assert.match(projection, /BOOKED_TRIP/);
      const result = await reader.tool.execute({ action: "query" });
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].status, "tentative");
      assert.equal(result.records[0].validity, "needs_review");
      const message = {
        role: "toolResult",
        toolName: "manage_personal_context",
        toolCallId: "overview",
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false,
        timestamp: 1
      };
      assert.deepEqual(await reader.refreshMessages([message]), [message]);
    });
  }
});

test("overview admission still excludes unrelated, third-party and fictional requests with a distinct diagnosis", async (t) => {
  const { create } = await fixture(t);
  const writer = create();
  writer.setSource(source("save"));
  await writer.tool.execute({ action: "save", context: fact });
  for (const text of [
    "我有什么代码问题",
    "最近有什么新闻",
    "最近同事有什么事",
    "他最近有什么事",
    "最近他有什么事",
    "张三最近有什么事",
    "我的朋友最近有什么事",
    "假如我最近有什么事，怎么安排",
    "请代写我最近有什么事",
    "最近有什么事情适合写进小说",
    "我有哪些数据库表",
    "我接下来要做什么程序"
  ]) {
    await t.test(text, async () => {
      const reader = create("other");
      reader.setSource(source(text, text));
      assert.doesNotMatch(await reader.project(), /BOOKED_TRIP/);
      await assert.rejects(reader.tool.execute({ action: "query" }), (error) => {
        assert.equal(error.code, "request_not_relevant");
        assert.doesNotMatch(error.message, /permission_denied|BOOKED_TRIP/);
        return true;
      });
    });
  }
});

test("personal overviews retain use, sensitive and task-scope boundaries", async (t) => {
  const { create, store } = await fixture(t);
  const writer = create();
  writer.setSource(source("public"));
  await writer.tool.execute({ action: "save", context: fact });
  writer.setSource(source("task-only"));
  await writer.tool.execute({
    action: "save",
    context: { ...fact, visibility: "task", content: "TASK_ONLY" }
  });
  const manager = new PersonalContextManagement(store);
  async function settings(settings) {
    const view = await manager.overview();
    await manager.change({
      basis: view.basis,
      snapshotRevision: view.snapshotRevision,
      change: { action: "settings", settings }
    });
  }
  await settings({ sensitiveEnabled: true });
  const sensitive = create("sensitive", async () => ({
    authorized: true,
    sensitive: true,
    statement: "self_report"
  }));
  sensitive.setSource(source("sensitive"));
  await sensitive.tool.execute({ action: "save", context: { ...fact, content: "SENSITIVE_ONLY" } });
  const reader = create("other");
  reader.setSource(source("read-1", "最近我有什么事"));
  let result = await reader.tool.execute({ action: "query" });
  assert.equal(result.records.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /TASK_ONLY/);
  await settings({ sensitiveEnabled: false });
  reader.setSource(source("read-2", "最近我有什么事"));
  result = await reader.tool.execute({ action: "query" });
  assert.equal(result.records.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /TASK_ONLY|SENSITIVE_ONLY/);
  await settings({ enabled: false });
  reader.setSource(source("read-3", "最近我有什么事"));
  result = await reader.tool.execute({ action: "query" });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.records, []);
  assert.doesNotMatch(await reader.project(), /BOOKED_TRIP|TASK_ONLY|SENSITIVE_ONLY/);
  assert.equal((await store.read()).records.length, 3, "reading never removes or duplicates records");
});

test("invalid record kinds have actionable errors and a per-message correction budget", async (t) => {
  const { create, store } = await fixture(t);
  let assessments = 0;
  const chat = create("a", async () => {
    assessments++;
    return { authorized: true, sensitive: false, statement: "self_report" };
  });
  const quote = "帮我记录下，晚上问家人是否参加冬令营，日期和具体时间还未定";
  chat.setSource(source("invalid-kind", quote));
  const invalid = {
    ...fact,
    kind: "temporary_state",
    status: "active",
    quote,
    reviewAt: "2026-11-05T19:00:00+08:00"
  };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(chat.tool.execute({ action: "save", context: invalid }), (error) => {
      assert.equal(error.code, "invalid_request");
      assert.match(error.message, /temporary_state.*timeZone/);
      assert.match(error.message, /arrangement/);
      return true;
    });
  }
  chat.setSource(source("invalid-kind", quote));
  await assert.rejects(
    chat.tool.execute({
      action: "save",
      context: { ...fact, quote, startsAt: undefined, endsAt: undefined }
    }),
    (error) => error.code === "write_attempts_exhausted"
  );
  assert.equal(assessments, 0);
  assert.equal((await store.read()).records.length, 0);
  chat.setSource(source("fresh-message", quote));
  const result = await chat.tool.execute({
    action: "save",
    context: { ...fact, quote, status: "tentative", startsAt: undefined, endsAt: undefined }
  });
  assert.ok(result.id);
  assert.equal(assessments, 1);
});

test("one corrected proposal may save without fabricating event times or a scheduled reminder", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  const quote = "请记录我的安排：今晚询问家人是否参加寒假两天的公开研学活动，具体日期待定";
  chat.setSource(source("m1", quote));
  await assert.rejects(
    chat.tool.execute({
      action: "save",
      context: {
        ...fact,
        kind: "temporary_state",
        status: "active",
        quote
      }
    })
  );
  const saved = await chat.tool.execute({
    action: "save",
    context: {
      ...fact,
      quote,
      status: "tentative",
      startsAt: undefined,
      endsAt: undefined,
      title: "今晚询问研学意向",
      content: "今晚询问家人是否参加寒假研学活动，活动日期待定。"
    }
  });
  assert.equal(saved.reminderScheduled, false);
  const record = (await store.read()).records[0];
  assert.equal(record.kind, "arrangement");
  assert.equal(record.startsAt, undefined);
  assert.equal(record.endsAt, undefined);
  assert.equal(record.status, "tentative");
});

test("denied semantic checks cannot be retried with a changed kind or scope", async (t) => {
  const { create, store } = await fixture(t);
  let assessments = 0;
  const chat = create("a", async () => {
    assessments++;
    return { authorized: false, sensitive: false, statement: "self_report" };
  });
  chat.setSource(source("m1"));
  await assert.rejects(chat.tool.execute({ action: "save", context: fact }));
  await assert.rejects(
    chat.tool.execute({ action: "save", context: { ...fact, visibility: "task" } }),
    (error) => error.code === "write_attempts_exhausted"
  );
  assert.equal(assessments, 1);
  assert.equal((await store.read()).records.length, 0);
});

test("quote evidence tolerates whitespace presentation but persists the original source span", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  const original = "请记录我的2027\u00a0寒假研学安排，日期待定";
  chat.setSource(source("whitespace", original));
  await chat.tool.execute({
    action: "save",
    context: {
      ...fact,
      status: "tentative",
      quote: original.replace("\u00a0", " "),
      startsAt: undefined,
      endsAt: undefined
    }
  });
  assert.equal((await store.read()).records[0].quote, original);
  chat.setSource(source("changed-words", original));
  await assert.rejects(
    chat.tool.execute({
      action: "save",
      context: {
        ...fact,
        quote: original.replace("研学", "旅游")
      }
    }),
    (error) => error.code === "source_rejected"
  );
  assert.equal((await store.read()).records.length, 1);
});

test("vague arrangement times never become exact starts, review deadlines or automatic expiry", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  const quote = "帮我记录下，晚上询问家人是否参加寒假研学活动，具体时间未定";
  chat.setSource(source("vague", quote));
  const saved = await chat.tool.execute({
    action: "save",
    context: {
      ...fact,
      quote,
      status: "tentative",
      startsAt: "2026-11-05T19:00:00+08:00",
      endsAt: "2026-11-05T20:00:00+08:00",
      reviewAt: "2026-11-05T19:00:00+08:00",
      validFrom: "2026-11-05T18:00:00+08:00",
      validUntil: "2026-11-06T23:59:00+08:00"
    }
  });
  for (const key of ["startsAt", "endsAt", "reviewAt", "validFrom", "validUntil"])
    assert.equal((await store.read()).records[0][key], undefined, key);
  assert.deepEqual(saved.timeFieldsOmitted.sort(), [
    "endsAt",
    "reviewAt",
    "startsAt",
    "validFrom",
    "validUntil"
  ]);
  assert.equal(saved.reminderScheduled, false);
});

test("explicit clock times remain available and a status-only update preserves already known times", async (t) => {
  const { create, store } = await fixture(t);
  const chat = create();
  const quote = "请保存我的上海出差安排：11月20日8点至22日18点";
  chat.setSource(source("exact", quote));
  const saved = await chat.tool.execute({ action: "save", context: { ...fact, quote } });
  assert.equal((await store.read()).records[0].startsAt, fact.startsAt);
  chat.setSource(source("cancel", "取消我的上海出差安排"));
  await chat.tool.execute({
    action: "update",
    id: saved.id,
    revision: saved.revision,
    context: { ...fact, quote: "取消我的上海出差安排", status: "cancelled" }
  });
  assert.equal((await store.read()).records[0].startsAt, fact.startsAt);
});

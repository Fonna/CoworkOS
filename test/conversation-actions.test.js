import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationMarkdown,
  conversationTaskId,
  conversationUrl,
  createConversationReadState,
  safeFilename
} from "../web/assets/conversation-actions.js";
import { SUPERVISOR_WAKE_TURN } from "../web/assets/conversation.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test("unread markers persist and reload without changing another window's markers", () => {
  const storage = memoryStorage();
  const first = createConversationReadState(storage);
  const second = createConversationReadState(storage);
  assert.equal(first.isUnread("task-a"), false);
  assert.equal(first.setUnread("task-a", true), true);
  assert.equal(second.setUnread("task-b", true), true);
  first.reload();
  assert.equal(first.isUnread("task-b"), true);
  assert.equal(first.setUnread("task-a", false), true);
  second.reload();
  assert.equal(second.isUnread("task-a"), false);
  assert.equal(second.isUnread("task-b"), true);
  assert.equal(createConversationReadState(storage).isUnread("task-b"), true);
});

test("blocked or absent storage retains in-memory markers and pending changes survive reload", () => {
  for (const storage of [
    undefined,
    {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      }
    }
  ]) {
    const state = createConversationReadState(storage);
    assert.equal(state.setUnread("task-a", true), false);
    state.reload();
    assert.equal(state.isUnread("task-a"), true);
    assert.equal(state.setUnread("task-a", false), false);
    state.reload();
    assert.equal(state.isUnread("task-a"), false);
  }
  const storage = memoryStorage();
  const write = storage.setItem;
  storage.setItem = () => {
    throw new Error("quota");
  };
  const state = createConversationReadState(storage);
  state.setUnread("task-a", true);
  state.reload();
  assert.equal(state.isUnread("task-a"), true);
  storage.setItem = write;
  assert.equal(state.setUnread("task-b", true), true);
  assert.equal(createConversationReadState(storage).isUnread("task-a"), true);
});

test("invalid stored data and unsafe task identifiers cannot create unread markers", () => {
  for (const value of ["{", "null", "[]", '{"version":2,"unread":["task-a"]}']) {
    const storage = { getItem: () => value, setItem() {} };
    assert.equal(createConversationReadState(storage).isUnread("task-a"), false);
  }
  const state = createConversationReadState({
    getItem: () => JSON.stringify({ version: 1, unread: [null, "../bad", "task-a"] }),
    setItem() {}
  });
  assert.equal(state.isUnread("task-a"), true);
  for (const taskId of ["", "../bad", "task/a", "x\n", null])
    assert.equal(state.setUnread(taskId, true), false);
});

test("Markdown exports preserve user/assistant Markdown and omit machine, thinking and tool records", () => {
  const answer = "**已完成**\n\n```js\nconsole.log('result');\n```";
  const detail = {
    task: { title: "检查脚本", model: "PRIVATE_MODEL_CONFIG", lastError: "PRIVATE_ERROR" },
    runtimeEvents: [{ type: "tool_execution_end", result: "PRIVATE_DIAGNOSTIC" }],
    messages: [
      { role: "system", content: "PRIVATE_SYSTEM_PROMPT" },
      { role: "user", content: "# 我的原始格式\n\n保留  两个空格" },
      { role: "user", content: SUPERVISOR_WAKE_TURN },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_THOUGHT" },
          { type: "toolCall", name: "bash", arguments: { command: "PRIVATE_COMMAND" } }
        ]
      },
      { role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: answer }],
        errorMessage: "PRIVATE_PROVIDER_ERROR"
      },
      { role: "user", delivery: "followUp", pending: true, content: "NOT_DELIVERED" }
    ]
  };
  const markdown = conversationMarkdown(detail);
  assert.ok(markdown.startsWith("# 检查脚本\n\n## 用户\n\n# 我的原始格式"));
  assert.ok(markdown.includes("保留  两个空格"));
  assert.ok(markdown.includes(`## 助手\n\n${answer}`));
  assert.doesNotMatch(markdown, /PRIVATE_|NOT_DELIVERED|Resume this task/);
  assert.equal((markdown.match(/^## /gm) || []).length, 2);
});

test("Markdown retains uploaded and legacy attachment names without metadata, binaries or extracted text", () => {
  const uploadId = "upload-00000000-0000-0000-0000-000000000000";
  const manifest = `\n\n<atria_uploaded_files>\n${JSON.stringify({ version: 1, files: [{ uploadId, name: "报告.pdf", kind: "pdf", path: "PRIVATE_INPUT_PATH", text: "PRIVATE_EXTRACTED_TEXT" }] })}\n</atria_uploaded_files>`;
  const markdown = conversationMarkdown({
    task: { goal: "附件分析\n较长目标" },
    messages: [
      { role: "user", content: `看下这个文件${manifest}` },
      { role: "user", content: "继续比较\n\nAttached files:\n--- notes.txt ---\nPRIVATE_LEGACY_TEXT" },
      {
        role: "user",
        content: [
          { type: "text", text: "分析图片" },
          { type: "image", name: "<img onerror=x>.png", data: "PRIVATE_BASE64", mimeType: "image/png" }
        ]
      }
    ]
  });
  assert.match(markdown, /^# 附件分析\n/);
  assert.ok(markdown.includes("报告\\.pdf"));
  assert.ok(markdown.includes("notes\\.txt"));
  assert.ok(markdown.includes("\\<img onerror=x\\>\\.png"));
  assert.doesNotMatch(markdown, /PRIVATE_|atria_uploaded_files|upload-0000|Attached files/);
});

test("empty and malformed message containers export a readable heading without object dumps", () => {
  assert.equal(conversationMarkdown(null), "# 会话\n\n暂无对话内容。\n");
  assert.equal(
    conversationMarkdown({ messages: {} }, { title: "自定义\n名称" }),
    "# 自定义 名称\n\n暂无对话内容。\n"
  );
  const markdown = conversationMarkdown({
    messages: [null, { role: "assistant", content: { private: "NO_OBJECT_DUMP" } }]
  });
  assert.doesNotMatch(markdown, /NO_OBJECT_DUMP|object Object/);
});

test("conversation links identify the requested task and remove unrelated workspace routes", () => {
  const target = conversationUrl("http://127.0.0.1:3881/?view=compact&task=old#goals/activity", "task-a");
  assert.equal(target, "http://127.0.0.1:3881/?view=compact&task=task-a");
  assert.equal(conversationTaskId(target), "task-a");
  assert.equal(conversationTaskId("https://example.test/?task=task-one_2"), "task-one_2");
  for (const url of [
    "bad",
    "http://localhost/",
    "http://localhost/?task=..%2Fprivate",
    "http://localhost/?task=task%0A",
    "javascript:alert(1)?task=task-a"
  ])
    assert.equal(conversationTaskId(url), null);
  assert.throws(() => conversationUrl("http://localhost/", "../private"), /无效的会话 ID/);
  assert.throws(() => conversationUrl("javascript:alert(1)", "task-a"), /无效的会话地址/);
});

test("download names remain safe across platforms and preserve readable Unicode titles", () => {
  assert.equal(safeFilename("发动机演示"), "发动机演示.md");
  assert.equal(safeFilename("existing.MD"), "existing.md");
  assert.equal(safeFilename('  report<>:"/\\|?* .  '), "report_________.md");
  assert.equal(safeFilename("../"), ".._.md");
  assert.equal(safeFilename("CON"), "_CON.md");
  assert.equal(safeFilename("nul.txt"), "_nul.txt.md");
  assert.equal(safeFilename("...."), "会话.md");
  assert.equal(safeFilename(""), "会话.md");
  const unicode = safeFilename("😀".repeat(200));
  assert.ok(Buffer.byteLength(unicode) <= 255);
  assert.doesNotMatch(safeFilename("secret\u202efile\u0000\nname"), /[\u0000-\u001f\u202a-\u202e]/);
});

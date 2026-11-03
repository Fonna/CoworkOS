import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createProjectExperienceController } from "../web/assets/controllers/project-experience.js";

const snapshot = (overrides = {}) => ({
  revision: "snapshot-1",
  settings: {
    enabled: false,
    learningEnabled: false,
    autoActivate: false,
    maxTokens: 2048,
    maxRequestsPerHour: 6
  },
  items: [],
  ...overrides
});
const entry = (overrides = {}) => ({
  id: "item-a",
  revision: "entry-1",
  kind: "experience",
  title: "项目约定",
  description: "修改前",
  content: "先运行项目检查",
  origin: "manual",
  state: "active",
  version: 1,
  versions: [{ version: 1, content: "先运行项目检查" }],
  sources: [],
  supportCount: 0,
  ...overrides
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let index = 0; index < 6; index++) await Promise.resolve();
};

function fixture(t, api) {
  const { document, window } = parseHTML("<html><body><button>入口</button></body></html>");
  const oldDocument = globalThis.document,
    oldWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = window;
  window.HTMLElement.prototype.getClientRects = () => [{}];
  window.confirm = () => true;
  t.after(() => {
    controller.close();
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  });
  const errors = [];
  const controller = createProjectExperienceController({ api, showToast: (message) => errors.push(message) });
  const $ = (selector) => document.querySelector(selector);
  const input = (selector, value) => {
    const field = $(selector);
    field.value = value;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  const submit = (selector) =>
    $(selector).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  return { controller, $, input, submit, errors, document, window };
}

test("project experience settings default off and save independent controls and model budget", async (t) => {
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push({ url, options });
    return options.method === "POST"
      ? snapshot({ revision: "snapshot-2", settings: JSON.parse(options.body).settings })
      : snapshot();
  });
  f.controller.open({ projectId: "project a", projectName: "甲项目" });
  await settle();
  for (const name of ["enabled", "learningEnabled", "autoActivate"])
    assert.equal(f.$(`[name=${name}]`).checked, false);
  const form = f.$("[data-settings]");
  f.$("[name=enabled]").checked = true;
  form.dispatchEvent(new f.window.Event("input", { bubbles: true }));
  f.input("[name=model]", "small-project-model");
  f.input("[name=maxTokens]", "1024");
  f.input("[name=maxRequestsPerHour]", "4");
  f.submit("[data-settings]");
  await settle();
  assert.equal(calls[1].url, "/api/projects/project%20a/experience");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: "configure",
    snapshotRevision: "snapshot-1",
    settings: {
      enabled: true,
      learningEnabled: false,
      autoActivate: false,
      model: "small-project-model",
      maxTokens: 1024,
      maxRequestsPerHour: 4
    }
  });
  assert.equal(f.$("[data-status]").textContent, "已保存");
});

test("closing and switching projects retain separate content drafts", async (t) => {
  const f = fixture(t, async () => snapshot());
  f.controller.open({ id: "a", name: "甲" });
  await settle();
  f.$('[data-new="skill"]').click();
  f.input("[data-editor] [name=title]", "甲技能");
  f.input("[data-editor] [name=content]", "甲项目独有步骤");
  f.controller.close();
  f.controller.open({ id: "b", name: "乙" });
  await settle();
  f.$('[data-new="experience"]').click();
  f.input("[data-editor] [name=title]", "乙经验");
  f.input("[data-editor] [name=content]", "乙项目独有结论");
  f.controller.open({ id: "a", name: "甲" });
  await settle();
  assert.equal(f.$("[data-editor] [name=title]").value, "甲技能");
  assert.equal(f.$("[data-editor] [name=content]").value, "甲项目独有步骤");
  f.controller.open({ id: "b", name: "乙" });
  await settle();
  assert.equal(f.$("[data-editor] [name=title]").value, "乙经验");
  assert.equal(f.$("[data-editor] [name=content]").value, "乙项目独有结论");
  const leaving = new f.window.Event("beforeunload", { cancelable: true });
  f.window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, true, "reload must warn before losing unsaved project drafts");
});

test("late reads from a closed or previous project never replace the current project", async (t) => {
  const first = deferred(),
    second = deferred();
  const f = fixture(t, async (url) => (url.includes("/a/") ? first.promise : second.promise));
  f.controller.open({ id: "a", name: "甲" });
  f.controller.open({ id: "b", name: "乙" });
  second.resolve(snapshot({ items: [entry({ title: "乙经验" })] }));
  await settle();
  first.resolve(snapshot({ items: [entry({ title: "甲经验" })] }));
  await settle();
  assert.match(f.$("[data-list]").textContent, /乙经验/);
  assert.doesNotMatch(f.$("[data-list]").textContent, /甲经验/);
  assert.equal(f.$("[data-project-name]").textContent, "乙");
});

test("a failed initial read keeps refresh and close available and recovers without losing the project", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    if (++calls === 1) throw new Error("暂时无法读取项目经验");
    return snapshot({ items: [entry()] });
  });
  f.controller.open({ id: "a", name: "甲" });
  await settle();
  assert.match(f.$("[data-error]").textContent, /暂时无法读取/);
  assert.equal(f.$('[data-new="experience"]').disabled, true);
  assert.equal(f.$("[data-refresh]").disabled, false);
  assert.equal(f.$("[data-close]").disabled, false);
  f.$("[data-refresh]").click();
  await settle();
  assert.equal(f.$("[data-error]").textContent, "");
  assert.equal(f.$('[data-new="experience"]').disabled, false);
  assert.match(f.$("[data-list]").textContent, /项目约定/);
});

test("revision conflicts preserve edits and refresh keeps the original draft revision", async (t) => {
  const calls = [];
  let reads = 0;
  const f = fixture(t, async (_url, options) => {
    if (options.method === "POST") {
      calls.push(JSON.parse(options.body));
      const error = new Error("changed");
      error.status = 409;
      throw error;
    }
    reads++;
    return snapshot({
      revision: reads === 1 ? "snapshot-1" : "snapshot-2",
      items: [entry(reads === 1 ? {} : { revision: "entry-2", content: "其他窗口的新内容" })]
    });
  });
  f.controller.open({ id: "a" });
  await settle();
  f.$('[data-action="edit"]').click();
  f.input("[data-editor] [name=content]", "必须保留的本地修改");
  f.submit("[data-editor]");
  await settle();
  assert.match(f.$("[data-error]").textContent, /草稿已保留/);
  assert.equal(f.$("[data-editor] [name=content]").value, "必须保留的本地修改");
  f.$("[data-refresh]").click();
  await settle();
  assert.equal(f.$("[data-editor] [name=content]").value, "必须保留的本地修改");
  f.submit("[data-editor]");
  await settle();
  assert.equal(
    calls[1].item.revision,
    "entry-1",
    "refresh must not turn a stale draft into a silent overwrite"
  );
  f.$("[data-reset]").click();
  assert.equal(f.$("[data-editor] [name=content]").value, "其他窗口的新内容");
});

test("a save accepted after project navigation only clears its source draft", async (t) => {
  const saving = deferred();
  const f = fixture(t, async (_url, options) => (options.method === "POST" ? saving.promise : snapshot()));
  f.controller.open({ id: "a", name: "甲" });
  await settle();
  f.$('[data-new="skill"]').click();
  f.input("[data-editor] [name=title]", "甲技能");
  f.input("[data-editor] [name=content]", "甲技能步骤");
  f.submit("[data-editor]");
  f.controller.open({ id: "b", name: "乙" });
  await settle();
  f.$('[data-new="experience"]').click();
  f.input("[data-editor] [name=title]", "乙草稿");
  f.input("[data-editor] [name=content]", "乙草稿内容");
  saving.resolve(snapshot({ revision: "saved-a", items: [entry({ title: "甲技能" })] }));
  await settle();
  assert.equal(f.$("[data-editor] [name=title]").value, "乙草稿");
  assert.equal(f.$("[data-editor] [name=content]").value, "乙草稿内容");
  assert.doesNotMatch(f.$("[data-list]").textContent, /甲技能/);
});

test("candidate evidence and version controls dispatch revision-checked changes without rendering source HTML", async (t) => {
  const calls = [];
  const item = entry({
    state: "candidate",
    origin: "automatic",
    version: 2,
    versions: [
      { version: 1, content: "old" },
      { version: 2, content: "new" }
    ],
    title: "<img src=x>",
    sources: [
      { taskId: "task-1", runId: "run-1", quote: "<script>bad</script>", validationQuote: "测试通过" }
    ]
  });
  const f = fixture(t, async (_url, options) => {
    if (options.method === "POST") calls.push(JSON.parse(options.body));
    return snapshot({ items: [item] });
  });
  f.controller.open({ id: "a" });
  await settle();
  assert.equal(f.$("[data-list] img"), null);
  assert.equal(f.$("[data-list] script"), null);
  assert.match(f.$("[data-list]").textContent, /验证证据：测试通过/);
  f.$('[data-state="active"]').click();
  await settle();
  assert.deepEqual(calls[0], {
    action: "set_state",
    id: "item-a",
    revision: "entry-1",
    state: "active",
    snapshotRevision: "snapshot-1"
  });
  assert.equal(
    f.$('[data-action="rollback"]'),
    null,
    "a candidate has not yet published a version to roll back"
  );
  f.$('[data-action="edit"]').click();
  assert.equal(f.$("[data-save-item]").textContent, "保存并启用");
});

test("deleting project experience requires its inline confirmation and cancellation sends no request", async (t) => {
  const calls = [];
  const f = fixture(t, async (_url, options) => {
    if (options.method === "POST") {
      calls.push(JSON.parse(options.body));
      return snapshot({ revision: "snapshot-2", items: [] });
    }
    return snapshot({ items: [entry()] });
  });
  f.window.confirm = () => assert.fail("project deletion must use the styled inline confirmation");
  f.controller.open({ id: "a" });
  await settle();
  f.$('[data-action="remove"]').click();
  assert.equal(calls.length, 0);
  assert.match(f.$('[aria-label="删除确认"]').textContent, /删除后无法恢复/);
  f.$('[data-action="cancel-remove"]').click();
  assert.equal(f.$('[aria-label="删除确认"]'), null);
  assert.equal(calls.length, 0);
  f.$('[data-action="remove"]').click();
  f.$('[data-action="confirm-remove"]').click();
  await settle();
  assert.deepEqual(calls, [
    { action: "remove", id: "item-a", revision: "entry-1", snapshotRevision: "snapshot-1" }
  ]);
  assert.equal(f.$("[data-experience-id]"), null);
});

test("closing project experience discards an unconfirmed deletion", async (t) => {
  const f = fixture(t, async () => snapshot({ items: [entry()] }));
  f.controller.open({ id: "a" });
  await settle();
  f.$('[data-action="remove"]').click();
  assert.ok(f.$('[aria-label="删除确认"]'));
  f.controller.close();
  f.controller.open({ id: "a" });
  await settle();
  assert.equal(f.$('[aria-label="删除确认"]'), null);
  assert.ok(f.$("[data-experience-id]"));
});

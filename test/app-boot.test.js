import { confirmApplicationWorkspaceInDom } from "./application-workspace-choice.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NodeFilter, parseHTML } from "linkedom";

/**
 * Boot the whole page the way a browser does.
 *
 * Every other test imports a module directly, so a broken import *in `app.js`
 * itself* — a name that no longer exists, a variable that was never declared —
 * left every suite green while the real page failed to load and nothing on
 * screen worked at all. This is the only test that actually executes `app.js`,
 * which is exactly the gap those failures fell through.
 */
function browserEnvironment() {
  const { window, document } = parseHTML(readFileSync("web/index.html", "utf8"));
  const previous = {
    ...Object.fromEntries(
      [
        "document",
        "window",
        "NodeFilter",
        "CSS",
        "EventSource",
        "ResizeObserver",
        "IntersectionObserver",
        "MutationObserver",
        "devicePixelRatio",
        "innerWidth",
        "innerHeight",
        "matchMedia",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "getComputedStyle",
        "location",
        "history",
        "fetch"
      ].map((key) => [key, globalThis[key]])
    )
  };

  window.HTMLElement.prototype.getClientRects ??= () => [];
  globalThis.document = document;
  globalThis.window = window;
  globalThis.NodeFilter = NodeFilter;
  const location = new URL("http://atria.invalid/");
  const historyCalls = [];
  globalThis.location = window.location = location;
  globalThis.history = window.history = {
    pushState(state, title, url) {
      historyCalls.push({ state, title, url });
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    },
    replaceState(_state, _title, url) {
      if (url !== undefined && url !== null) location.href = new URL(url, location).href;
    }
  };
  globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
  globalThis.EventSource = class {
    constructor() {}
    close() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.devicePixelRatio = window.devicePixelRatio = 2;
  globalThis.innerWidth = window.innerWidth = 1440;
  globalThis.innerHeight = window.innerHeight = 900;
  // Each boot owns its polling timeouts, intervals and simulated animation
  // frames. Stop them when its page closes so they cannot read the next test's
  // workspace or keep the worker alive after its assertions finish.
  const timeouts = new Set();
  const intervals = new Set();
  const realTimers = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = realTimers.setTimeout(() => {
      timeouts.delete(id);
      callback(...args);
    }, delay);
    timeouts.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeouts.delete(id);
    realTimers.clearTimeout(id);
  };
  globalThis.setInterval = (...args) => {
    const id = realTimers.setInterval(...args);
    intervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    intervals.delete(id);
    realTimers.clearInterval(id);
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  const media = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  globalThis.matchMedia = window.matchMedia = media;
  // The starfield and galaxy draw into canvases linkedom cannot provide.
  const context = new Proxy({}, { get: () => () => {}, has: () => true });
  const create = document.createElement.bind(document);
  document.createElement = (tag, ...rest) => {
    const element = create(tag, ...rest);
    if (String(tag).toLowerCase() === "canvas") element.getContext = () => context;
    return element;
  };
  for (const canvas of document.querySelectorAll("canvas")) canvas.getContext = () => context;

  return {
    window,
    document,
    historyCalls,
    $: (selector) => document.querySelector(selector),
    async restore() {
      // In-flight visible polls must also stop scheduling their next timeout.
      window.dispatchEvent(new window.Event("pagehide"));
      // The unload handlers may flush a dirty editor through the stub server.
      // Let those promises settle while their document and fetch still exist.
      await new Promise((resolve) => realTimers.setTimeout(resolve, 0));
      for (const id of timeouts) realTimers.clearTimeout(id);
      for (const id of intervals) realTimers.clearInterval(id);
      timeouts.clear();
      intervals.clear();
      Object.assign(globalThis, realTimers);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  };
}

/** Answer the page's own requests from a small in-memory workspace. */
function stubServer({ tabs = [], tasks = [], applications = [], projects } = {}) {
  const calls = [];
  // Mutable, so a test can walk a flow that changes what the server reports.
  const state = {
    tabs: [...tabs],
    activeTabId: undefined,
    detached: false,
    created: [],
    adopted: [],
    made: []
  };
  globalThis.fetch = async (path, options = {}) => {
    const url = String(path);
    const method = options.method ?? "GET";
    calls.push(`${method} ${url.split("?")[0]}`);
    const body = (value, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => value,
      headers: { get: () => null }
    });
    if (url.startsWith("/api/tasks") && url.split("/").length === 3 && method === "GET") {
      return body({
        tasks,
        // The sidebar renders conversations grouped under a project, so a
        // fixture with no project renders no rows at all.
        projects: projects ?? [
          {
            projectId: "p1",
            projectName: "默认项目",
            projectDirectory: "/tmp/w",
            workspaceRoot: "/tmp/w",
            tasks
          }
        ],
        workspaceRoot: "/tmp/w",
        currentWorkspaceRoot: "/tmp/w",
        model: "test-model"
      });
    }
    if (url === "/api/models") return body({ current: "test-model", models: ["test-model"] });
    if (url === "/api/workbench/temporary-resources") return body({ resources: [] });
    if (url === "/api/workbench/workspaces") return body({ workspaces: ["/tmp/w"] });
    if (url === "/api/applications") return body({ applications });
    if (url === "/api/workbench/tabs" && method === "POST") {
      const sent = JSON.parse(options.body ?? "{}");
      const id =
        sent.kind === "conversation"
          ? `conversation:${sent.taskId}`
          : sent.resourceId
            ? `resource:${sent.resourceId}`
            : `window:${sent.appInstanceId}`;
      if (!state.tabs.some((tab) => tab.tabId === id)) {
        const goal = tasks.find((task) => task.taskId === (sent.bindTo ?? sent.taskId))?.goal;
        state.tabs = [
          ...state.tabs,
          sent.kind === "conversation"
            ? {
                tabId: id,
                kind: "conversation",
                taskId: sent.taskId,
                title: goal ?? sent.taskId,
                taskGoal: goal
              }
            : {
                tabId: id,
                kind: "application",
                resourceId: sent.resourceId,
                appInstanceId: sent.appInstanceId,
                appType: "text-editor",
                title: state.made.find((m) => m.resourceId === sent.resourceId)?.title ?? "文档",
                hasResource: Boolean(sent.resourceId),
                conversations: sent.bindTo ? [{ taskId: sent.bindTo, goal }] : [],
                ...(sent.bindTo ? { groupTaskId: sent.bindTo } : {})
              }
        ];
      }
      // `activate: false` is how the composer's binding control says "present
      // but not in front": binding is not navigation.
      if (sent.activate !== false) state.activeTabId = id;
      state.detached = false;
      return body({ tabs: state.tabs, activeTabId: state.activeTabId });
    }
    if (url === "/api/workbench/tabs") {
      if (method === "PATCH") {
        const sent = JSON.parse(options.body ?? "{}");
        // `null` is "no tab in front" — a state the server must keep, or the
        // next poll puts the application back over the conversation.
        state.detached = sent.tabId === null;
        state.activeTabId = sent.tabId ?? undefined;
        return body({ tabs: state.tabs, activeTabId: state.activeTabId });
      }
      const active = state.detached ? undefined : (state.activeTabId ?? state.tabs[0]?.tabId);
      return body({ tabs: state.tabs, activeTabId: active });
    }
    if (url === "/api/tasks" && method === "POST") {
      const sent = JSON.parse(options.body ?? "{}");
      const made = {
        taskId: sent.taskId ?? "task-new",
        status: "created",
        goal: sent.goal,
        projectId: sent.projectId || "p1",
        projectName: "默认项目",
        storageRoot: "/tmp/w",
        workspaceRoot: "/tmp/w"
      };
      state.created.push(made);
      tasks.push(made);
      return body(made, 201);
    }
    if (url === "/api/workbench/load-instance") {
      const sent = JSON.parse(options.body ?? "{}");
      state.adopted.push(sent);
      const existing = state.tabs.find(
        (tab) =>
          tab.kind === "application" &&
          ((sent.appInstanceId && tab.appInstanceId === sent.appInstanceId) ||
            (sent.resourceId && tab.resourceId === sent.resourceId))
      );
      if (existing) {
        existing.conversations = [
          ...(existing.conversations ?? []).filter((task) => task.taskId !== sent.taskId),
          { taskId: sent.taskId }
        ];
      } else
        state.tabs.push({
          tabId: "window:app_1",
          appInstanceId: "app_1",
          accessTaskId: "workspace",
          kind: "application",
          resourceId: "res_1",
          appType: "text-editor",
          title: "草稿.md",
          hasResource: true,
          conversations: [{ taskId: sent.taskId }],
          groupTaskId: sent.taskId
        });
      return body({
        resource: { resourceId: "res_1", title: "草稿.md", taskId: sent.taskId },
        appInstance: { appInstanceId: "app_1" },
        tabs: state.tabs
      });
    }
    if (url === "/api/workbench/open-application") {
      state.tabs = [
        {
          tabId: "window:app_1",
          kind: "application",
          workspaceRoot: "/tmp/w",
          taskId: "workspace",
          appInstanceId: "app_1",
          appType: "text-editor",
          title: "文本编辑器",
          hasResource: false
        }
      ];
      state.activeTabId = "window:app_1";
      state.detached = false;
      return body({
        appInstance: { appInstanceId: "app_1", taskId: "workspace", resourceIds: [] },
        taskId: "workspace",
        tabs: state.tabs
      });
    }
    if (url.endsWith("/app-instances/open") && method === "POST") {
      // Opening an application inside a conversation: the window belongs to that
      // conversation, not to the shared standalone workspace.
      const taskId = decodeURIComponent(url.split("/api/tasks/")[1].split("/")[0]);
      const tabId = "window:app_1";
      if (!state.tabs.some((tab) => tab.tabId === tabId)) {
        state.tabs = [
          ...state.tabs,
          {
            tabId,
            kind: "application",
            taskId,
            appInstanceId: "app_1",
            appType: "text-editor",
            title: "文本编辑器",
            hasResource: false
          }
        ];
      }
      state.activeTabId = tabId;
      state.detached = false;
      return body({ appInstance: { appInstanceId: "app_1", taskId, resourceIds: [] }, taskId }, 201);
    }
    if (
      (url.includes("/app-instances/") || url.includes("/workbench/instances/")) &&
      url.endsWith("/resources") &&
      method === "POST"
    ) {
      // Creating a document fills the window that is already open: the tab keeps
      // its id and gains a resource.
      const title = JSON.parse(options.body ?? "{}").title ?? "我的新文档.md";
      const target = state.tabs.findIndex((tab) => tab.kind === "application");
      if (target >= 0) {
        const taskId = state.tabs[target].taskId;
        state.tabs = state.tabs.map((tab, index) =>
          index === target
            ? {
                tabId: "window:app_1",
                workspaceRoot: "/tmp/w",
                appInstanceId: "app_1",
                accessTaskId: "workspace",
                kind: "application",
                resourceId: "res_1",
                appType: "text-editor",
                title,
                hasResource: true,
                conversations: taskId && taskId !== "workspace" ? [{ taskId }] : [],
                // An unclaimed document still names where it lives, so the editor
                // has a task to send its writes to.
                ...(taskId && taskId !== "workspace"
                  ? { groupTaskId: taskId }
                  : { standalone: true, taskId: "workspace" })
              }
            : tab
        );
        // The tab was rekeyed, so whatever pointed at the old id follows it.
        if (state.activeTabId === state.tabs[target]?.tabId || state.activeTabId?.startsWith("window:")) {
          state.activeTabId = "window:app_1";
        }
      }
      return body(
        {
          resource: { resourceId: "res_1", title: "我的新文档.md", path: "我的新文档.md" },
          appInstance: { appInstanceId: "app_1", resourceIds: ["res_1"] }
        },
        201
      );
    }
    if (url.endsWith("/resources") && method === "GET") {
      // The editor's 打开文档 sheet lists what the conversation references.
      return body({
        resources: state.tabs
          .filter((tab) => tab.resourceId)
          .map((tab) => ({
            resourceId: tab.resourceId,
            title: tab.title,
            appType: "text-editor",
            kind: "text/markdown",
            revision: 0
          }))
      });
    }
    if (url.endsWith("/resources") && method === "POST") {
      // A document created for the conversation itself, not into a window:
      // this is what the editor's 「打开文档 → ＋新建文档」 sheet calls.
      const sent = JSON.parse(options.body ?? "{}");
      const id = `res_${state.made.length + 2}`;
      state.made.push({ resourceId: id, title: sent.title });
      return body(
        {
          resource: { resourceId: id, title: sent.title, path: sent.title, kind: sent.kind, revision: 0 },
          snapshot: { content: sent.initialContent ?? "", revision: 0 }
        },
        201
      );
    }
    if (url.includes("/resources/") && method === "GET") {
      const asked = url.split("/resources/")[1].split("?")[0];
      const tab = state.tabs.find((entry) => entry.resourceId === asked);
      const title =
        tab?.title ??
        state.made.find((m) => m.resourceId === asked)?.title ??
        state.tabs[0]?.title ??
        "方案.md";
      return body({
        resource: { resourceId: "res_1", title, path: title, kind: "text/markdown", revision: 0 },
        snapshot: { content: `# ${title.replace(/\.[^.]+$/, "")}\n`, revision: 0 },
        operations: []
      });
    }
    if (url.includes("/api/tasks/")) {
      return body({
        task: tasks[0] ?? { taskId: "task-1", status: "created", goal: "甲" },
        workspaceRoot: "/tmp/w",
        coordination: { calls: [], pending: [], callbackPending: [] },
        events: [],
        runtimeEvents: [],
        artifacts: [],
        messages: [],
        humanRequests: [],
        statistics: null,
        runtime: { active: false, model: "test-model" },
        applications: { resources: [], instances: [], unread: [], deliverables: [], unbound: true }
      });
    }
    return body({}, 404);
  };
  return { calls, state };
}

/** Load `app.js` fresh and collect anything it throws. */
function nameDocument(page, title) {
  page.$("[data-document-name]").value = title;
  page
    .$(".editor-name-form")
    .dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
}

async function useEditorInConversation(page) {
  page.$("[data-app-collaborate]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
}

async function boot(fixture = {}) {
  const view = browserEnvironment();
  const server = stubServer(fixture);
  const failures = [];
  const onRejection = (error) => failures.push(`unhandledRejection: ${error?.message ?? error}`);
  const onError = (error) => failures.push(`uncaught: ${error?.message ?? error}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onError);
  let loadError;
  try {
    // A cache-busting query gives each test a fresh module graph, so one test's
    // module-level state cannot mask another's failure.
    await import(`../web/app.js?boot=${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    loadError = error;
  }
  // Let the page's startup requests settle.
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.off("unhandledRejection", onRejection);
  process.off("uncaughtException", onError);
  return { ...view, server, failures, loadError };
}

async function waitForPage(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), message);
}

test("the page loads with no import or reference errors", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }] });
  t.after(page.restore);
  // A broken import here takes the entire UI down — nothing on screen works,
  // which is exactly what happened when a removed export was still imported.
  assert.equal(page.loadError, undefined, `app.js must load: ${page.loadError?.message}`);
  assert.deepEqual(page.failures, [], "startup must not throw");
});

test("startup reads the task list, the model list and the global tab strip", async (t) => {
  const page = await boot({ tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  for (const expected of ["GET /api/tasks", "GET /api/models", "GET /api/workbench/tabs"]) {
    assert.ok(
      page.server.calls.includes(expected),
      `startup must call ${expected}, saw ${JSON.stringify(page.server.calls)}`
    );
  }
});

test("a projectless new conversation begins immediately and preserves its draft", async (t) => {
  const page = await boot({ projects: [] });
  t.after(page.restore);
  page.$("#composer-input").value = "先保留这份草稿";
  page.$("#new-conversation").click();
  assert.equal(page.$("#project-modal"), null);
  assert.equal(page.$("#composer-input").value, "先保留这份草稿");
  assert.equal(page.$("#workspace-button"), null);
  assert.equal(page.$("#workspace-label"), null);
  assert.deepEqual(page.server.state.created, []);
  assert.equal(page.window.location.hash, "");
  assert.deepEqual(
    page.historyCalls,
    [],
    "ordinary conversation navigation does not create a goal history entry"
  );
  assert.deepEqual(page.failures, []);
});

test("goal navigation owns its hash while ordinary conversation clicks keep an inactive goal route unchanged", async (t) => {
  const page = await boot();
  t.after(page.restore);
  assert.equal(page.$(".goal-workspace").hidden, true);
  page.$("#goals-nav").click();
  assert.equal(page.window.location.hash, "#goals");
  assert.equal(page.$(".goal-workspace").hidden, false);
  assert.equal(page.historyCalls.length, 1);
  page.$("#new-conversation").click();
  assert.equal(page.window.location.hash, "");
  assert.equal(page.$(".goal-workspace").hidden, true);
  assert.equal(page.historyCalls.length, 2);
  page.$("#new-conversation").click();
  assert.equal(page.historyCalls.length, 2);
});

test("a late Task creation uses its original project and preserves the later project's draft", async (t) => {
  const projects = ["a", "b"].map((id) => ({
    projectId: id,
    projectName: `项目 ${id}`,
    projectDirectory: `/tmp/${id}`,
    tasks: []
  }));
  const page = await boot({ projects });
  t.after(page.restore);
  let release, sent;
  const request = globalThis.fetch;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/tasks" && options.method === "POST") {
      sent = JSON.parse(options.body);
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return request(path, options);
  };
  page.$('[data-project-create="b"]').click();
  page.$("#composer-input").value = "原有 B 项目草稿";
  page.$('[data-project-create="a"]').click();
  page.$("#composer-input").value = "发送给 A";
  page.$("#send-button").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.projectId, "a");
  assert.equal(Object.hasOwn(sent, "workspaceRoot"), false);
  page.$('[data-project-create="b"]').click();
  assert.equal(page.$("#composer-input").value, "原有 B 项目草稿");
  page.$("#composer-input").value = "B 项目未发送";
  release();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(page.$("#project-context").textContent, "项目 b");
  assert.equal(page.$("#composer-input").value, "B 项目未发送");
  assert.equal(page.$(".conversation-item.active"), null);
  assert.equal(page.server.state.created[0].projectId, "a");
  assert.deepEqual(page.failures, []);
});

test("clicking project rows restores both projects' independent new-conversation drafts", async (t) => {
  const page = await boot({
    projects: ["a", "b"].map((id) => ({
      projectId: id,
      projectName: `项目 ${id}`,
      projectDirectory: `/tmp/${id}`,
      tasks: []
    }))
  });
  t.after(page.restore);
  page.$('[data-project-create="a"]').click();
  page.$("#composer-input").value = "A 的独立草稿";
  page.$('[data-project-id="b"]').click();
  assert.equal(page.$("#composer-input").value, "");
  page.$("#composer-input").value = "B 的独立草稿";
  page.$('[data-project-id="a"]').click();
  assert.equal(page.$("#project-context").textContent, "项目 a");
  assert.equal(page.$("#composer-input").value, "A 的独立草稿");
  page.$('[data-project-id="b"]').click();
  assert.equal(page.$("#project-context").textContent, "项目 b");
  assert.equal(page.$("#composer-input").value, "B 的独立草稿");
  assert.deepEqual(page.server.state.created, []);
  assert.deepEqual(page.failures, []);
});

test("a strip spanning two tasks renders every tab, labelled by task", async (t) => {
  const tabs = [
    {
      tabId: "conversation:task-1",
      kind: "conversation",
      taskId: "task-1",
      title: "写一份产品方案",
      taskGoal: "写一份产品方案"
    },
    {
      tabId: "application:task-1:app_1",
      kind: "application",
      taskId: "task-1",
      appInstanceId: "app_1",
      appType: "text-editor",
      title: "方案.md",
      resourceId: "res_1",
      taskGoal: "写一份产品方案"
    },
    {
      tabId: "conversation:task-2",
      kind: "conversation",
      taskId: "task-2",
      title: "做一次技术调研",
      taskGoal: "做一次技术调研"
    },
    {
      tabId: "application:task-2:app_2",
      kind: "application",
      taskId: "task-2",
      appInstanceId: "app_2",
      appType: "text-editor",
      title: "笔记.md",
      resourceId: "res_2",
      taskGoal: "做一次技术调研"
    }
  ];
  const page = await boot({ tabs, tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  assert.deepEqual(page.failures, []);

  const strip = page.$("[data-tab-strip]");
  const rendered = [...strip.querySelectorAll("[data-tab]")].map((node) => node.dataset.tab);
  assert.deepEqual(
    rendered,
    tabs.map((tab) => tab.tabId),
    "all four tabs from both tasks are shown"
  );
  assert.equal(page.$("#workbench").hidden, false, "the strip must be visible once tabs exist");

  // The neighbouring conversation already names the group. Repeating that
  // title on its file looks like two conversation/document tabs for one file.
  const text = strip.textContent;
  assert.equal(
    (text.match(/写一份产品方案/g) ?? []).length,
    1,
    `the task name appears once on its conversation tab, saw: ${text}`
  );
  assert.match(
    strip.querySelector('[data-tab="application:task-1:app_1"]').getAttribute("title"),
    /关联对话：写一份产品方案/
  );
});

test("with one task open, application tabs are not prefixed with its name", async (t) => {
  const tabs = [
    { tabId: "conversation:task-1", kind: "conversation", taskId: "task-1", title: "甲", taskGoal: "甲" },
    {
      tabId: "application:task-1:app_1",
      kind: "application",
      taskId: "task-1",
      appInstanceId: "app_1",
      appType: "text-editor",
      title: "方案.md",
      resourceId: "res_1",
      taskGoal: "甲"
    }
  ];
  const page = await boot({ tabs });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  // Repeating the only open task's name on every tab is noise.
  assert.equal((page.$("[data-tab-strip]").textContent.match(/甲/g) ?? []).length, 1);
});

test("an empty strip leaves the conversation showing and says what to do", async (t) => {
  const page = await boot({ tabs: [], tasks: [{ taskId: "task-1", status: "created", goal: "甲" }] });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  assert.equal(page.$("#conversation-pane").hidden, false);
  assert.match(page.$("[data-tab-strip]").textContent, /没有打开的标签/);
  assert.equal(page.document.body.classList.contains("app-fullbleed"), false);
});

test("with the workbench off the page still loads and the controls stay hidden", async (t) => {
  const view = browserEnvironment();
  t.after(view.restore);
  // Every workbench route 404s, as it does with the feature flag unset.
  const calls = [];
  globalThis.fetch = async (path, options = {}) => {
    const url = String(path);
    calls.push(url);
    const body = (value, status = 200) => ({
      ok: status < 400,
      status,
      json: async () => value,
      headers: { get: () => null }
    });
    if (url === "/api/tasks")
      return body({
        tasks: [{ taskId: "task-1", status: "created", goal: "甲" }],
        projects: [],
        workspaceRoot: "/tmp/w"
      });
    if (url === "/api/models") return body({ current: "m", models: ["m"] });
    if (url.startsWith("/api/workbench") || url === "/api/applications")
      return body({ error: "not found" }, 404);
    if (url.startsWith("/api/tasks/")) {
      // No `applications` field: that is what the flag being off looks like.
      return body({
        task: { taskId: "task-1", status: "created", goal: "甲" },
        workspaceRoot: "/tmp/w",
        coordination: { calls: [], pending: [], callbackPending: [] },
        events: [],
        runtimeEvents: [],
        artifacts: [],
        messages: [],
        humanRequests: [],
        statistics: null,
        runtime: { active: false }
      });
    }
    return body({}, 404);
  };
  const failures = [];
  const onRejection = (error) => failures.push(String(error?.message ?? error));
  process.on("unhandledRejection", onRejection);
  let loadError;
  try {
    await import(`../web/app.js?off=${Math.random().toString(36).slice(2)}`);
  } catch (error) {
    loadError = error;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  process.off("unhandledRejection", onRejection);

  assert.equal(loadError, undefined, "a 404 on the workbench routes must not break the page");
  assert.deepEqual(failures, []);
  assert.equal(view.$("#workbench").hidden, true, "the strip stays hidden");
  assert.equal(view.$("#apps-nav").hidden, true);
  assert.equal(view.$("#app-bind-select").hidden, true);
  assert.equal(view.$("#conversation-pane").hidden, false, "the conversation is unaffected");
});

test("opening an application needs no conversation, and a new document opens in it", async (t) => {
  // Two bugs met here: a host callback named exactly like the HTTP method it
  // wrapped overwrote it and recursed into itself, and the tab was not
  // remounted when it gained a resource — so the document was created and then
  // never shown.
  const page = await boot({
    tabs: [],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // 应用 → 文本编辑器, with no conversation anywhere.
  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const tile = page.$("#apps-panel [data-create-app]");
  assert.ok(tile, "the application is offered even with no conversation");
  tile.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(page.server.calls.includes("POST /api/workbench/open-application"), "it opens standalone");
  assert.ok(page.$("[data-empty-new]"), "an editor with nothing open shows its empty state");

  // 新建文档
  page.$("[data-empty-new]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "我的新文档.md");
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.ok(
    page.server.calls.some((call) => call.startsWith("POST /api/workbench/instances/")),
    "the document is created"
  );
  assert.equal(page.$("[data-empty-new]"), null, "the empty state must give way to the document");
  assert.ok(page.$("[data-editor-input]"), "the editor opens the document it just created");
  assert.match(page.$("[data-tab-strip]").textContent, /我的新文档\.md/, "and the tab takes its name");
  assert.deepEqual(page.failures, [], "no recursion or unhandled rejection");
});

test("a late auxiliary project catalog cannot replace a newer task list or its draft", async (t) => {
  const page = await boot({
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  page.$("#new-conversation").click();
  page.$("#composer-input").value = "保持当前项目的未发送草稿";
  page.$("#apps-nav").click();
  await waitForPage(() => page.$("#apps-panel [data-create-app]"), "applications must load");
  page.$("#apps-panel [data-create-app]").click();
  confirmApplicationWorkspaceInDom(page);
  await waitForPage(() => page.$("[data-empty-new]"), "independent editor must open");

  const request = globalThis.fetch;
  let catalogReads = 0,
    releaseOlder;
  const freshTask = { taskId: "fresh-task", status: "created", goal: "较新目录中的会话", projectId: "p1" };
  const reply = (tasks) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({
      tasks,
      projects: [
        {
          projectId: "p1",
          projectName: "默认项目",
          projectDirectory: "/tmp/w",
          workspaceRoot: "/tmp/w",
          tasks
        }
      ],
      workspaceRoot: "/tmp/w",
      currentWorkspaceRoot: "/tmp/w",
      model: "test-model"
    })
  });
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/tasks" && (options.method || "GET") === "GET") {
      catalogReads++;
      if (catalogReads === 1)
        return new Promise((resolve) => {
          releaseOlder = () => resolve(reply([]));
        });
      return reply([freshTask]);
    }
    return request(path, options);
  };
  t.after(() => releaseOlder?.());
  page.$("[data-empty-new]").click();
  nameDocument(page, "保留最新目录.md");
  await waitForPage(() => catalogReads === 1, "document creation must request its project catalog");
  page.$(".panel-add").click();
  await waitForPage(() => page.$('[data-task="fresh-task"]'), "newer list must reach the sidebar");
  releaseOlder();
  await waitForPage(() => page.$("[data-editor-input]"), "created document must become editable");
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Re-render from local state, without another list response masking a stale acceptance.
  page.$('[data-project-id="p1"]').click();
  assert.ok(page.$('[data-task="fresh-task"]'), "the older catalog must not erase an acknowledged task");
  page.$("#new-conversation").click();
  assert.equal(page.$("#composer-input").value, "保持当前项目的未发送草稿");
  assert.deepEqual(page.failures, []);
});

test("document creation remains successful when its auxiliary project catalog returns 503", async (t) => {
  const page = await boot({
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  page.$("#apps-nav").click();
  await waitForPage(() => page.$("#apps-panel [data-create-app]"), "applications must load");
  page.$("#apps-panel [data-create-app]").click();
  confirmApplicationWorkspaceInDom(page);
  await waitForPage(() => page.$("[data-empty-new]"), "independent editor must open");
  const request = globalThis.fetch;
  let failedReads = 0;
  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/tasks" && (options.method || "GET") === "GET") {
      failedReads++;
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => ({ error: "project catalog temporarily unavailable" })
      };
    }
    return request(path, options);
  };
  page.$("[data-empty-new]").click();
  nameDocument(page, "目录暂时离线.md");
  await waitForPage(
    () => failedReads && page.$("[data-editor-input]"),
    "successful creation must open its document despite the catalog outage"
  );
  assert.equal(page.$("[data-empty-new]"), null);
  assert.equal(page.$("[data-name-dialog]"), null, "the creation form must report success and close");
  assert.equal(
    page.server.calls.filter((call) => call.startsWith("POST /api/workbench/instances/")).length,
    1,
    "the document is created exactly once"
  );
  assert.equal(page.server.state.tabs.find((tab) => tab.kind === "application").resourceId, "res_1");
  const editor = page.$("[data-editor-input]"),
    content = editor.value;
  assert.match(page.$("#toast").textContent, /文档已打开/);
  await useEditorInConversation(page);
  await waitForPage(() => failedReads >= 2, "loading must retry the catalog");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.$("#conversation-pane").hidden, true);
  assert.equal(page.$("[data-editor-input]"), editor, "failed navigation must retain the same editor");
  assert.equal(editor.value, content);
  assert.match(page.$("#toast").textContent, /关联失败：project catalog temporarily unavailable/);
  assert.deepEqual(page.server.state.created, []);
  assert.deepEqual(page.failures, []);
});

test("asking for a new conversation steps out of the editor and keeps the draft", async (t) => {
  // The bug this pins: an application tab was covering the content area, so
  // clicking 新对话 changed the selected task but nothing visible happened —
  // and the state was not recorded, so the next poll put the editor back.
  const page = await boot({
    tabs: [],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 200));
  page.$("[data-empty-new]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "草稿.md");
  await new Promise((resolve) => setTimeout(resolve, 300));

  const input = page.$("[data-editor-input]");
  assert.ok(input, "the editor is open on the new document");
  input.value = "我正在写的内容\n";
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(page.$("#conversation-pane").hidden, true, "the editor is in front");

  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation must come to the front");
  assert.equal(
    page.$("[data-composer-context]").hidden,
    true,
    "a new chat cannot advertise a previous file or conversation as its editing context"
  );
  assert.equal(
    page.document.body.classList.contains("app-fullbleed"),
    false,
    "and the layout must come back"
  );
  // Stepping away is recorded, so a later refresh does not undo it.
  assert.ok(page.server.calls.includes("PATCH /api/workbench/tabs"), "the server is told no tab is in front");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(page.$("#conversation-pane").hidden, false, "and it stays in front");
  // The editor is set aside, not destroyed: unsent typing is the user's only copy.
  assert.equal(
    page.$("[data-editor-input]")?.value,
    "我正在写的内容\n",
    "the draft must survive stepping away"
  );
  assert.deepEqual(page.failures, []);
});

test("a streamed event is appended in place, not by copying the whole log", async (t) => {
  // The lag this pins: the SSE handler rebuilt `runtimeEvents` with
  // `[...runtimeEvents, record]` on every event. A streaming reply emits
  // thousands, so the cost grew quadratically — around ten thousand events one
  // token cost ~33ms of copying, plus the garbage each copy left behind, which
  // is the stutter felt while a reply streamed.
  //
  // Asserted on the source rather than by timing: a wall-clock threshold would
  // be flaky on a loaded machine, and the defect is the copy itself.
  const { readFileSync } = await import("node:fs");
  const source =
    readFileSync("web/assets/controllers/connection-controller.js", "utf8") +
    readFileSync("web/app.js", "utf8");
  const handler = source.slice(source.indexOf("stream.onmessage"), source.indexOf("stream.onerror"));
  assert.ok(handler.length > 0, "the SSE handler must be findable");
  assert.doesNotMatch(
    handler,
    /runtimeEvents\s*=\s*\[\s*\.\.\./,
    "per-event handling must not copy the whole event log"
  );
  assert.match(handler, /runtimeEvents\.push\(/, "it appends in place instead");
  // The merge on a detail poll may still copy: it runs once per poll, not per
  // event, and has to produce a new array to replace the old one.
  assert.match(source, /mergeRuntimeEvents\(/);
});

test("新对话 opens a tab of its own, and the first message turns it into the real one", async (t) => {
  // The bug this pins: only applications used the strip. Clicking 新对话 left
  // the previous conversation's tab highlighted while the composer wrote a new
  // one, so the row and the pane disagreed about where the person was.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "旧对话",
        taskGoal: "旧对话"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "旧对话" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  const strip = page.$("[data-tab-strip]");
  assert.match(strip.textContent, /新对话/, "the draft conversation is in the strip");
  assert.match(strip.textContent, /旧对话/, "and the previous conversation is still there");
  const active = page.document.querySelector("[data-tab-strip] [data-tab].active");
  assert.equal(active?.dataset.tab, "conversation:__draft__", "the draft is what is in front");
  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation area is showing");
  // Returning to the same unsent conversation restores its draft. A successful
  // send clears it, while switching to another conversation uses that draft.
  page.$("#composer-input").value = "没发出去的半句话";
  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    page.$("#composer-input").value,
    "没发出去的半句话",
    "returning to the existing draft preserves unsent text"
  );
  assert.deepEqual(page.failures, []);
});

test("every way of entering a conversation gets past an open editor", async (t) => {
  // The first fix covered only the 新对话 button. Selecting a task in the
  // sidebar, in search, or by shortcut set `state.selected` without moving the
  // strip, so the editor stayed in front and those clicks read as broken too.
  const page = await boot({
    tabs: [],
    tasks: [
      { taskId: "task-1", status: "created", goal: "写一份产品方案", updatedAt: "2026-01-01T00:00:00.000Z" }
    ],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(page.$("#conversation-pane").hidden, true, "the editor is in front");

  // Clicking the conversation in the sidebar must reach it.
  const row = page.document.querySelector("#project-list [data-task]");
  assert.ok(row, "the sidebar lists the conversation");
  row.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    page.$("#conversation-pane").hidden,
    false,
    "selecting a conversation must bring it to the front"
  );
  assert.equal(page.document.body.classList.contains("app-fullbleed"), false);
  // Its tab is now in the strip, so the editor is one click away rather than lost.
  assert.match(page.$("[data-tab-strip]").textContent, /写一份产品方案/);
  assert.match(page.$("[data-tab-strip]").textContent, /文本编辑器|未命名/);
  assert.deepEqual(page.failures, []);
});

test("an unlinked application creates a conversation and a new draft can load the same application", async (t) => {
  const page = await boot({
    tabs: [],
    tasks: [
      { taskId: "task-1", status: "created", goal: "写一份产品方案" },
      { taskId: "task-2", status: "created", goal: "另一个任务" }
    ],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 200));
  let asked = 0;
  page.window.prompt = (question) => {
    // No native prompt is needed for either naming or choosing a conversation.
    if (/对话|编号/.test(String(question))) {
      asked += 1;
      return "1";
    }
    throw new Error("prompt() is not supported");
  };
  page.$("[data-empty-new]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "草稿.md");
  await new Promise((resolve) => setTimeout(resolve, 300));

  await useEditorInConversation(page);
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(page.server.state.created.length, 1, "first use creates its own conversation");
  assert.equal(page.server.state.adopted.length, 1, "returning automatically loads the application");
  assert.equal(page.server.state.adopted[0].taskId, page.server.state.created[0].taskId);
  assert.equal(page.$("#conversation-pane").hidden, false);
  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  page.$("#app-bind-select").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(page.$('[data-bind-instance="app_1"]'), "the composer offers the independent app");
  page.$('[data-bind-instance="app_1"]').dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(asked, 0, "no native prompt is used");
  assert.equal(page.server.state.created.length, 2, "the new draft creates another conversation");
  assert.equal(page.server.state.adopted.length, 2);
  assert.equal(
    page.server.state.adopted[1].taskId,
    page.server.state.created[1].taskId,
    "the document joins the conversation that was just made, not an existing one"
  );
  assert.equal(
    page.server.state.adopted[1].appInstanceId,
    "app_1",
    "loading keeps the same independent instance identity"
  );
  // And it lands in that conversation, not in the editor: relating a document
  // to a conversation is a statement about what the next message is about.
  // Asserted on what is actually on screen, not only on the strip's bookkeeping:
  // `bind-resource` leaves the adopted window active, so re-reading the strip
  // before claiming the conversation mounted the editor over it.
  assert.equal(page.server.state.activeTabId, `conversation:${page.server.state.created[1].taskId}`);
  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation is what the person sees");
  assert.deepEqual(page.failures, []);
});

test("choosing a binding in the composer does not navigate away from the conversation", async (t) => {
  // The bug this pins: selecting an application in the binding control called
  // activate() on its tab, so the editor covered the conversation the person
  // was in the middle of typing into.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "写一份产品方案",
        taskGoal: "写一份产品方案"
      },
      {
        tabId: "resource:res_1",
        kind: "application",
        resourceId: "res_1",
        appType: "text-editor",
        workspaceRoot: "/tmp/w",
        title: "方案.md",
        hasResource: true,
        conversations: [{ taskId: "task-1", goal: "写一份产品方案" }],
        groupTaskId: "task-1"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "写一份产品方案" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // Sit in the conversation, as a person composing a message would be.
  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(page.server.state.activeTabId, "conversation:task-1");

  page.$("#app-bind-select").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const option = page.$("#app-bind-menu [data-bind-instance='res_1']");
  assert.ok(option, "the conversation's own window is offered");
  option.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(
    page.server.state.activeTabId,
    "conversation:task-1",
    "binding must not move the strip off the conversation"
  );
  assert.equal(page.$("#conversation-pane").hidden, false, "the conversation stays visible");
  assert.deepEqual(page.failures, []);
});

test("returning from a standalone document automatically creates and loads its conversation", async (t) => {
  // The bug this pins: the user was told to go create a conversation and come
  // back, which is a dead end for the most ordinary case there is — open an
  // editor, write something, then want CoworkOS's help with it.
  const page = await boot({
    tabs: [],
    tasks: [],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 200));
  page.$("[data-empty-new]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "草稿.md");
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(page.$("[data-editor-bind]"), null, "there is no duplicate binding action inside the editor");
  assert.equal(page.$("[data-app-return-conversation]"), null, "the composer owns application loading");
  await useEditorInConversation(page);
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(page.server.state.created.length, 1, "a conversation is created rather than demanded");
  // It is named for the work, not after the file: naming it 草稿.md would show
  // the same words twice in the strip and say nothing about the conversation.
  assert.match(page.server.state.created[0].goal, /草稿/);
  assert.notEqual(page.server.state.created[0].goal, "草稿.md");
  assert.equal(page.server.state.adopted.length, 1, "and the document is adopted into it");
  assert.equal(page.server.state.adopted[0].taskId, page.server.state.created[0].taskId);
  assert.equal(page.server.state.activeTabId, `conversation:${page.server.state.created[0].taskId}`);
  assert.equal(page.$("#conversation-pane").hidden, false);
  assert.deepEqual(page.failures, []);
});

test("a document created from the editor's 打开 sheet comes to the front", async (t) => {
  // The bug this pins, reported twice: 「新建后没打开」. An editor is already
  // showing a document; 「打开文档 → ＋新建文档」 makes another one. The strip
  // gained the tab and the server made it active, but the page stayed on the
  // old document — so the person had to hunt for what they had just created.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "写方案",
        taskGoal: "写方案"
      },
      {
        tabId: "resource:res_1",
        kind: "application",
        resourceId: "res_1",
        appType: "text-editor",
        title: "第一份.md",
        hasResource: true,
        conversations: [{ taskId: "task-1", goal: "写方案" }],
        groupTaskId: "task-1"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "写方案" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // Sit in the first document.
  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  page.$("[data-tab='resource:res_1']").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(page.$("[data-editor-input]"), "the first document is open");

  // 打开文档 → ＋新建文档
  page.$("[data-editor-open]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const fresh = page.$("[data-open-new]");
  assert.ok(fresh, "the sheet offers creating a new document");
  fresh.dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "第二份.md");
  await new Promise((resolve) => setTimeout(resolve, 600));

  // The new document is what the person is looking at.
  assert.match(page.$("[data-tab-strip]").textContent, /第二份\.md/, "the new document is in the strip");
  const active = page.$("[data-tab].active")?.dataset.tab;
  assert.equal(active, "resource:res_2", `the new document is in front, not ${active}`);
  assert.deepEqual(page.failures, []);
});

test("creating in an editor opened from a conversation shows the document", async (t) => {
  // The reported symptom was 「标签都没出现」: a conversation is selected, the
  // person opens the text editor from the 应用 panel and creates a document —
  // and neither the tab nor the document appears. The difference from the
  // standalone case above is that a conversation *is* selected, so the panel
  // opens the window inside it rather than in the holding area.
  const page = await boot({
    tabs: [
      {
        tabId: "conversation:task-1",
        kind: "conversation",
        taskId: "task-1",
        title: "写方案",
        taskGoal: "写方案"
      }
    ],
    tasks: [{ taskId: "task-1", status: "created", goal: "写方案" }],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // Sit in the conversation, the way a person working in one would be.
  page
    .$("#project-list [data-task='task-1']")
    .dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  // 应用 → 文本编辑器
  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    page.server.calls.includes("POST /api/workbench/open-application"),
    "the app entry opens independently of the selected conversation"
  );
  assert.ok(page.$("[data-empty-new]"), "the empty editor is in front");

  // 新建文档
  page.$("[data-empty-new]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  nameDocument(page, "方案草稿.md");
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.match(page.$("[data-tab-strip]").textContent, /方案草稿\.md/, "the tab appears");
  assert.equal(page.$("[data-empty-new]"), null, "the empty state gives way");
  assert.ok(page.$("[data-editor-input]"), "and the document is what the person sees");
  assert.deepEqual(page.failures, []);
});

test("an editor opened while composing stays independent and preserves the draft", async (t) => {
  const page = await boot({
    tabs: [],
    tasks: [],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);

  // 新对话 — a draft, with nothing on the server yet.
  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(page.server.state.created, [], "composing creates nothing yet");

  // 应用 → 文本编辑器 leaves the conversation draft untouched.
  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  page.$("#apps-panel [data-create-app]").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  confirmApplicationWorkspaceInDom(page);
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(page.server.state.created.length, 0, "opening an app does not create a conversation");
  assert.ok(page.server.calls.includes("POST /api/workbench/open-application"));
  assert.deepEqual(page.failures, []);
});

test("a temporary document saved to a project starts collaboration in that project without adopting its temporary root", async (t) => {
  const chosen = {
    projectId: "chosen",
    projectName: "Chosen",
    projectDirectory: "/tmp/chosen",
    workspaceRoot: "/tmp/chosen",
    tasks: []
  };
  const page = await boot({
    tasks: [],
    projects: [chosen],
    tabs: [
      {
        tabId: "window:app_saved",
        kind: "application",
        appInstanceId: "app_saved",
        appType: "text-editor",
        title: "Saved document",
        hasResource: false,
        workspaceRoot: "/tmp/temporary-managed",
        accessTaskId: "temporary-holding",
        project: chosen,
        standalone: true,
        conversations: [],
        loadedConversations: []
      }
    ],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);
  assert.equal(page.loadError, undefined);
  await useEditorInConversation(page);
  await waitForPage(() => page.server.state.created.length > 0, "collaboration creates a conversation");
  assert.equal(page.server.state.created[0].projectId, chosen.projectId);
  assert.equal(
    page.server.calls.includes("POST /api/projects"),
    false,
    "physical temporary roots never become projects"
  );
  assert.equal(page.server.state.adopted[0].appInstanceId, "app_saved");
  assert.deepEqual(page.failures, []);
});

test("merely opening the applications panel creates no conversation", async (t) => {
  // The other half. Listing what a conversation references is a read, so it
  // must never bring one into being — otherwise glancing at the panel while
  // composing would litter the sidebar with empty conversations.
  const page = await boot({
    tabs: [],
    tasks: [],
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/markdown"],
        capabilities: ["view", "edit"]
      }
    ]
  });
  t.after(page.restore);

  page.$("#new-conversation").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  page.$("#apps-nav").dispatchEvent(new page.window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.ok(page.$("#apps-panel [data-create-app]"), "the panel is usable");
  assert.deepEqual(page.server.state.created, [], "but opening it created nothing");
  assert.deepEqual(page.failures, []);
});

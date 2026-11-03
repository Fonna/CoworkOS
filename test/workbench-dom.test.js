import { confirmApplicationWorkspaceInDom } from "./application-workspace-choice.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NodeFilter, parseHTML } from "linkedom";
import { createWorkbenchHost, DRAFT_TAB_ID } from "../web/assets/workbench/host.js";
import { createBindingControl } from "../web/assets/workbench/binding.js";
import { createAppsPanel } from "../web/assets/workbench/apps-panel.js";

/**
 * Wiring tests, against a real DOM.
 *
 * Every bug the user hit in this feature was a wiring bug — a state change that
 * never reached the workbench, a control hidden in the one state where it was
 * needed — and none of them were reachable from the pure-function tests, which
 * is why those stayed green while the screen was wrong. These drive the actual
 * elements from the shipped `index.html`.
 */
function browser() {
  const html = readFileSync("web/index.html", "utf8");
  const { window, document } = parseHTML(html);
  window.HTMLElement.prototype.getClientRects ??= () => [];
  // The modules reach for these as globals, exactly as they do in a browser.
  // `navigator` is deliberately left alone: on Node 24 it is getter-only, and
  // nothing under test needs it replaced.
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    CSS: globalThis.CSS,
    NodeFilter: globalThis.NodeFilter
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.NodeFilter = NodeFilter;
  globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, "\\$&") };
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  const click = (element) => element.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { window, document, restore, click, $: (selector) => document.querySelector(selector) };
}

function instance(id, title, resourceId, status = "open", conversations = [{ taskId: "task-1" }]) {
  return {
    appInstanceId: id,
    appType: "text-editor",
    title,
    resourceIds: [resourceId],
    resourceId,
    status,
    conversations
  };
}

/** A tab as the global strip reports it. */
/**
 * A document tab, keyed by its resource.
 *
 * It carries no `taskId`: a document belongs to no conversation, and every
 * conversation referencing it shares this one tab. `conversations` is what the
 * server reports in its place, and `groupTaskId` is which of them it sorts under.
 */
function appTab(taskId, appInstanceId, title, resourceId, taskGoal) {
  return {
    tabId: `resource:${resourceId}`,
    kind: "application",
    resourceId,
    appType: "text-editor",
    title,
    hasResource: true,
    conversations: taskId ? [{ taskId, goal: taskGoal }] : [],
    ...(taskId ? { groupTaskId: taskId, taskGoal } : { standalone: true }),
    openedAt: "2026-01-01T00:00:00.000Z"
  };
}
/** An application window with nothing in it yet; it still belongs to a conversation. */
function emptyTab(taskId, appInstanceId, title = "文本编辑器") {
  return {
    tabId: `window:${appInstanceId}`,
    kind: "application",
    taskId,
    appInstanceId,
    appType: "text-editor",
    title,
    hasResource: false,
    openedAt: "2026-01-01T00:00:00.000Z"
  };
}
function chatTab(taskId, taskGoal) {
  return {
    tabId: `conversation:${taskId}`,
    kind: "conversation",
    taskId,
    title: taskGoal,
    taskGoal,
    openedAt: "2026-01-01T00:00:00.000Z"
  };
}

/** A stub adapter: enough to prove the host mounts and unmounts it. */
function stubAdapter(log = []) {
  return {
    definition: { appType: "text-editor", resourceKinds: ["text/markdown"] },
    async mount(host, { instance }) {
      // Identified by the document it shows. An empty window has none, so it
      // falls back to its own id — the one case where a window is the identity.
      const id = instance.resourceIds?.[0] ?? instance.appInstanceId;
      log.push(`mount:${id}`);
      host.innerHTML = `<div data-stub="${id}">编辑器</div>`;
      return {
        unmount: async () => {
          log.push(`unmount:${id}`);
          host.innerHTML = "";
        }
      };
    }
  };
}

test("the shipped page contains every element the workbench wires to", () => {
  const { $, restore } = browser();
  try {
    for (const selector of [
      "#workbench",
      "[data-tab-strip]",
      "#conversation-pane",
      "#apps-nav",
      "#apps-panel",
      "#app-bind-select",
      "#app-bind-menu",
      "#app-bind-select .app-bind-name"
    ]) {
      assert.ok($(selector), `index.html must contain ${selector}`);
    }
    assert.equal($("#apps-nav").hidden, true);
    assert.equal($("#app-bind-select").hidden, true);
    assert.equal($("#workbench").hidden, true);
  } finally {
    restore();
  }
});

function host(t, extra = {}) {
  const view = browser();
  t.after(view.restore);
  const log = [];
  const controller = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: { "text-editor": stubAdapter(log) },
    api: {
      activateTab: async (id) => log.push(`activate:${id}`),
      closeTab: async (id) => log.push(`close:${id}`)
    },
    onConversationTask: (taskId) => log.push(`conversation:${taskId}`),
    ...extra
  });
  return { ...view, host: controller, log };
}

test("the strip holds tabs from several tasks at once", async (t) => {
  const { $, host: workbench } = host(t);
  await workbench.update({
    tabs: [
      chatTab("task-a", "产品方案"),
      appTab("task-a", "app_1", "方案.md", "res_1", "产品方案"),
      chatTab("task-b", "调研"),
      appTab("task-b", "app_2", "笔记.md", "res_2", "调研")
    ],
    activeTabId: "conversation:task-a"
  });
  const rendered = [...$("[data-tab-strip]").querySelectorAll("[data-tab]")].map((node) => node.dataset.tab);
  // Two conversations and two documents, side by side — the point of the change.
  assert.deepEqual(rendered, [
    "conversation:task-a",
    "resource:res_1",
    "conversation:task-b",
    "resource:res_2"
  ]);
  // The first tab of each group says which conversation it belongs to, so two
  // documents with the same name from different tasks stay distinguishable.
  const markup = $("[data-tab-strip]").innerHTML;
  assert.match(markup, /产品方案/);
  assert.match(markup, /调研/);
  // Every tab closes, including a conversation: closing a view is not deleting
  // a task.
  assert.equal($("[data-tab-strip]").querySelectorAll("[data-close-tab]").length, 4);
});

test("open applications use the workbench rail while the global strip stays hidden", async (t) => {
  const { $, host: workbench } = host(t);
  const tabs = [chatTab("task-a", "产品方案"), appTab("task-a", "app_1", "方案.md", "res_1", "产品方案")];
  await workbench.update({ tabs, activeTabId: "conversation:task-a" });

  const rail = $("[data-tab-rail]");
  assert.equal($("[data-tab-strip]").hidden, true);
  assert.equal(rail.hidden, true, "a conversation without an open right pane has no global file row");
  assert.equal(rail.parentElement.hasAttribute("data-workbench-header"), true);
  assert.equal(rail.parentElement.parentElement.id, "workbench");

  await workbench.activate("resource:res_1");
  assert.equal(rail.hidden, false);
  assert.equal(rail.querySelectorAll("[data-tab]").length, 1);
  assert.equal(rail.querySelector("[data-tab]").getAttribute("aria-label"), "文件：方案.md");
  assert.equal(rail.querySelector("[data-tab]").classList.contains("active"), true);
});

test("the right workbench header keeps session files and view controls together", async (t) => {
  const view = browser();
  const previousMedia = view.window.matchMedia;
  view.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const workbench = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: { "text-editor": stubAdapter() },
    api: { activateTab: async () => {} }
  });
  t.after(async () => {
    await workbench.destroy();
    if (previousMedia === undefined) delete view.window.matchMedia;
    else view.window.matchMedia = previousMedia;
    view.restore();
  });
  const shared = appTab("task-a", "shared", "共享.txt", "shared");
  shared.conversations.push({ taskId: "task-b" });
  const tabs = [
    chatTab("task-a", "甲"),
    chatTab("task-b", "乙"),
    appTab("task-a", "a", "甲.txt", "a"),
    appTab("task-b", "b", "乙.txt", "b"),
    shared,
    appTab(null, "loose", "独立.txt", "loose")
  ];
  const rail = view.$("[data-tab-rail]");
  const ids = () => [...rail.querySelectorAll("[data-tab]")].map((node) => node.dataset.tab);
  await workbench.update({
    tabs,
    actingTaskId: "task-a",
    activeTabId: "conversation:task-a",
    boundResourceId: "a"
  });
  assert.deepEqual(ids(), ["resource:a", "resource:shared"]);
  assert.equal(rail.hidden, false);
  assert.equal(view.$(".chat-pane").classList.contains("is-collaborating"), true);
  const header = view.$("[data-workbench-header]");
  assert.equal(header.contains(rail), true);
  assert.equal(header.contains(view.$("[data-app-expand]")), true);
  assert.equal(view.$("[data-app-collapse]"), null, "the shell has one workspace visibility control");
  assert.equal(view.$("[data-file-switcher]"), null, "the file list has no duplicate menu");
  assert.equal(view.$("[data-app-return-conversation]"), null, "collapsing the view never binds it");
  assert.deepEqual(
    [...rail.querySelectorAll("[data-close-tab]")].map((node) => node.dataset.closeTab),
    ["resource:a", "resource:shared"]
  );
  await workbench.activate("conversation:task-b");
  assert.equal(
    rail.hidden,
    true,
    "changing sessions never leaves the previous session's tabs above the chat"
  );
  await workbench.update({
    tabs,
    actingTaskId: "task-b",
    activeTabId: "conversation:task-b",
    boundResourceId: "b"
  });
  assert.deepEqual(ids().sort(), ["resource:b", "resource:shared"]);
  assert.equal(rail.hidden, false);
  await workbench.collapseApplication();
  assert.equal(rail.hidden, true);
  workbench.openDraftConversation();
  assert.equal(rail.hidden, true);
  assert.equal(rail.querySelectorAll("[data-tab]").length, 0);
});

test("workspace visibility restores each session's own file and keeps a new draft isolated", async (t) => {
  const { host: workbench, $ } = host(t);
  const tabs = [
    chatTab("task-a", "甲"),
    chatTab("task-b", "乙"),
    appTab("task-a", "a", "甲.txt", "a"),
    appTab("task-b", "b", "乙.txt", "b")
  ];
  await workbench.update({ tabs, activeTabId: "resource:a", actingTaskId: "task-a" });
  await workbench.collapseApplication();
  assert.equal(workbench.applicationVisible, false);
  assert.equal(workbench.workspaceApplicationTab.tabId, "resource:a");
  assert.equal(workbench.canToggleApplication, true);
  await workbench.activate("conversation:task-b");
  assert.equal(workbench.workspaceApplicationTab, undefined);
  assert.equal(workbench.canToggleApplication, false, "another session cannot restore the previous file");
  assert.equal(await workbench.toggleApplication(), false);
  await workbench.activate("resource:b");
  await workbench.collapseApplication();
  assert.equal(await workbench.toggleApplication(), true);
  assert.equal(workbench.applicationTab.tabId, "resource:b");
  await workbench.collapseApplication();
  await workbench.activate("conversation:task-a");
  assert.equal(await workbench.toggleApplication(), true);
  assert.equal(workbench.applicationTab.tabId, "resource:a");
  assert.equal($("[data-workbench-header]").hidden, false);
  await workbench.collapseApplication();
  workbench.openDraftConversation();
  assert.equal(workbench.workspaceApplicationTab, undefined);
  assert.equal(workbench.canToggleApplication, false, "a draft never inherits a remembered session view");
  assert.equal(await workbench.toggleApplication(), false);
});

test("a remembered workspace cannot restore a file no longer associated with its session", async (t) => {
  const { host: workbench } = host(t);
  const shared = appTab("task-a", "shared", "共享.txt", "shared");
  shared.conversations.push({ taskId: "task-b" });
  const conversations = [chatTab("task-a", "甲"), chatTab("task-b", "乙")];
  await workbench.update({
    tabs: [...conversations, shared],
    actingTaskId: "task-a",
    activeTabId: shared.tabId
  });
  await workbench.collapseApplication();
  await workbench.update({
    tabs: [...conversations, { ...shared, conversations: [{ taskId: "task-b" }] }],
    actingTaskId: "task-a",
    activeTabId: "conversation:task-a"
  });
  assert.equal(workbench.canToggleApplication, false);
  assert.equal(await workbench.toggleApplication(), false);
  await workbench.activate("conversation:task-b");
  await workbench.activate(shared.tabId);
  await workbench.collapseApplication();
  assert.equal(await workbench.toggleApplication(), true);
  assert.equal(workbench.applicationTab.tabId, shared.tabId);
});

test("a standalone workspace restores its editor and expanded presentation state", async (t) => {
  const { host: workbench, $ } = host(t);
  const tab = appTab(null, "standalone", "独立.txt", "standalone");
  await workbench.update({ tabs: [tab], activeTabId: tab.tabId });
  const original = $("[data-app-mount]");
  workbench.setExpanded(true);
  await workbench.collapseApplication();
  assert.equal(workbench.applicationVisible, false);
  assert.equal(workbench.canToggleApplication, true);
  await workbench.toggleApplication();
  assert.equal(workbench.applicationTab.tabId, tab.tabId);
  assert.equal($(".chat-pane").classList.contains("is-app-expanded"), true);
  assert.equal($("[data-app-mount]"), original, "visibility changes preserve the existing editor and draft");
});

test("an obsolete workspace restore cannot overwrite a later activation of the same file", async (t) => {
  let release;
  let delayRestore = false;
  let delayed = false;
  const { host: workbench, $ } = host(t, {
    api: {
      activateTab: (tabId) => {
        if (delayRestore && !delayed && tabId === "resource:a") {
          delayed = true;
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      }
    }
  });
  const tabs = [chatTab("task-a", "甲"), appTab("task-a", "a", "甲.txt", "a")];
  await workbench.update({ tabs, actingTaskId: "task-a", activeTabId: "resource:a" });
  workbench.setExpanded(true);
  await workbench.collapseApplication();
  delayRestore = true;
  const restoring = workbench.toggleApplication();
  assert.equal(delayed, true);
  await workbench.activate("resource:a");
  workbench.setExpanded(false);
  release();
  await restoring;
  assert.equal(workbench.activeTabId, "resource:a");
  assert.equal(
    $(".chat-pane").classList.contains("is-app-expanded"),
    false,
    "a stale restore must not reapply its old expanded mode after newer navigation"
  );
});

test("closing a session file chooses another file from that session before another session's editor", async (t) => {
  const { host: workbench } = host(t);
  await workbench.update({
    tabs: [
      appTab("task-b", "foreign", "乙.txt", "b"),
      chatTab("task-a", "甲"),
      appTab("task-a", "first", "甲一.txt", "a-one"),
      appTab("task-a", "second", "甲二.txt", "a-two")
    ],
    actingTaskId: "task-a",
    activeTabId: "resource:a-one"
  });
  await workbench.close("resource:a-one");
  assert.equal(workbench.activeTabId, "resource:a-two");
  await workbench.close("resource:a-two");
  assert.equal(workbench.activeTabId, "conversation:task-a");
});

test("switching to another task's document does not unmount the first", async (t) => {
  const { $, host: workbench, log } = host(t);
  const tabs = [
    appTab("task-a", "app_1", "A.md", "res_1", "甲"),
    appTab("task-b", "app_2", "B.md", "res_2", "乙")
  ];
  await workbench.update({ tabs, activeTabId: "resource:res_1" });
  await workbench.activate("resource:res_2");
  // Both stay mounted: this is exactly what per-task rebuilding used to break.
  assert.deepEqual(
    log.filter((entry) => entry.startsWith("mount")),
    ["mount:res_1", "mount:res_2"]
  );
  assert.equal(log.includes("unmount:res_1"), false, "another task's editor must stay open");
  assert.ok($('[data-stub="res_1"]'), "the first task's editor is still in the DOM");
  assert.ok($('[data-stub="res_2"]'));
  // Only the active one is visible.
  const panes = [...$("#workbench").querySelectorAll("[data-app-mount]")];
  assert.deepEqual(
    panes.map((pane) => pane.hidden),
    [true, false]
  );
});

test("application binding waits for durable tab activation", async (t) => {
  let finish,
    bound = false,
    persisted = false;
  const { host: workbench } = host(t, {
    api: {
      activateTab: () =>
        new Promise((resolve) => {
          finish = () => {
            persisted = true;
            resolve();
          };
        })
    },
    onTabActivate: async () => {
      assert.equal(persisted, true);
      bound = true;
    }
  });
  const tabs = [chatTab("task-a", "甲"), appTab("task-a", "app_1", "A.md", "res_1", "甲")];
  await workbench.update({ tabs, activeTabId: "conversation:task-a" });
  const activating = workbench.activate("resource:res_1");
  assert.equal(bound, false);
  finish();
  await activating;
  assert.equal(bound, true);
});

for (const destination of ["draft", "task-b"])
  test(`a late activation and an obsolete server selection preserve the later ${destination} choice`, async (t) => {
    let finish, persisted;
    const selected = [];
    const { host: workbench } = host(t, {
      api: {
        activateTab: (id) =>
          id === "conversation:task-a"
            ? new Promise((resolve) => {
                finish = () => {
                  persisted = id;
                  resolve();
                };
              })
            : Promise.resolve().then(() => {
                persisted = id;
              })
      },
      onConversationTask: (taskId) => selected.push(taskId)
    });
    const tabs = [
      chatTab("task-a", "A"),
      chatTab("task-b", "B"),
      appTab("task-a", "app_1", "A.txt", "res_1")
    ];
    await workbench.update({ tabs, activeTabId: "resource:res_1" });
    const old = workbench.activate("conversation:task-a");
    if (destination === "draft") workbench.openDraftConversation();
    else await workbench.activate("conversation:task-b");
    const callbacks = [...selected];
    finish();
    await old;
    assert.deepEqual(selected, callbacks, "the old activation cannot reselect its conversation");
    const expected = destination === "draft" ? DRAFT_TAB_ID : "conversation:task-b";
    assert.equal(workbench.activeTabId, expected);
    assert.equal(
      persisted,
      destination === "draft" ? null : expected,
      "late writes must restore the latest persisted focus"
    );
    await workbench.update({ tabs, activeTabId: "resource:res_1" });
    assert.equal(workbench.activeTabId, expected, "polling cannot replay an old server activation");
    assert.deepEqual(selected, callbacks);
  });

test("failed focus persistence returns without retrying or changing the visible choice", async (t) => {
  const writes = [];
  const { host: workbench } = host(t, {
    api: {
      activateTab: async (id) => {
        writes.push(id);
        throw new Error("offline");
      }
    }
  });
  const tabs = [chatTab("task-a", "A"), chatTab("task-b", "B")];
  await workbench.update({ tabs, activeTabId: "conversation:task-a" });
  await workbench.activate("conversation:task-b");
  assert.equal(workbench.activeTabId, "conversation:task-b");
  assert.deepEqual(writes, ["conversation:task-b"]);
});

test("a slow editor mount stays hidden until ready and switching back preserves the previous draft", async (t) => {
  const view = browser();
  let releaseMount, signalMount;
  const mounting = new Promise((resolve) => {
    signalMount = resolve;
  });
  const mounts = [];
  const workbench = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: {
      "text-editor": {
        async mount(element, { instance }) {
          const id = instance.resourceIds[0];
          mounts.push(id);
          element.innerHTML = `<textarea>${id}</textarea>`;
          if (id === "res_2") {
            signalMount();
            await new Promise((resolve) => {
              releaseMount = resolve;
            });
          }
          return {};
        }
      }
    },
    api: { activateTab: async () => {} }
  });
  t.after(async () => {
    releaseMount?.();
    await workbench.destroy();
    view.restore();
  });
  const tabs = [appTab(undefined, "app_1", "A.txt", "res_1"), appTab(undefined, "app_2", "B.txt", "res_2")];
  await workbench.update({ tabs, activeTabId: "resource:res_1" });
  const previous = view.$('[data-app-mount="resource:res_1"]');
  const draft = previous.querySelector("textarea");
  draft.value = "保留未保存的修改";
  const activating = workbench.activate("resource:res_2");
  await mounting;
  const next = view.$('[data-app-mount="resource:res_2"]');
  assert.equal(
    next.hidden,
    true,
    "new editor content cannot overlap the current editor during its asynchronous mount"
  );
  assert.deepEqual(
    [...view.document.querySelectorAll("[data-app-mount]")].filter((node) => !node.hidden),
    [previous]
  );
  assert.equal(draft.value, "保留未保存的修改");
  releaseMount();
  await activating;
  assert.equal(next.hidden, false);
  assert.equal(previous.hidden, true);
  await workbench.activate("resource:res_1");
  assert.equal(previous.hidden, false);
  assert.equal(next.hidden, true);
  assert.equal(previous.querySelector("textarea"), draft);
  assert.equal(draft.value, "保留未保存的修改");
  assert.deepEqual(mounts, ["res_1", "res_2"]);
});

test("selecting a conversation tab switches the conversation and shows its pane", async (t) => {
  const { document, $, click, host: workbench, log } = host(t);
  await workbench.update({
    tabs: [appTab("task-a", "app_1", "A.md", "res_1", "甲"), chatTab("task-b", "乙")],
    activeTabId: "resource:res_1"
  });
  assert.equal($("#conversation-pane").hidden, true);
  assert.equal(document.body.classList.contains("app-fullbleed"), true);

  const tab = [...$("[data-tab-strip]").querySelectorAll("[data-tab]")].find(
    (node) => node.dataset.tab === "conversation:task-b"
  );
  click(tab);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The strip drives the conversation, not the other way round.
  assert.ok(log.includes("conversation:task-b"), "selecting a conversation tab must switch the conversation");
  assert.equal($("#conversation-pane").hidden, false);
  assert.equal(document.body.classList.contains("app-fullbleed"), false);
  assert.ok(log.includes("activate:conversation:task-b"), "the server records which tab is active");
});

test("closing a tab focuses a neighbour and tells the server", async (t) => {
  const { $, click, host: workbench, log } = host(t);
  await workbench.update({
    tabs: [appTab("task-a", "app_1", "A.md", "res_1", "甲"), chatTab("task-b", "乙")],
    activeTabId: "resource:res_1"
  });
  const close = $("[data-tab-strip]").querySelector('[data-close-tab="resource:res_1"]');
  click(close);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(log.includes("close:resource:res_1"));
  assert.ok(log.includes("unmount:res_1"));
  assert.equal(workbench.activeTabId, "conversation:task-b", "focus moves to a neighbour, not nowhere");
  assert.equal($("#conversation-pane").hidden, false);
});

test("a resource event reaches the one tab that holds it, and no other", async (t) => {
  const { host: workbench } = host(t);
  const seen = [];
  const tracking = {
    definition: { appType: "text-editor", resourceKinds: ["text/markdown"] },
    async mount(element, { instance, taskId }) {
      element.innerHTML = "<div></div>";
      return {
        handleResourceEvent: (event) => seen.push(`${instance.resourceIds[0]}:${event.revision}`),
        unmount: async () => {}
      };
    }
  };
  const view = browser();
  t.after(view.restore);
  const scoped = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: { "text-editor": tracking },
    api: { activateTab: async () => {} }
  });
  // Two different documents. One resource can no longer appear in two tabs —
  // that was the bug — so what has to be true is that an event reaches the tab
  // holding its own resource and leaves the other alone. The `taskId` on the
  // event is deliberately not part of the match: a document tab has none.
  await scoped.update({
    tabs: [
      appTab("task-a", "app_1", "甲.md", "res_1", "甲"),
      appTab("task-b", "app_2", "乙.md", "res_2", "乙")
    ],
    activeTabId: "resource:res_1"
  });
  await scoped.activate("resource:res_2");
  scoped.handleEvent({
    type: "resource.operation_applied",
    taskId: "task-a",
    resourceId: "res_1",
    revision: 7
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen, ["res_1:7"], "the event must reach only the document it is about");
});

test("resource event delivery waits for the adapter and reports asynchronous read failures", async (t) => {
  let release;
  const errors = [];
  const { host: workbench } = host(t, {
    registry: {
      "text-editor": {
        ...stubAdapter(),
        async mount(element) {
          element.innerHTML = "<div>文稿</div>";
          return {
            async handleResourceEvent() {
              await new Promise((resolve) => {
                release = resolve;
              });
              throw new Error("offline");
            },
            unmount() {}
          };
        }
      }
    },
    onError: (message) => errors.push(message)
  });
  await workbench.update({
    tabs: [appTab(null, "instance", "文稿", "resource")],
    activeTabId: "resource:resource"
  });
  let settled = false;
  const pending = workbench
    .handleEvent({ type: "resource.operation_applied", resourceId: "resource", revision: 1 })
    .then((result) => {
      settled = true;
      return result;
    });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.equal(await pending, false);
  assert.deepEqual(errors, ["应用事件处理失败：offline"]);
});

test("an empty strip explains itself and leaves the conversation showing", async (t) => {
  const { document, $, host: workbench } = host(t);
  await workbench.update({ tabs: [] });
  assert.match($("[data-tab-strip]").innerHTML, /没有打开的标签/);
  assert.equal($("#conversation-pane").hidden, false);
  assert.equal(document.body.classList.contains("app-fullbleed"), false);
});

test("tearing the host down restores the layout and unmounts everything", async (t) => {
  const { document, $, host: workbench, log } = host(t);
  await workbench.update({
    tabs: [appTab("task-a", "app_1", "A.md", "res_1", "甲")],
    activeTabId: "resource:res_1"
  });
  assert.equal(document.body.classList.contains("app-fullbleed"), true);
  await workbench.destroy();
  assert.ok(log.includes("unmount:res_1"));
  assert.equal(document.body.classList.contains("app-fullbleed"), false);
  assert.equal(
    $("#conversation-pane").hidden,
    false,
    "a blank pane with the conversation hidden is not a valid end state"
  );
  assert.equal($("#workbench").querySelector("[data-app-mount]"), null);
});

test("one tab is never mounted twice, even when activate and update race", async (t) => {
  const { $, restore } = browser();
  t.after(restore);
  const log = [];
  let release;
  const slow = {
    definition: { appType: "text-editor", resourceKinds: ["text/markdown"] },
    async mount(element, { instance }) {
      const id = instance.resourceIds?.[0] ?? instance.appInstanceId;
      log.push(`mount:${id}`);
      await new Promise((resolve) => {
        release = resolve;
      });
      element.innerHTML = `<div data-stub="${id}"></div>`;
      return {
        unmount: async () => {
          log.push(`unmount:${id}`);
        }
      };
    }
  };
  const workbench = createWorkbenchHost({
    root: $("#workbench"),
    conversationElement: $("#conversation-pane"),
    registry: { "text-editor": slow },
    api: { activateTab: async () => {} }
  });
  const tabs = [appTab("task-a", "app_1", "A.md", "res_1", "甲")];
  // No await here: the first update would block on the slow mount, so awaiting
  // it before releasing deadlocks the test rather than exercising the race.
  const first = workbench.update({ tabs, activeTabId: "resource:res_1" });
  const activating = workbench.activate("resource:res_1");
  const second = workbench.update({ tabs, activeTabId: "resource:res_1" });
  // Let the in-flight mount finish now that three callers are contending.
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await Promise.all([first, activating, second]);
  assert.deepEqual(
    log,
    ["mount:res_1"],
    "a double mount orphans the first controller with its timers still live"
  );
  assert.equal($("#workbench").querySelectorAll('[data-stub="res_1"]').length, 1);
});

test("the binding control stays usable when no application is open", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  const button = $("#app-bind-select");
  button.hidden = false;
  const binding = createBindingControl({
    button,
    menu: $("#app-bind-menu"),
    label: button.querySelector(".app-bind-name"),
    api: {},
    getTaskId: () => "task-1"
  });

  binding.update({ instances: [], activeInstanceId: undefined });
  assert.equal(button.hidden, false, "hiding it here removes the only way to bind an application");
  assert.equal(button.querySelector(".app-bind-name").textContent, "没有打开的应用");
  binding.open();
  assert.match($("#app-bind-menu").innerHTML, /当前工作区没有打开的应用/);
  assert.equal($("#app-bind-menu").querySelector("[data-bind-instance]"), null);
});

test("selecting an application in the composer binds it and moves the tab", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  const button = $("#app-bind-select");
  button.hidden = false;
  const bound = [];
  const binding = createBindingControl({
    button,
    menu: $("#app-bind-menu"),
    label: button.querySelector(".app-bind-name"),
    api: {
      setActiveInstance: async (taskId, id) => {
        bound.push(id);
      },
      unbind: async () => {
        bound.push("unbound");
      }
    },
    getTaskId: () => "task-1",
    onSelect: (id) => bound.push(`tab:${id ?? "none"}`)
  });

  binding.update({
    instances: [instance("app_1", "方案.md", "res_1"), instance("app_2", "记录.md", "res_2")],
    boundResourceId: undefined
  });
  assert.equal(button.querySelector(".app-bind-name").textContent, "未加载应用");
  binding.open();

  const option = [...$("#app-bind-menu").querySelectorAll("[data-bind-instance]")].find(
    (node) => node.dataset.bindInstance === "app_2"
  );
  click(option);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // One act, one caller. Opening the document's tab and naming the conversation
  // are the same request now, so the control hands the choice over rather than
  // issuing a binding call of its own.
  assert.deepEqual(bound, ["tab:app_2"], "the choice reaches the caller, which performs it");

  binding.update({
    instances: [instance("app_1", "方案.md", "res_1"), instance("app_2", "记录.md", "res_2")],
    boundResourceId: "res_2"
  });
  assert.equal(button.querySelector(".app-bind-name").textContent, "记录.md");
  assert.equal(button.classList.contains("is-bound"), true);
});

test("detaching is selectable and reported as such", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  const button = $("#app-bind-select");
  button.hidden = false;
  const calls = [];
  const binding = createBindingControl({
    button,
    menu: $("#app-bind-menu"),
    label: button.querySelector(".app-bind-name"),
    api: {
      unbind: async () => {
        calls.push("unbind");
      },
      setActiveInstance: async () => {
        calls.push("bind");
      }
    },
    getTaskId: () => "task-1",
    onSelect: (id) => calls.push(`tab:${id ?? "none"}`)
  });
  binding.update({ instances: [instance("app_1", "a.md", "res_1")], activeInstanceId: "app_1" });
  binding.open();
  const detach = $("#app-bind-menu").querySelector('[data-bind-instance="__unbound__"]');
  assert.ok(detach, "detaching is an option, not the absence of one");
  click(detach);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["unbind", "tab:none"]);
});

for (const failed of [false, true])
  test(`a stale applications list ${failed ? "failure" : "response"} cannot replace a reopened conversation's files`, async (t) => {
    const { $, restore } = browser();
    t.after(restore);
    let task = "task-a",
      finish,
      fail,
      started;
    const reading = new Promise((resolve) => {
      started = resolve;
    });
    const old = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const panel = createAppsPanel({
      navButton: $("#apps-nav"),
      panel: $("#apps-panel"),
      getTaskId: () => task,
      getNavigationContext: () => task,
      api: {
        listApplications: async () => ({ applications: [] }),
        listResources: async (taskId) => {
          if (taskId === "task-a") {
            started();
            return old;
          }
          return { resources: [{ resourceId: "b", title: "B 的文件", appType: "text-editor" }] };
        }
      }
    });
    t.after(() => panel.close());
    const first = panel.toggle();
    await reading;
    panel.close();
    task = "task-b";
    await panel.toggle();
    if (failed) fail(new Error("A 的过期失败"));
    else finish({ resources: [{ resourceId: "a", title: "A 的旧文件", appType: "text-editor" }] });
    await first;
    assert.match($("#apps-panel").innerHTML, /B 的文件/);
    assert.doesNotMatch($("#apps-panel").innerHTML, /A 的旧文件|A 的过期失败/);
  });

test("application tiles become usable before file reads finish and retain pending state", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let finishCatalog, finishFiles, finishTemporary, finishOpening;
  const calls = [];
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: () => {
        calls.push("catalog");
        return new Promise((resolve) => {
          finishCatalog = resolve;
        });
      },
      listResources: () => {
        calls.push("files");
        return new Promise((resolve) => {
          finishFiles = resolve;
        });
      },
      listTemporaryResources: () => {
        calls.push("temporary");
        return new Promise((resolve) => {
          finishTemporary = resolve;
        });
      },
      openStandaloneApplication: () => {
        calls.push("open");
        return new Promise((resolve) => {
          finishOpening = resolve;
        });
      }
    },
    onOpened: () => calls.push("mounted")
  });
  t.after(() => panel.close());
  const showing = panel.toggle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(new Set(calls), new Set(["catalog", "files", "temporary"]));
  finishCatalog({
    applications: [
      {
        appType: "text-editor",
        displayName: "文本编辑器",
        resourceKinds: ["text/plain"],
        capabilities: ["edit"]
      }
    ]
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tile = $('[data-create-app="text-editor"]');
  assert.ok(tile, "file discovery must not delay opening an application");
  click(tile);
  click(tile);
  assert.equal(calls.filter((entry) => entry === "open").length, 1);
  assert.equal(tile.disabled, true);
  assert.equal(tile.getAttribute("aria-busy"), "true");
  assert.equal(panel.isOpen, true, "pending launch remains visible");
  finishFiles({ resources: [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }] });
  finishTemporary({ resources: [] });
  await showing;
  assert.ok(
    $('[data-create-app="text-editor"]') === tile,
    "late files preserve the live application control"
  );
  assert.equal(tile.disabled, true);
  assert.equal(tile.getAttribute("aria-busy"), "true");
  finishOpening({ appInstance: { appInstanceId: "app-1" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.isOpen, false);
  assert.equal(calls.at(-1), "mounted");
});

test("opening a file prevents duplicates and does not reread or reopen the sidebar after success", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let finishOpening;
  const calls = [];
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: async () => ({ applications: [] }),
      listResources: async () => {
        calls.push("files");
        return { resources: [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }] };
      },
      openResource: () => {
        calls.push("open");
        return new Promise((resolve) => {
          finishOpening = resolve;
        });
      },
      openTab: async () => calls.push("tab")
    },
    onOpened: () => calls.push("mounted")
  });
  t.after(() => panel.close());
  await panel.toggle();
  const file = $('[data-open-resource="res-1"]');
  click(file);
  click(file);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.filter((entry) => entry === "open").length, 1);
  assert.equal(file.disabled, true);
  assert.equal(file.getAttribute("aria-busy"), "true");
  panel.close();
  finishOpening();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.isOpen, false);
  assert.deepEqual(calls, ["files", "open", "tab", "mounted"]);
});

test("a failed file open clears pending state and can be retried", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let attempts = 0;
  const errors = [];
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: async () => ({ applications: [] }),
      listResources: async () => ({
        resources: [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }]
      }),
      openResource: async () => {
        if (++attempts === 1) throw new Error("暂时不可用");
      }
    },
    onError: (error) => errors.push(error)
  });
  t.after(() => panel.close());
  await panel.toggle();
  const file = $('[data-open-resource="res-1"]');
  click(file);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.isOpen, true);
  assert.equal(file.disabled, false);
  assert.equal(file.hasAttribute("aria-busy"), false);
  assert.deepEqual(errors, ["打开失败：暂时不可用"]);
  click(file);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.equal(panel.isOpen, false);
});

test("an application catalog failure exposes a retry while its files remain available", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let attempts = 0;
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: () => {
        if (++attempts === 1) throw new Error("暂时不可用");
        return {
          applications: [
            {
              appType: "text-editor",
              displayName: "文本编辑器",
              resourceKinds: ["text/plain"],
              capabilities: ["edit"]
            }
          ]
        };
      },
      listResources: async () => ({
        resources: [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }]
      })
    }
  });
  t.after(() => panel.close());
  await panel.toggle();
  assert.ok($('[data-open-resource="res-1"]'));
  assert.ok($("[data-retry-apps]"), "an unavailable catalog must have an actionable retry");
  click($("[data-retry-apps]"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 2);
  assert.ok($('[data-create-app="text-editor"]'));
  assert.equal($("[data-retry-apps]"), null);
});

test("refreshing application files preserves the current controls while reading and on an unchanged response", async (t) => {
  const { $, restore } = browser();
  t.after(restore);
  let finishFiles,
    attempts = 0;
  const resources = [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }];
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: async () => ({ applications: [] }),
      listResources: () =>
        ++attempts === 1
          ? Promise.resolve({ resources })
          : new Promise((resolve) => {
              finishFiles = resolve;
            })
    }
  });
  t.after(() => panel.close());
  await panel.toggle();
  const file = $('[data-open-resource="res-1"]');
  const refreshing = panel.refresh();
  assert.ok($('[data-open-resource="res-1"]') === file, "pending refresh retains the current file control");
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishFiles({ resources });
  await refreshing;
  assert.ok(
    $('[data-open-resource="res-1"]') === file,
    "an unchanged response retains the current file control"
  );
});

test("failed file discovery retains the usable catalog and cached files with a retry", async (t) => {
  const { $, restore } = browser();
  t.after(restore);
  let attempts = 0;
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    getTaskId: () => "task-1",
    api: {
      listApplications: async () => ({
        applications: [
          {
            appType: "text-editor",
            displayName: "文本编辑器",
            resourceKinds: ["text/plain"],
            capabilities: ["edit"]
          }
        ]
      }),
      listResources: async () => {
        if (++attempts > 1) throw new Error("暂时不可用");
        return { resources: [{ resourceId: "res-1", title: "文件.md", appType: "text-editor" }] };
      }
    }
  });
  t.after(() => panel.close());
  await panel.toggle();
  const tile = $('[data-create-app="text-editor"]');
  await panel.refresh();
  assert.ok(
    $('[data-create-app="text-editor"]') === tile,
    "file errors retain the usable application control"
  );
  assert.equal(tile.disabled, false);
  assert.ok($('[data-open-resource="res-1"]'));
  assert.ok($("[data-retry-apps]"));
});

test("clicking an application opens it without demanding a filename", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  const calls = [];
  const navButton = $("#apps-nav");
  navButton.hidden = false;
  let prompted = false;
  globalThis.window.prompt = () => {
    prompted = true;
    return "不该被问";
  };
  const panel = createAppsPanel({
    navButton,
    panel: $("#apps-panel"),
    api: {
      listApplications: async () => ({
        applications: [
          {
            appType: "text-editor",
            displayName: "文本编辑器",
            resourceKinds: ["text/markdown"],
            capabilities: ["view", "edit"]
          }
        ]
      }),
      listResources: async () => ({
        resources: [{ resourceId: "res_1", title: "已有文档.md", appType: "text-editor", revision: 3 }]
      }),
      // The conversation endpoint must not be used by an application entry.
      openApplication: async (taskId, appType) => {
        calls.push(`open:${appType}@${taskId}`);
        return { appInstance: { appInstanceId: "app_new" }, taskId };
      },
      openStandaloneApplication: async (appType) => {
        calls.push(`standalone:${appType}`);
        return { appInstance: { appInstanceId: "app_new" }, taskId: "workspace" };
      },
      openTab: async ({ taskId, appInstanceId }) => {
        calls.push(`tab:${taskId}:${appInstanceId}`);
      }
    },
    getTaskId: () => "task-1",
    getOpenResourceIds: () => [],
    getWorkspaceRoot: () => "/workspace",
    onOpened: ({ resourceId, appInstanceId }) => calls.push(`opened:${resourceId ?? appInstanceId}`)
  });
  t.after(() => panel.close());

  await panel.toggle();
  assert.equal($("#apps-panel").hidden, false);
  assert.equal(navButton.getAttribute("aria-expanded"), "true");
  const markup = $("#apps-panel").innerHTML;
  assert.match(markup, /文本编辑器/);
  assert.match(markup, /已有文档\.md/);
  // The launcher offers only usable applications.
  assert.doesNotMatch(markup, /未接入|新实例归属|Python/);
  assert.equal($('[data-toggle-instances="text-editor"]').hidden, false);

  click($("#apps-panel").querySelector("[data-create-app]"));
  assert.equal(calls[0], "standalone:text-editor", "the application opens immediately");
  confirmApplicationWorkspaceInDom({ $, window: globalThis.window });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The bug this pins: opening the editor asked for a filename first, because
  // "open the application" and "create a file" were the same act.
  assert.equal(prompted, false, "opening an application must not ask for a filename");
  // A selected conversation must not change the independent launch behavior.
  assert.deepEqual(calls, ["standalone:text-editor", "opened:app_new"]);

  panel.close();
  assert.equal($("#apps-panel").hidden, true);
  assert.equal(navButton.getAttribute("aria-expanded"), "false");
});

test("the launcher omits runtime applications without a UI and hides empty instance lists", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let instances = [];
  const panel = createAppsPanel({
    navButton: $("#apps-nav"),
    panel: $("#apps-panel"),
    api: {
      listApplications: async () => ({
        applications: [
          {
            appType: "text-editor",
            displayName: "文本编辑器",
            resourceKinds: ["text/plain"],
            capabilities: ["edit"]
          },
          {
            appType: "runtime-only",
            displayName: "尚无编辑界面",
            resourceKinds: ["a/b"],
            capabilities: ["edit"]
          }
        ]
      }),
      listResources: async () => ({ resources: [] })
    },
    getTaskId: () => undefined,
    supportsApplication: (appType) => appType === "text-editor",
    getOpenApplications: () => instances
  });
  t.after(() => panel.close());
  await panel.toggle();
  assert.equal($('[data-create-app="runtime-only"]'), null);
  const toggle = $('[data-toggle-instances="text-editor"]');
  assert.equal(toggle.hidden, false);
  instances = [{ tabId: "window:1", appType: "text-editor", title: "我的草稿", workspaceRoot: "/work" }];
  panel.updateInstances();
  assert.equal(toggle.hidden, false);
  click(toggle);
  assert.equal($('[data-app-instances="text-editor"]').hidden, false);
  assert.match($('[data-app-instances="text-editor"]').textContent, /我的草稿/);
  instances = [];
  panel.updateInstances();
  assert.equal(toggle.hidden, false);
  assert.equal($('[data-app-instances="text-editor"]').hidden, true);
  assert.equal($('[data-app-instances="text-editor"]').textContent, "");
});

test("with no conversation open, the application window is standalone", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  const calls = [];
  const navButton = $("#apps-nav");
  navButton.hidden = false;
  const panel = createAppsPanel({
    navButton,
    panel: $("#apps-panel"),
    api: {
      listApplications: async () => ({
        applications: [
          {
            appType: "text-editor",
            displayName: "文本编辑器",
            resourceKinds: ["text/markdown"],
            capabilities: ["view", "edit"]
          }
        ]
      }),
      listResources: async () => ({ resources: [] }),
      openApplication: async (taskId, appType) => {
        calls.push(`scoped:${appType}@${taskId}`);
        return { appInstance: { appInstanceId: "app_x" } };
      },
      openStandaloneApplication: async (appType) => {
        calls.push(`standalone:${appType}`);
        return { appInstance: { appInstanceId: "app_loose" }, taskId: "workspace" };
      },
      openTab: async () => {
        calls.push("tab");
      }
    },
    getTaskId: () => undefined,
    getOpenResourceIds: () => [],
    getWorkspaceRoot: () => "/workspace",
    onOpened: ({ resourceId, appInstanceId, taskId }) =>
      calls.push(`opened:${resourceId ?? appInstanceId}@${taskId}`)
  });
  t.after(() => panel.close());

  await panel.toggle();
  click($("#apps-panel").querySelector("[data-create-app]"));
  assert.equal(calls[0], "standalone:text-editor", "the application opens immediately");
  confirmApplicationWorkspaceInDom({ $, window: globalThis.window });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["standalone:text-editor", "opened:app_loose@workspace"]);
});

test("an application window with no document shows its own empty state", async (t) => {
  const { window, document, restore } = browser();
  t.after(restore);
  const { textEditorAdapter } = await import("../web/assets/workbench/adapters/text-editor.js");
  const calls = [];
  const box = document.createElement("div");
  document.body.appendChild(box);
  const controller = await textEditorAdapter.mount(box, {
    // No resource: the window exists, the document does not yet.
    instance: { appInstanceId: "app_1", title: "文本编辑器", resourceIds: [] },
    taskId: "task-1",
    api: {
      listResources: async () => ({
        resources: [{ resourceId: "res_9", kind: "text/markdown", title: "之前的文档.md", revision: 2 }]
      }),
      createInApplication: async (taskId, appInstanceId, body) => {
        calls.push(body);
        return {};
      },
      openResourceInTab: (taskId, id) => calls.push(`open:${id}`)
    },
    onDirtyChange: () => {},
    onChanged: () => calls.push("changed")
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(
    box.querySelector("h2").textContent,
    /文本编辑器/,
    "the empty editor identifies the app beside its primary action"
  );
  assert.ok(box.querySelector("[data-empty-new]"));
  assert.ok(box.querySelector("[data-local-open]"));
  // It offers the documents that already exist in this task.
  assert.match(box.innerHTML, /之前的文档\.md/);

  box.querySelector('[data-open="res_9"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.ok(calls.includes("open:res_9"));

  // Naming happens here, where there is something to name.
  window.prompt = () => {
    throw new Error("prompt() is not supported");
  };
  box.querySelector("[data-empty-new]").dispatchEvent(new window.Event("click", { bubbles: true }));
  box.querySelector("[data-document-name]").value = "新方案.md";
  box
    .querySelector(".editor-name-form")
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    calls.find((entry) => typeof entry === "object"),
    { kind: "text/markdown", title: "新方案.md", initialContent: "" }
  );

  // The controller is complete even in this state; the host calls these.
  await controller.unmount();
  assert.equal(box.innerHTML, "");
});

test("a pending edit is flushed when the editor is closed", async (t) => {
  // The bug this pins: switching tabs cleared the debounce timer and left the
  // last edit unsent, so work typed just before closing was simply lost.
  const server = resourceServer({ content: "原有内容\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "原有内容\n马上就切走\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  // No waiting: close immediately, inside the debounce window.
  await editor.controller.unmount();
  assert.equal(server.state.content, "原有内容\n马上就切走\n", "closing must not discard the pending edit");
});

/** A fake server for one resource, so the editor can be driven end to end. */
function resourceServer({ content = "# 方案\n初稿\n", title = "方案.md" } = {}) {
  const state = { content, title, revision: 0, path: title, operations: [] };
  const calls = [];
  return {
    state,
    calls,
    api: {
      async readResource() {
        return {
          resource: {
            resourceId: "res_1",
            title: state.title,
            path: state.path,
            kind: "text/markdown",
            revision: state.revision
          },
          snapshot: { content: state.content, revision: state.revision },
          operations: state.operations
        };
      },
      async applyOperation(taskId, resourceId, body) {
        calls.push(body);
        if (body.baseRevision !== state.revision) {
          const error = new Error("资源已被更新");
          error.code = "revision_conflict";
          error.details = { currentRevision: state.revision };
          throw error;
        }
        const { from, to, text } = body.payload;
        state.content = state.content.slice(0, from) + text + state.content.slice(to);
        state.revision += 1;
        state.operations.push({
          revision: state.revision,
          actor: { type: "user" },
          summary: "编辑",
          operationType: body.operationType
        });
        return {
          resource: {
            resourceId: "res_1",
            title: state.title,
            path: state.path,
            kind: "text/markdown",
            revision: state.revision
          },
          snapshot: { content: state.content, revision: state.revision },
          event: state.operations.at(-1)
        };
      },
      async saveSelection() {},
      async renameResource(taskId, resourceId, next) {
        state.title = next;
        state.path = next;
        return {
          resource: {
            resourceId: "res_1",
            title: next,
            path: next,
            kind: "text/markdown",
            revision: state.revision
          }
        };
      },
      async listResources() {
        return {
          resources: [
            { resourceId: "res_1", title: state.title, kind: "text/markdown", revision: state.revision },
            { resourceId: "res_2", title: "另一份.md", kind: "text/markdown", revision: 1 },
            { resourceId: "res_cad", title: "其他模型.cad.json", kind: "cad/model", revision: 0 }
          ]
        };
      },
      async undo() {
        state.revision += 1;
        return {
          resource: {
            resourceId: "res_1",
            title: state.title,
            path: state.path,
            kind: "text/markdown",
            revision: state.revision
          },
          snapshot: { content: state.content, revision: state.revision },
          event: { revision: state.revision, actor: { type: "user" }, summary: "撤销" }
        };
      },
      downloadUrl: () => "/api/download",
      operationsUrl: () => "/api/operations",
      openResourceInTab: (taskId, id) => calls.push(`open:${id}`)
    }
  };
}

async function mountEditor(t, server) {
  const { window, document, click, restore } = browser();
  t.after(restore);
  const { textEditorAdapter } = await import("../web/assets/workbench/adapters/text-editor.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const controller = await textEditorAdapter.mount(container, {
    instance: { appInstanceId: "app_1", title: server.state.title, resourceIds: ["res_1"] },
    taskId: "task-1",
    api: server.api,
    onDirtyChange: () => {},
    onChanged: () => {}
  });
  return {
    window,
    document,
    container,
    controller,
    click,
    $: (selector) => container.querySelector(selector)
  };
}

test("the editor shows the document it was given, not an empty box", async (t) => {
  // The bug this pins: content already saved on the server never reached the
  // textarea, so reopening a document looked like the work had been lost.
  const server = resourceServer({ content: "# 已经写好的内容\n不能丢\n" });
  const editor = await mountEditor(t, server);
  assert.equal(editor.$("[data-editor-input]").value, "# 已经写好的内容\n不能丢\n");
  assert.match(editor.$("[data-editor-status]").textContent, /已自动保存/);
  assert.equal(editor.$("[data-editor-revision]").textContent, "r0");
  assert.match(editor.$("[data-editor-title]").textContent, /方案\.md/);
});

test("typing then saving sends one minimal edit and never a wipe", async (t) => {
  const server = resourceServer({ content: "目标用户是谁\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "目标用户是产品经理\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  editor.click(editor.$("[data-editor-save]"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(server.calls.length, 1, "one debounced transaction, not one per keystroke");
  assert.deepEqual(server.calls[0].payload, { from: 5, to: 6, text: "产品经理" });
  assert.equal(server.state.content, "目标用户是产品经理\n");
  // The document is never emptied by a save.
  assert.notEqual(server.calls[0].payload.text, "");
});

test("an editor mounted twice on saved content does not delete it", async (t) => {
  // This is the exact sequence that lost the user's work: mount, let the load
  // land, then let a save fire without any typing having happened.
  const server = resourceServer({ content: "用户写过的内容\n" });
  const editor = await mountEditor(t, server);
  await new Promise((resolve) => setTimeout(resolve, 10));
  editor.click(editor.$("[data-editor-save]"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(server.calls, [], "nothing changed, so nothing is sent");
  assert.equal(server.state.content, "用户写过的内容\n");
  assert.match(editor.$("[data-editor-status]").textContent, /已是最新|已自动保存/);
});

test("Ctrl+S saves the document instead of letting the browser save the page", async (t) => {
  const server = resourceServer({ content: "原内容\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "改过的内容\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));

  let defaultPrevented = false;
  const event = new editor.window.Event("keydown", { bubbles: true, cancelable: true });
  event.key = "s";
  event.metaKey = true;
  event.preventDefault = () => {
    defaultPrevented = true;
  };
  input.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(defaultPrevented, true, "unclaimed, the browser offers to save the web page");
  assert.equal(server.state.content, "改过的内容\n");
});

test("history is hidden until asked for", async (t) => {
  const server = resourceServer();
  const editor = await mountEditor(t, server);
  const pane = editor.$("[data-editor-history-pane]");
  const toggle = editor.$("[data-editor-history-toggle]");
  assert.equal(pane.hidden, true, "an editor is a document, not a dashboard");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  editor.click(toggle);
  assert.equal(pane.hidden, false);
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  editor.click(toggle);
  assert.equal(pane.hidden, true);
});

test("the open menu lists other documents and can reach them", async (t) => {
  const server = resourceServer();
  const editor = await mountEditor(t, server);
  editor.click(editor.$("[data-editor-open]"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sheet = editor.$("[data-editor-open-sheet]");
  assert.equal(sheet.hidden, false);
  assert.match(sheet.innerHTML, /另一份\.md/);
  // The document already open is not offered again.
  assert.equal(sheet.querySelector('[data-open="res_1"]'), null);
  assert.equal(sheet.querySelector('[data-open="res_cad"]'), null, "only text formats appear here");
  assert.ok(sheet.querySelector("[data-open-new]"), "an editor can also start a new document");
  editor.click(sheet.querySelector('[data-open="res_2"]'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(server.calls.includes("open:res_2"), "the adapter asks the host to switch, never does it itself");
});

test("renaming updates the title and the path shown, without a revision", async (t) => {
  const server = resourceServer();
  const editor = await mountEditor(t, server);
  editor.click(editor.$("[data-editor-rename]"));
  editor.$("[data-document-name]").value = "产品方案.md";
  editor
    .$(".editor-name-form")
    .dispatchEvent(new editor.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(server.state.title, "产品方案.md");
  assert.match(editor.$("[data-editor-title]").textContent, /产品方案\.md/);
  assert.match(editor.$("[data-editor-path]").textContent, /产品方案\.md/);
  assert.equal(editor.$("[data-editor-revision]").textContent, "r0", "a rename is not an edit");
});

test("a conflict keeps the draft and offers a way out", async (t) => {
  const server = resourceServer({ content: "共享内容\n" });
  const editor = await mountEditor(t, server);
  // Someone else advanced the resource while this editor held revision 0.
  server.state.revision = 5;
  const input = editor.$("[data-editor-input]");
  input.value = "我的草稿\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  editor.click(editor.$("[data-editor-save]"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const conflict = editor.$("[data-editor-conflict]");
  assert.equal(conflict.hidden, false, "a conflict must be visible, not silent");
  assert.match(conflict.innerHTML, /没有被覆盖/);
  for (const action of ["reload", "copy", "keep"]) {
    assert.ok(conflict.querySelector(`[data-conflict="${action}"]`), `the user needs a "${action}" choice`);
  }
  // The draft is still on screen: it is the user's only copy.
  assert.equal(input.value, "我的草稿\n");
});

test("undo with unsaved typing keeps the draft instead of destroying it", async (t) => {
  // The guard was `!dirty() || !conflict`. With `conflict` null in the ordinary
  // case, `!conflict` was always true, so undo overwrote the textarea whenever
  // the user had unsent typing — losing it with no conflict banner.
  const server = resourceServer({ content: "原文\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "原文\n还没保存的段落\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));

  editor.click(editor.$("[data-editor-undo]"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(input.value, "原文\n还没保存的段落\n", "the user's unsent typing must survive an undo");
});

test("a caret move does not refetch the document or collapse the selection", async (t) => {
  // `resource.selection_changed` carries no revision, so the staleness guard
  // never fired and the editor reloaded on every caret move — wiping the
  // selection the user had just made.
  const server = resourceServer({ content: "一段可以选中的文字\n" });
  const editor = await mountEditor(t, server);
  const before = server.calls.length;
  editor.controller.handleResourceEvent({ type: "resource.selection_changed", resourceId: "res_1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.calls.length, before, "a selection is not a revision and must not trigger a reload");

  // A real content change still reaches the editor.
  server.state.content = "CoworkOS 改过的内容\n";
  server.state.revision = 5;
  editor.controller.handleResourceEvent({
    type: "resource.operation_applied",
    resourceId: "res_1",
    revision: 5
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    editor.$("[data-editor-input]").value,
    "CoworkOS 改过的内容\n",
    "an Agent edit must still appear"
  );
});

test("a failing save does not turn the download button into a request loop", async (t) => {
  const server = resourceServer({ content: "内容\n" });
  let attempts = 0;
  const failing = {
    ...server.api,
    async applyOperation() {
      attempts += 1;
      throw new Error("服务不可用");
    }
  };
  const { window, document, restore } = browser();
  t.after(restore);
  const { textEditorAdapter } = await import("../web/assets/workbench/adapters/text-editor.js");
  const box = document.createElement("div");
  document.body.appendChild(box);
  await textEditorAdapter.mount(box, {
    instance: { appInstanceId: "app_1", title: "a.md", resourceIds: ["res_1"] },
    taskId: "task-1",
    api: failing,
    onDirtyChange: () => {},
    onChanged: () => {}
  });
  const input = box.querySelector("[data-editor-input]");
  input.value = "改过但存不上\n";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));

  box.querySelector("[data-editor-download]").dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Re-dispatching on a failed save re-entered with identical state; on a 500
  // that was unbounded. One attempt per click, and the user is told why.
  assert.ok(attempts <= 2, `a failed save must not retry unboundedly, got ${attempts} attempts`);
  assert.match(box.querySelector("[data-editor-status]").textContent, /保存|下载/);
});

test("a transient catalog failure is not cached as an empty platform", async (t) => {
  const { $, restore } = browser();
  t.after(restore);
  const navButton = $("#apps-nav");
  navButton.hidden = false;
  let attempt = 0;
  const panel = createAppsPanel({
    navButton,
    panel: $("#apps-panel"),
    api: {
      listApplications: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("dashboard still booting");
        return {
          applications: [
            {
              appType: "text-editor",
              displayName: "文本编辑器",
              resourceKinds: ["text/markdown"],
              capabilities: ["edit"]
            }
          ]
        };
      },
      listResources: async () => ({ resources: [] })
    },
    getTaskId: () => undefined,
    getOpenResourceIds: () => []
  });
  t.after(() => panel.close());

  await panel.toggle();
  assert.equal(attempt, 1);
  panel.close();
  // `??=` treated the caught `[]` as a successful answer, so the panel claimed
  // the platform had no applications at all until the page was reloaded.
  await panel.toggle();
  assert.match($("#apps-panel").innerHTML, /文本编辑器/, "a retry must be able to recover the catalog");
});

test("a draft holds the front against a poll, but not against the person opening something", async (t) => {
  // The bug this pins, reported three times as 「新建后没打开」 and finally
  // pinned down by the one condition I had not reproduced: it only happens from
  // the 新对话 draft state. A draft tab exists only in the browser, so the
  // server can never report it as active — which is why `update` was written to
  // leave it in front. That is right for the 3.5s poll and wrong for a
  // deliberate act: opening the editor from a draft and creating a document
  // showed nothing at all. The document was made, its tab was in the strip, and
  // the draft sat in front of both.
  const { host: workbench, log, $ } = host(t);

  workbench.openDraftConversation();
  assert.equal(workbench.activeTabId, DRAFT_TAB_ID, "新对话 puts the draft in front");

  // The person opens an editor. `follow` says this update is their choice.
  const empty = emptyTab("workspace", "app_1");
  await workbench.update({ tabs: [empty], activeTabId: "window:app_1", follow: true });
  assert.equal(workbench.activeTabId, "window:app_1", "the editor they asked for comes to the front");

  // They create a document into it: the tab is rekeyed and stays in front.
  const doc = appTab(undefined, "app_1", "草稿里建的.md", "res_1");
  await workbench.update({ tabs: [doc], activeTabId: "resource:res_1", follow: true });
  assert.equal(workbench.activeTabId, "resource:res_1", "and so does the document");
  assert.deepEqual(
    log.filter((entry) => entry.startsWith("mount")),
    ["mount:app_1", "mount:res_1"],
    "the empty state gives way to the editing state"
  );

  // Back to the draft, and now a poll arrives. It must not move them.
  workbench.openDraftConversation();
  await workbench.update({ tabs: [doc], activeTabId: "resource:res_1" });
  assert.equal(workbench.activeTabId, DRAFT_TAB_ID, "a poll never takes the composer away");
  assert.ok(
    $("[data-tab-strip]").innerHTML.includes("草稿里建的.md"),
    "though the document is still in the strip"
  );
});

test("clearing a document saves an empty revision instead of restoring deleted text", async (t) => {
  const server = resourceServer({ content: "用户准备清空的文字\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  editor.click(editor.$("[data-editor-save]"));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(server.state.content, "");
  assert.equal(server.state.revision, 1);
  assert.equal(input.value, "");
  assert.match(editor.$("[data-editor-status]").textContent, /已自动保存/);
  await editor.controller.unmount();
});

test("undo adopts the result when there is no local draft and never saves it back", async (t) => {
  const server = resourceServer({ content: "已保存的新内容\n" });
  const undo = server.api.undo;
  server.api.undo = async (...args) => {
    server.state.content = "撤销后原文\n";
    return undo(...args);
  };
  const editor = await mountEditor(t, server);
  editor.click(editor.$("[data-editor-undo]"));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(editor.$("[data-editor-input]").value, "撤销后原文\n");
  assert.match(editor.$("[data-editor-status]").textContent, /已自动保存/);
  editor.click(editor.$("[data-editor-save]"));
  await editor.controller.unmount();
  assert.equal(server.calls.length, 0, "undo is not a new local edit");
});

test("a remote update pauses autosave and preserves a local draft", async (t) => {
  const server = resourceServer({ content: "共享原文\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "我的本地草稿\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  server.state.content = "另一位协作者的修改\n";
  server.state.revision = 1;
  editor.controller.handleResourceEvent({
    type: "resource.operation_applied",
    resourceId: "res_1",
    revision: 1
  });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(input.value, "我的本地草稿\n");
  assert.equal(editor.$("[data-editor-conflict]").hidden, false);
  editor.click(editor.$("[data-editor-save]"));
  await editor.controller.unmount();
  assert.equal(server.state.content, "另一位协作者的修改\n");
  assert.equal(server.calls.length, 0, "the draft must not overwrite the newer revision");
});

test("closing during a save flushes typing that arrived while the request was pending", async (t) => {
  const server = resourceServer({ content: "原文\n" });
  const apply = server.api.applyOperation;
  let release;
  let first = true;
  server.api.applyOperation = async (...args) => {
    if (first) {
      first = false;
      await new Promise((done) => {
        release = done;
      });
    }
    return apply(...args);
  };
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "第一段\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  editor.click(editor.$("[data-editor-save]"));
  input.value = "第一段\n请求过程中新增的内容\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  const closing = editor.controller.unmount();
  release();
  await closing;
  assert.equal(server.state.content, "第一段\n请求过程中新增的内容\n");
  assert.equal(server.state.revision, 2);
});

test("naming validates blanks, supports cancellation, and retains failures without prompt", async (t) => {
  const server = resourceServer();
  server.api.renameResource = async () => {
    throw new Error("名称已被占用");
  };
  const editor = await mountEditor(t, server);
  editor.window.prompt = () => {
    throw new Error("prompt() is not supported");
  };
  editor.click(editor.$("[data-editor-rename]"));
  const form = editor.$(".editor-name-form");
  const field = editor.$("[data-document-name]");
  const submit = () =>
    form.dispatchEvent(new editor.window.Event("submit", { bubbles: true, cancelable: true }));
  field.value = "  ";
  submit();
  assert.match(editor.$("[data-name-error]").textContent, /不能为空/);
  field.value = "新的名称.txt";
  submit();
  await new Promise((done) => setTimeout(done, 20));
  assert.match(editor.$("[data-name-error]").textContent, /已被占用/);
  assert.equal(field.value, "新的名称.txt");
  assert.equal(editor.$("[data-name-submit]").disabled, false);
  editor.click(editor.$("[data-name-cancel]"));
  assert.equal(editor.$("[data-name-dialog]"), null);
  assert.equal(server.state.title, "方案.md");
  await editor.controller.unmount();
});

test("an editor with an unresolved conflict cannot close and can save an explicit merge", async (t) => {
  const server = resourceServer({ content: "原文\n" });
  const editor = await mountEditor(t, server);
  const input = editor.$("[data-editor-input]");
  input.value = "本地草稿\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  server.state.content = "远端新增\n";
  server.state.revision = 1;
  editor.controller.handleResourceEvent({
    type: "resource.operation_applied",
    resourceId: "res_1",
    revision: 1
  });
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(await editor.controller.canClose(), false);
  editor.click(editor.$('[data-conflict="keep"]'));
  assert.equal(editor.$("[data-editor-conflict]").hidden, false, "merge controls remain reachable");
  input.value = "远端新增\n本地草稿\n";
  input.dispatchEvent(new editor.window.Event("input", { bubbles: true }));
  editor.click(editor.$('[data-conflict="merge"]'));
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(server.state.content, "远端新增\n本地草稿\n");
  assert.equal(await editor.controller.canClose(), true);
  await editor.controller.unmount();
});

test("closing a tab is refused when its editor cannot save the draft", async (t) => {
  const {
    $,
    host: workbench,
    log
  } = host(t, {
    registry: {
      "text-editor": {
        async mount(element) {
          element.innerHTML = "<textarea>仅存的草稿</textarea>";
          return { canClose: async () => false, unmount: async () => log.push("lost") };
        }
      }
    }
  });
  await workbench.update({
    tabs: [appTab("task-a", "app_1", "笔记.txt", "res_1")],
    activeTabId: "resource:res_1"
  });
  await workbench.close("resource:res_1");
  assert.equal(workbench.activeTabId, "resource:res_1");
  assert.ok($("[data-app-mount] textarea"));
  assert.equal(log.includes("lost"), false);
  assert.equal(
    log.some((entry) => entry.startsWith("close:")),
    false
  );
});

test("wide workspace keeps the conversation beside its document and preserves drafts across view modes", async (t) => {
  const view = browser();
  t.after(view.restore);
  view.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  let mounts = 0;
  const workbench = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: {
      "text-editor": {
        async mount(element) {
          mounts++;
          element.innerHTML = "<textarea>unsaved</textarea>";
          return {};
        }
      }
    },
    api: { activateTab: async () => {} }
  });
  t.after(() => workbench.destroy());
  const tabs = [chatTab("task-1", "conversation"), appTab("task-1", "app_1", "draft.txt", "res_1")];
  await workbench.update({
    tabs,
    actingTaskId: "task-1",
    boundResourceId: "res_1",
    activeTabId: "conversation:task-1"
  });
  assert.equal(view.$("#conversation-pane").hidden, false);
  assert.equal(view.$(".chat-pane").classList.contains("is-collaborating"), true);
  assert.equal(view.$("[data-tab-strip]").hidden, true, "desktop workspace has no extra tab strip");
  const input = view.$("[data-app-mount] textarea");
  workbench.setExpanded(true);
  assert.equal(view.$("#conversation-pane").hidden, true);
  workbench.setExpanded(false);
  assert.equal(view.$("#conversation-pane").hidden, false);
  await workbench.collapseApplication();
  assert.equal(view.$(".chat-pane").classList.contains("is-collaborating"), false);
  await workbench.update({
    tabs,
    actingTaskId: "task-1",
    boundResourceId: "res_1",
    activeTabId: "conversation:task-1"
  });
  assert.equal(
    view.$(".chat-pane").classList.contains("is-collaborating"),
    false,
    "poll does not reopen collapsed pane"
  );
  await workbench.activate("resource:res_1");
  assert.equal(view.$("[data-app-mount] textarea"), input);
  assert.equal(mounts, 1);
  workbench.openDraftConversation();
  assert.equal(
    view.$(".chat-pane").classList.contains("is-collaborating"),
    false,
    "new chat does not borrow a previous file"
  );
});

test("standalone files and empty windows do not select the internal workspace as a conversation", async (t) => {
  const view = browser();
  t.after(view.restore);
  view.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const selected = [];
  const workbench = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: { "text-editor": stubAdapter() },
    api: { activateTab: async () => {}, isStandaloneTask: (id) => id === "workspace" },
    onConversationTask: (id) => selected.push(id)
  });
  t.after(() => workbench.destroy());
  const tabs = [appTab(undefined, "app_1", "standalone.txt", "res_1"), emptyTab("workspace", "app_2")];
  for (const tab of tabs) {
    await workbench.update({ tabs, activeTabId: tab.tabId });
    await workbench.activate(tab.tabId);
    assert.equal(view.$(".chat-pane").classList.contains("is-collaborating"), false);
    assert.equal(view.$("#conversation-pane").hidden, true);
  }
  assert.deepEqual(selected, []);
});

test("binding waits for the selection, blocks duplicate requests and reports rejected changes", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let reject,
    started = 0;
  const errors = [];
  const pendingChanges = [];
  const selection = new Promise((resolve, fail) => {
    reject = fail;
  });
  const button = $("#app-bind-select");
  const binding = createBindingControl({
    button,
    menu: $("#app-bind-menu"),
    label: button.querySelector(".app-bind-name"),
    api: {},
    getTaskId: () => "task-1",
    onSelect: async () => {
      started++;
      await selection;
    },
    onError: (message) => errors.push(message),
    onPendingChange: (pending) => pendingChanges.push(pending)
  });
  binding.update({ instances: [instance("app_1", "A.md", "res_1")], boundResourceId: undefined });
  binding.open();
  const row = $("#app-bind-menu [data-bind-instance='app_1']");
  click(row);
  click(row);
  assert.equal(started, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.querySelector(".app-bind-name").textContent, "正在切换…");
  reject(new Error("绑定被拒绝"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains("is-bound"), false);
  assert.deepEqual(errors, ["切换加载失败：绑定被拒绝"]);
  assert.deepEqual(pendingChanges, [true, false]);
});

test("unbinding keeps the original task and ignores a late navigation response", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let selected = "task-a",
    finish;
  const calls = [];
  const request = new Promise((resolve) => {
    finish = resolve;
  });
  const button = $("#app-bind-select");
  const binding = createBindingControl({
    button,
    menu: $("#app-bind-menu"),
    label: button.querySelector(".app-bind-name"),
    getTaskId: () => selected,
    api: {
      unbind: async (taskId) => {
        calls.push(taskId);
        await request;
      }
    },
    onSelect: () => calls.push("navigate")
  });
  binding.update({ instances: [instance("app_1", "A.md", "res_1")], boundResourceId: "res_1" });
  binding.open();
  click($("#app-bind-menu [data-bind-instance='__unbound__']"));
  selected = "task-b";
  binding.update({ instances: [instance("app_2", "B.md", "res_2")], boundResourceId: "res_2" });
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["task-a"]);
  assert.equal(button.querySelector(".app-bind-name").textContent, "B.md");
});

test("a pending conversation switch cannot be undone by an old app's owner during tab refresh", async (t) => {
  const selected = [];
  const { host: workbench, log } = host(t, { onConversationTask: (id) => selected.push(id) });
  const tabs = [chatTab("task-a", "A"), appTab("task-a", "app_1", "A.md", "res_1")];
  await workbench.update({ tabs, activeTabId: "resource:res_1", actingTaskId: "task-a" });
  selected.length = 0;
  const navigation = workbench.beginNavigation();
  await workbench.showConversation({ navigation, persist: false });
  await workbench.update({ tabs, activeTabId: "resource:res_1", actingTaskId: "task-b" });
  assert.deepEqual(selected, []);
  assert.equal(workbench.activeTabId, undefined);
  assert.equal(log.includes("unmount:res_1"), false);
  assert.equal(
    log.includes("activate:null"),
    false,
    "the pending view must not race the intended server activation"
  );
  await workbench.update({
    tabs: [...tabs, chatTab("task-b", "B")],
    activeTabId: "conversation:task-b",
    actingTaskId: "task-b"
  });
  await workbench.activate("conversation:task-b", { navigation });
  assert.equal(workbench.activeTabId, "conversation:task-b");
  assert.deepEqual(selected, ["task-b"]);
  await workbench.activate("resource:res_1");
  assert.equal(log.filter((entry) => entry === "mount:res_1").length, 1);
});

test("binding refresh shows the current snapshot immediately without reopening a dismissed menu or crossing navigation", async (t) => {
  const { $, restore } = browser();
  t.after(restore);
  let finish;
  let selected = "task-a";
  let fail = false;
  const errors = [];
  const button = $("#app-bind-select");
  const menu = $("#app-bind-menu");
  const binding = createBindingControl({
    button,
    menu,
    label: button.querySelector(".app-bind-name"),
    api: {},
    getTaskId: () => selected,
    onRefresh: () =>
      new Promise((resolve, reject) => {
        finish = () => (fail ? reject(new Error("offline")) : resolve());
      }),
    onError: (message) => errors.push(message)
  });
  const snapshot = { instances: [instance("app_1", "A.md", "res_1")] };
  binding.update(snapshot);
  let opening = binding.open();
  assert.equal(menu.querySelectorAll("[data-bind-instance]").length, 2);
  binding.update(snapshot);
  assert.equal(
    menu.querySelectorAll("[data-bind-instance]").length,
    2,
    "a pending refresh does not hide the current application snapshot"
  );
  binding.close();
  finish();
  await opening;
  assert.equal(menu.hidden, true);
  opening = binding.open();
  selected = "task-b";
  finish();
  await opening;
  assert.equal(menu.hidden, true);
  opening = binding.open();
  binding.update({ instances: [] });
  finish();
  await opening;
  assert.match(menu.textContent, /当前工作区没有打开的应用/);
  binding.close();
  fail = true;
  opening = binding.open();
  finish();
  await opening;
  assert.equal(menu.hidden, false, "a failed refresh keeps the current snapshot usable");
  assert.equal(menu.getAttribute("aria-busy"), "false");
  assert.deepEqual(errors, ["无法刷新打开的应用：offline"]);
  binding.close();
});

test("binding first load exposes an application action and invalidates the old draft snapshot", async (t) => {
  const { $, click, restore } = browser();
  t.after(restore);
  let context = {};
  let finish;
  let opened = 0;
  const button = $("#app-bind-select");
  const menu = $("#app-bind-menu");
  const binding = createBindingControl({
    button,
    menu,
    label: button.querySelector(".app-bind-name"),
    api: {},
    getTaskId: () => undefined,
    getContext: () => context,
    onRefresh: () => new Promise((resolve) => (finish = resolve)),
    onOpenApplications: () => opened++
  });
  let opening = binding.open();
  assert.match(menu.textContent, /加载中/);
  assert.equal(menu.getAttribute("aria-busy"), "true");
  binding.update({ instances: [] });
  finish();
  await opening;
  click(menu.querySelector("[data-bind-open-apps]"));
  assert.equal(opened, 1);
  assert.equal(menu.hidden, true);

  binding.update({ instances: [instance("app_1", "A.md", "res_1")] });
  opening = binding.open();
  assert.equal(menu.querySelectorAll("[data-bind-instance]").length, 2);
  context = {};
  binding.update({ instances: [] });
  assert.equal(menu.hidden, true, "a different draft closes the old menu even without a task ID");
  finish();
  await opening;
  assert.equal(menu.hidden, true);
});

test("a poll cannot restore an application while its close request is pending", async (t) => {
  let finish;
  const closing = new Promise((resolve) => {
    finish = resolve;
  });
  const { host: workbench } = host(t, { api: { closeTab: () => closing } });
  const tabs = [chatTab("task-a", "A"), appTab("task-a", "app_1", "A.md", "res_1")];
  await workbench.update({ tabs, activeTabId: "conversation:task-a", actingTaskId: "task-a" });
  const closed = workbench.close("resource:res_1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await workbench.update({ tabs, activeTabId: "conversation:task-a", actingTaskId: "task-a" });
  assert.equal(
    workbench.openTabs.some((tab) => tab.resourceId === "res_1"),
    false
  );
  finish();
  await closed;
});

test("learning a new document reference in a poll cannot navigate to that conversation", async (t) => {
  const view = browser();
  t.after(view.restore);
  const selected = [];
  const workbench = createWorkbenchHost({
    root: view.$("#workbench"),
    conversationElement: view.$("#conversation-pane"),
    registry: { "text-editor": stubAdapter() },
    api: { activateTab: async () => {}, isStandaloneTask: (id) => id === "workspace" },
    onConversationTask: (id) => selected.push(id)
  });
  t.after(() => workbench.destroy());
  const loose = appTab(undefined, "app_1", "independent.md", "res_1");
  await workbench.update({ tabs: [loose], activeTabId: loose.tabId });
  await workbench.activate(loose.tabId);
  const associated = appTab("target", "app_1", "independent.md", "res_1");
  await workbench.update({ tabs: [associated], activeTabId: associated.tabId });
  assert.deepEqual(selected, [], "a delayed association response must not take over navigation");
  await workbench.activate(associated.tabId);
  assert.deepEqual(selected, [], "opening an application never selects a conversation");
});

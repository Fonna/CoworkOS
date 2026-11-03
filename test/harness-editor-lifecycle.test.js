import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createWorkbenchHost } from "../web/assets/workbench/host.js";
import {
  cadHarnessEditorAdapter,
  officeHarnessEditorAdapter
} from "../web/assets/workbench/adapters/harness-editor.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, appType = "cad-harness", { delayedStart = false } = {}) {
  const { window, document } = parseHTML(
    '<html><body><main><section id="conversation"></section><section id="workbench"><div data-tab-strip></div></section></main></body></html>'
  );
  const previous = Object.fromEntries(
    ["window", "document", "CSS", "ResizeObserver"].map((key) => [key, globalThis[key]])
  );
  const observers = new Set();
  Object.assign(globalThis, {
    window,
    document,
    CSS: { escape: (value) => value },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.add(this);
      }
      observe(element) {
        this.element = element;
      }
      disconnect() {
        observers.delete(this);
      }
    }
  });
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 100, y: 80, width: this.hidden ? 0 : 640, height: this.hidden ? 0 : 720 };
  };
  const calls = [];
  const listeners = new Set();
  const pending = [];
  let attached = false;
  let workspace;
  const native = {
    start: (...args) => {
      calls.push({ type: "start", args });
      if (appType === "cad-harness") workspace = args[0];
      if (delayedStart) return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({ status: "running" });
    },
    status: async () => ({ status: "running" }),
    attach: async (bounds) => {
      calls.push({ type: "attach", owner: bounds.owner });
      attached = true;
    },
    detach: async (owner) => {
      calls.push({ type: "detach", owner });
      attached = false;
    },
    onStatusChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  window.bookmanDesktop = { cadViewer: native, officeHarness: native };
  const host = createWorkbenchHost({
    root: document.querySelector("#workbench"),
    conversationElement: document.querySelector("#conversation"),
    registry: {
      "cad-harness": cadHarnessEditorAdapter,
      "office-harness": officeHarnessEditorAdapter
    },
    api: { activateTab: async () => {}, closeTab: async () => {} },
    onError: (message) => assert.fail(message)
  });
  const tabs = ["a", "b"].map((id) => ({
    tabId: `resource:${id}`,
    resourceId: id,
    kind: "application",
    appType,
    title: id,
    workspaceRoot: "/documents/project",
    conversations: [{ taskId: `task-${id}`, storageRoot: `/task-storage/${id}` }]
  }));
  t.after(async () => {
    await host.destroy();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    host,
    tabs,
    calls,
    pending,
    get attached() {
      return attached;
    },
    get workspace() {
      return workspace;
    },
    async resize() {
      for (const observer of observers) observer.callback([{ target: observer.element }]);
      window.dispatchEvent(new window.Event("resize"));
      await settle();
    },
    status(info) {
      for (const listener of listeners) listener(info);
    }
  };
}

for (const appType of ["cad-harness", "office-harness"]) {
  test(`${appType}: hidden tabs and closing them cannot detach the displayed native view`, async (t) => {
    const view = fixture(t, appType);
    await view.host.update({ tabs: view.tabs, activeTabId: null });
    await view.host.activate("resource:a");
    await settle();
    await view.resize();
    await view.host.activate("resource:b");
    await settle();
    await view.resize();
    await view.host.activate("resource:a");
    await settle();
    await view.resize();
    assert.equal(view.attached, true);
    const owner = view.calls.findLast((call) => call.type === "attach").owner;
    assert.equal(typeof owner, "string");
    await view.host.close("resource:b");
    view.status({ status: "running" });
    await view.resize();
    assert.equal(view.attached, true);
    assert.equal(view.calls.findLast((call) => call.type === "attach").owner, owner);
    await view.host.showConversation();
    await view.resize();
    assert.equal(view.attached, false);
  });
}

test("CAD activation restores the owning task storage directory on every tab return", async (t) => {
  const view = fixture(t);
  await view.host.update({ tabs: view.tabs, activeTabId: null });
  for (const id of ["a", "b", "a"]) {
    await view.host.activate(`resource:${id}`);
    await settle();
    assert.equal(view.workspace, `/task-storage/${id}/task-${id}`);
  }
  const starts = view.calls.filter((call) => call.type === "start");
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map((call) => call.args[1])).size, 3);
});

test("a late native startup cannot attach after switching or closing its tab", async (t) => {
  const view = fixture(t, "cad-harness", { delayedStart: true });
  await view.host.update({ tabs: view.tabs, activeTabId: null });
  await view.host.activate("resource:a");
  await view.host.activate("resource:b");
  view.pending[1]({ status: "running" });
  await settle();
  await view.resize();
  const currentOwner = view.calls.findLast((call) => call.type === "attach").owner;
  await view.host.close("resource:a");
  const before = view.calls.length;
  view.pending[0]({ status: "running" });
  await settle();
  assert.equal(view.calls.length, before);
  assert.equal(view.attached, true);
  assert.equal(view.calls.findLast((call) => call.type === "attach").owner, currentOwner);
});

test("a shared CAD resource follows the selected conversation's storage root", async (t) => {
  const view = fixture(t);
  const tab = {
    ...view.tabs[0],
    conversations: [...view.tabs[0].conversations, ...view.tabs[1].conversations]
  };
  await view.host.update({ tabs: [tab], activeTabId: tab.tabId, actingTaskId: "task-a" });
  await settle();
  assert.equal(view.workspace, "/task-storage/a/task-a");
  await view.host.update({ tabs: [tab], activeTabId: tab.tabId, actingTaskId: "task-b" });
  await settle();
  assert.equal(view.workspace, "/task-storage/b/task-b");
  assert.equal(view.attached, true);
});

test("a previous activation's late failure cannot hide the same tab's new native lease", async (t) => {
  const view = fixture(t, "cad-harness", { delayedStart: true });
  await view.host.update({ tabs: view.tabs, activeTabId: null });
  await view.host.activate("resource:a");
  await view.host.showConversation();
  await view.host.activate("resource:a");
  view.pending[1]({ status: "running" });
  await settle();
  assert.equal(view.attached, true);
  const before = view.calls.length;
  view.pending[0]({ status: "error", error: "obsolete startup" });
  await settle();
  assert.equal(view.calls.length, before);
  assert.equal(view.attached, true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { pptistEditorAdapter } from "../web/assets/workbench/adapters/pptist-editor.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("failed presentation reads leave no observers; a later mount observes and cleans up normally", async (t) => {
  const { window, document } = parseHTML('<html><body><main id="editor"></main></body></html>');
  const keys = ["window", "document", "fetch", "MutationObserver", "location"];
  const previous = new Map(keys.map((key) => [key, globalThis[key]]));
  const active = new Set();
  let notifications = 0;
  const PageMutationObserver = window.MutationObserver;
  class TrackedMutationObserver extends PageMutationObserver {
    constructor(callback) {
      super((...args) => {
        notifications++;
        callback(...args);
      });
    }
    observe(...args) {
      active.add(this);
      return super.observe(...args);
    }
    disconnect() {
      active.delete(this);
      return super.disconnect();
    }
  }
  Object.assign(globalThis, {
    window,
    document,
    location: { origin: "http://localhost" },
    MutationObserver: TrackedMutationObserver,
    fetch: async () => ({ ok: true, json: async () => ({ components: [{ id: "pptist", available: true }] }) })
  });
  let controller;
  t.after(async () => {
    await controller?.unmount();
    for (const observer of active) observer.disconnect();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const host = document.querySelector("#editor");
  const options = {
    taskId: "task",
    instance: { appInstanceId: "presentation", resourceIds: ["deck"] },
    api: {
      readResource: async () => {
        throw new Error("read offline");
      }
    }
  };
  await assert.rejects(pptistEditorAdapter.mount(host, options), /read offline/);
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.desktopFullscreen = "true";
  await settle();
  assert.equal(active.size, 0);
  assert.equal(notifications, 0, "failed mounts must not respond to later page mutations");

  options.api.readResource = async () => ({
    resource: { resourceId: "deck", title: "Recovered presentation", revision: 0 },
    snapshot: { content: { version: 1, slides: [{ id: "one", elements: [] }] } }
  });
  controller = await pptistEditorAdapter.mount(host, options);
  assert.equal(host.querySelector("[data-pptist-rename]").textContent, "Recovered presentation");
  assert.ok(active.size > 0);
  document.documentElement.dataset.theme = "light";
  await settle();
  assert.ok(notifications > 0, "a successfully mounted editor follows page appearance");
  await controller.unmount();
  controller = undefined;
  const afterUnmount = notifications;
  document.documentElement.dataset.theme = "dark";
  document.documentElement.dataset.desktopFullscreen = "false";
  await settle();
  assert.equal(active.size, 0);
  assert.equal(notifications, afterUnmount);
  assert.equal(host.childElementCount, 0);
});

test("presentation host controls retire only for a ready capable editor and reject foreign commands", async (t) => {
  const { window, document } = parseHTML('<html><body><main id="editor"></main></body></html>');
  const keys = ["window", "document", "fetch", "MutationObserver", "location"];
  const previous = new Map(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    window,
    document,
    location: { origin: "http://localhost" },
    MutationObserver: window.MutationObserver,
    fetch: async () => ({ ok: true, json: async () => ({ components: [{ id: "pptist", available: true }] }) })
  });
  let controller;
  t.after(async () => {
    await controller?.unmount();
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const host = document.querySelector("#editor");
  controller = await pptistEditorAdapter.mount(host, {
    taskId: "task",
    instance: { appInstanceId: "presentation", resourceIds: ["deck"] },
    api: {
      readResource: async () => ({
        resource: { resourceId: "deck", title: "A single command row", revision: 0 },
        snapshot: { content: { version: 1, slides: [{ id: "one", elements: [] }] } }
      })
    }
  });
  const frame = host.querySelector("iframe"),
    toolbar = host.querySelector(".pptist-toolbar"),
    messages = [];
  const editor = { postMessage: (message) => messages.push(message) };
  Object.defineProperty(frame, "contentWindow", { value: editor });
  const channel = new URLSearchParams(frame.src.split("#")[1]).get("channel");
  const receive = (type, payload = {}, overrides = {}) => {
    const event = new window.Event("message");
    Object.assign(event, {
      source: editor,
      origin: "http://localhost",
      data: { protocol: "atria-pptist-v1", channel, type, ...payload },
      ...overrides
    });
    window.dispatchEvent(event);
  };
  assert.equal(toolbar.hidden, false, "fallback controls are available before the editor loads");
  receive("ready", { capabilities: ["host-commands-v1"] }, { origin: "http://foreign.test" });
  receive("loaded");
  assert.equal(toolbar.hidden, false, "foreign capabilities cannot hide the fallback");
  receive("ready");
  receive("loaded");
  assert.equal(toolbar.hidden, false, "older editor builds keep working with host controls");
  receive("ready", { capabilities: ["host-commands-v1"] });
  assert.equal(toolbar.hidden, false, "capability alone does not hide loading controls");
  receive("loaded");
  assert.equal(toolbar.hidden, true);
  assert.equal(host.querySelector(".pptist-status").hidden, true);
  assert.ok(
    messages.some(
      (message) =>
        message.type === "host-state" &&
        message.title === "A single command row" &&
        message.disabled === false
    )
  );
  receive("host-command", { command: "rename" }, { source: {} });
  receive("host-command", { command: "rename" }, { origin: "http://foreign.test" });
  receive(
    "host-command",
    { command: "rename" },
    { data: { protocol: "atria-pptist-v1", channel: "other", type: "host-command", command: "rename" } }
  );
  receive("host-command", { command: "__proto__" });
  assert.equal(host.querySelector('[role="dialog"]'), null);
  receive("host-command", { command: "rename" });
  assert.ok(host.querySelector('[role="dialog"]'), "the visible editor command opens the host rename dialog");
  receive("component-unavailable");
  assert.equal(toolbar.hidden, false, "component failure restores the fallback controls");
  assert.equal(host.querySelector(".pptist-status").hidden, false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { installComponentPreparation } from "../web/assets/controllers/component-preparation.js";
import { mountComponentManager } from "../web/assets/workbench/component-manager.js";

function fixture(t) {
  const { window, document } = parseHTML("<div class='sidebar-bottom'></div><main></main>");
  const previous = Object.fromEntries(
    ["window", "document", "CustomEvent"].map((key) => [key, globalThis[key]])
  );
  Object.assign(globalThis, { window, document, CustomEvent: window.CustomEvent });
  const cleanups = [];
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { window, document, cleanup: (fn) => cleanups.push(fn) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("preparation shows host-owned progress, opens the selected settings and notifies ready editors", async (t) => {
  const { window, document, cleanup } = fixture(t);
  const requests = [],
    opened = [],
    toasts = [];
  let state = { id: "blender", installing: true, enabled: true, available: false, progress: 25 };
  t.mock.method(globalThis, "fetch", async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => ({ components: [{ ...state }] }) };
  });
  let changes = 0;
  document.addEventListener("atria:components-changed", () => changes++);
  const status = installComponentPreparation({
    open: (id) => opened.push(id),
    showToast: (text) => toasts.push(text)
  });
  cleanup(() => status.dispose());
  await settle();
  const button = document.querySelector("[data-component-preparation]");
  assert.equal(button.hidden, false);
  assert.match(button.textContent, /Blender · 25%/);
  button.click();
  assert.deepEqual(opened, ["blender"]);
  assert.equal(toasts.length, 1);
  state.progress = 50;
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  assert.match(button.textContent, /50%/);
  assert.equal(toasts.length, 1);
  state = { ...state, installing: false, available: true, phase: "ready" };
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  assert.equal(button.hidden, true);
  assert.equal(changes, 1);
  assert.equal(toasts.at(-1), "应用组件已准备好");
  assert.equal(
    requests.every(({ path, options }) => path === "/api/components" && !options.method),
    true
  );
});

test("missing source runtimes stay quiet and failed or cancelled preparation offers settings without retrying", async (t) => {
  const { window, document, cleanup } = fixture(t);
  const opened = [],
    toasts = [],
    methods = [];
  let state = { id: "cadquery", phase: "missing", enabled: true, available: false, installing: false };
  t.mock.method(globalThis, "fetch", async (_path, options) => {
    methods.push(options.method || "GET");
    return { ok: true, json: async () => ({ components: [{ ...state }] }) };
  });
  const status = installComponentPreparation({
    open: (id) => opened.push(id),
    showToast: (text) => toasts.push(text)
  });
  cleanup(() => status.dispose());
  await settle();
  const button = document.querySelector("[data-component-preparation]");
  assert.equal(button.hidden, true);
  assert.deepEqual(toasts, []);
  state = { ...state, phase: "failed", message: "连接断开" };
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  assert.match(button.textContent, /安装失败 · 重试/);
  button.click();
  assert.deepEqual(opened, ["cadquery"]);
  state.phase = "cancelled";
  document.dispatchEvent(new window.Event("atria:components-changed"));
  await settle();
  assert.match(button.textContent, /准备已取消/);
  button.click();
  assert.deepEqual(opened, ["cadquery", "cadquery"]);
  assert.equal(
    methods.every((method) => method === "GET"),
    true
  );
});

test("disposing preparation ignores late status and removes polling listeners", async (t) => {
  const { window, document } = fixture(t);
  let answer,
    requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const toasts = [];
  const status = installComponentPreparation({ open() {}, showToast: (text) => toasts.push(text) });
  status.dispose();
  answer({ ok: true, json: async () => ({ components: [{ id: "blender", installing: true }] }) });
  await settle();
  window.dispatchEvent(new window.Event("focus"));
  document.dispatchEvent(new window.Event("atria:components-changed"));
  await settle();
  assert.equal(requests, 1);
  assert.deepEqual(toasts, []);
  assert.equal(document.querySelector("[data-component-preparation]"), null);
});

test("public component management exposes download actions without legacy credentials", async (t) => {
  const { document, cleanup } = fixture(t);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      components: [
        {
          id: "blender",
          enabled: true,
          available: false,
          supported: true,
          dependencies: [],
          phase: "missing",
          message: "等待安装"
        }
      ]
    })
  }));
  const host = document.querySelector("main");
  const manager = mountComponentManager(host);
  cleanup(() => manager.dispose());
  await settle();
  assert.equal(host.querySelector(".component-auth"), null);
  assert.equal(host.querySelector("[data-component-id='blender'] button").textContent, "安装 / 重试");
  manager.dispose();
  host.replaceChildren();
  const legacy = mountComponentManager(host, { allowAuth: true });
  cleanup(() => legacy.dispose());
  await settle();
  assert.ok(host.querySelector(".component-auth"));
});

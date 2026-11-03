import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { mountBlenderInstaller } from "../web/assets/blender/runtime-install.js";
import { openComponentSettings } from "../web/assets/workbench/component-entry.js";

function fixture(t) {
  const { window, document } = parseHTML("<div id='runtime'></div>");
  const cleanups = [];
  const previous = Object.fromEntries(
    ["window", "document", "CustomEvent"].map((key) => [key, globalThis[key]])
  );
  Object.assign(globalThis, { window, document, CustomEvent: window.CustomEvent });
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return { window, document, host: document.querySelector("#runtime"), cleanup: (fn) => cleanups.push(fn) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("component usage entries select the requested component in the shared settings", (t) => {
  const { document } = fixture(t);
  const opened = [];
  document.addEventListener("atria:component-settings", (event) => opened.push(event.detail.componentId));
  for (const id of ["cadquery", "blender", "pptist"]) openComponentSettings(id);
  assert.deepEqual(opened, ["cadquery", "blender", "pptist"]);
  const { document: parent } = parseHTML("<main></main>");
  parent.addEventListener("atria:component-settings", (event) => opened.push(event.detail.componentId));
  openComponentSettings("pptist", parent);
  assert.deepEqual(opened, ["cadquery", "blender", "pptist", "pptist"]);
});

test("Blender opens settings without installing and becomes ready after a component change", async (t) => {
  const { document, host, window, cleanup } = fixture(t);
  let state = { available: false, canInstall: false, message: "内置组件缺失" };
  const requests = [],
    opened = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => state };
  });
  document.addEventListener("atria:component-settings", (event) => opened.push(event.detail.componentId));
  let ready = 0;
  const runtime = mountBlenderInstaller(host, { onReady: () => ready++ });
  cleanup(() => runtime.dispose());
  await settle();
  const button = host.querySelector("button");
  assert.equal(button.hidden, false);
  button.click();
  assert.deepEqual(opened, ["blender"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/applications/blender/runtime");
  assert.equal(requests[0].options.method, undefined);
  state = { available: true, message: "Blender 可用" };
  document.dispatchEvent(new window.Event("atria:components-changed"));
  await settle();
  assert.equal(host.dataset.ready, "true");
  assert.equal(host.hidden, true);
  assert.equal(button.hidden, true);
  assert.equal(ready, 1);
  runtime.dispose();
  document.dispatchEvent(new window.Event("atria:components-changed"));
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  assert.equal(requests.length, 2);
});

test("Blender status failures can retry before opening component settings", async (t) => {
  const { document, host, cleanup } = fixture(t);
  let failed = true;
  const opened = [];
  t.mock.method(globalThis, "fetch", async () => {
    if (failed) throw new Error("本机服务暂不可用");
    return { ok: true, json: async () => ({ available: false, message: "Blender 待修复" }) };
  });
  document.addEventListener("atria:component-settings", (event) => opened.push(event.detail.componentId));
  const runtime = mountBlenderInstaller(host);
  cleanup(() => runtime.dispose());
  await settle();
  const button = host.querySelector("button");
  assert.equal(button.textContent, "重新检查");
  failed = false;
  button.click();
  await settle();
  assert.deepEqual(opened, []);
  assert.equal(button.textContent, "在设置中安装");
  button.click();
  assert.deepEqual(opened, ["blender"]);
});

test("a late Blender status response cannot hide a runtime that became ready", async (t) => {
  const { document, host, window, cleanup } = fixture(t);
  const pending = [];
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => pending.push(resolve)));
  const runtime = mountBlenderInstaller(host);
  cleanup(() => runtime.dispose());
  const answer = (index, available) =>
    pending[index]({ ok: true, json: async () => ({ available, message: available ? "可用" : "缺失" }) });
  answer(0, false);
  await settle();
  window.dispatchEvent(new window.Event("focus"));
  document.dispatchEvent(new window.Event("atria:components-changed"));
  answer(2, true);
  await settle();
  answer(1, false);
  await settle();
  assert.equal(host.dataset.ready, "true");
  assert.equal(host.querySelector("[data-install-status]").textContent, "可用");
  assert.equal(host.querySelector("button").hidden, true);
});

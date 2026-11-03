import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createHarnessEditorAdapter } from "../web/assets/workbench/adapters/harness-editor.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const apps = [
  { appType: "blender-harness", appName: "Blender Harness", software: "Blender", glyph: "blender" },
  { appType: "freecad-harness", appName: "FreeCAD Harness", software: "FreeCAD", glyph: "cad" }
];

async function fixture(t, app, desktop) {
  const { window, document } = parseHTML('<html><body><main id="editor"></main></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    bookmanDesktop: globalThis.bookmanDesktop
  };
  Object.assign(globalThis, { window, document });
  window.bookmanDesktop = desktop;
  const host = document.querySelector("#editor");
  const controller = await createHarnessEditorAdapter(app.appType, {
    appName: app.appName,
    appIcon: "i-file"
  }).mount(host);
  t.after(() => {
    controller.unmount();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    host,
    controller,
    button: host.querySelector("button"),
    status: host.querySelector('[role="status"]'),
    click(button = host.querySelector("button")) {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    }
  };
}

for (const app of apps) {
  for (const desktop of [undefined, {}]) {
    test(`${app.software} shows its desktop requirement without a launch bridge (${desktop ? "partial bridge" : "browser"})`, async (t) => {
      const view = await fixture(t, app, desktop);
      assert.equal(view.host.querySelector(".application-home").getAttribute("aria-label"), app.appName);
      assert.equal(view.host.querySelector("h2").textContent, app.appName);
      assert.equal(
        view.host.querySelector(".application-home-icon use").getAttribute("href"),
        `#i-${app.glyph}`
      );
      assert.match(view.status.textContent, /CoworkOS 桌面版/);
      assert.equal(view.button, null);
    });
  }

  test(`${app.software} opens only on request and disables duplicate launches`, async (t) => {
    let complete;
    const calls = [];
    const view = await fixture(t, app, {
      harnessLaunch(...args) {
        calls.push(args);
        return new Promise((resolve) => {
          complete = resolve;
        });
      }
    });
    assert.deepEqual(calls, []);
    assert.equal(view.button.textContent, `打开 ${app.software}`);
    assert.equal(view.button.disabled, false);
    assert.match(view.status.textContent, /桌面窗口中编辑/);
    view.click();
    view.click();
    assert.deepEqual(calls, [[app.appType]]);
    assert.equal(view.button.disabled, true);
    assert.equal(view.button.getAttribute("aria-busy"), "true");
    assert.match(view.status.textContent, /正在打开/);
    complete({ connected: true, launched: false });
    await settle();
    assert.equal(view.button.disabled, false);
    assert.equal(view.button.hasAttribute("aria-busy"), false);
    assert.equal(view.button.textContent, `打开 ${app.software}`);
    assert.equal(view.status.textContent, `已打开 ${app.software} 桌面窗口。`);
  });

  test(`${app.software} reports launch rejection and permits retry`, async (t) => {
    let attempts = 0;
    const view = await fixture(t, app, {
      async harnessLaunch() {
        if (++attempts === 1) throw new Error("找不到应用");
        return { connected: false, launched: true };
      }
    });
    view.click();
    await settle();
    assert.equal(attempts, 1);
    assert.equal(view.button.disabled, false);
    assert.equal(view.button.textContent, `重试打开 ${app.software}`);
    assert.equal(view.status.textContent, `无法打开 ${app.software}：找不到应用`);
    view.click();
    await settle();
    assert.equal(attempts, 2);
    assert.equal(view.button.disabled, false);
    assert.equal(view.button.textContent, `打开 ${app.software}`);
    assert.equal(view.status.textContent, `已启动 ${app.software}。`);
  });
}

test("a launch which neither connected nor started remains retryable", async (t) => {
  const view = await fixture(t, apps[0], { harnessLaunch: async () => ({ connected: false }) });
  view.click();
  await settle();
  assert.match(view.status.textContent, /尚未就绪.*重试/);
  assert.equal(view.button.textContent, "重试打开 Blender");
  assert.equal(view.button.disabled, false);
});

test("a synchronous desktop launch error is handled without losing the action", async (t) => {
  const view = await fixture(t, apps[0], {
    harnessLaunch() {
      throw new Error("正在关闭");
    }
  });
  view.click();
  await settle();
  assert.match(view.status.textContent, /正在关闭/);
  assert.equal(view.button.disabled, false);
});

for (const rejected of [false, true]) {
  test(`unmount ignores a late launch ${rejected ? "rejection" : "completion"} and removes its action`, async (t) => {
    let complete;
    let reject;
    let calls = 0;
    const view = await fixture(t, apps[0], {
      harnessLaunch() {
        calls += 1;
        return new Promise((resolve, fail) => {
          complete = resolve;
          reject = fail;
        });
      }
    });
    view.click();
    const oldStatus = view.status.textContent;
    const oldLabel = view.button.textContent;
    view.controller.unmount();
    assert.equal(view.host.childElementCount, 0);
    view.host.innerHTML = "<button data-next-editor>后续编辑器</button>";
    if (rejected) reject(new Error("过期启动失败"));
    else complete({ launched: true });
    await settle();
    assert.equal(view.host.querySelector("[data-next-editor]").textContent, "后续编辑器");
    assert.equal(view.host.childElementCount, 1);
    assert.equal(view.status.textContent, oldStatus);
    assert.equal(view.button.textContent, oldLabel);
    view.click(view.button);
    assert.equal(calls, 1);
  });
}

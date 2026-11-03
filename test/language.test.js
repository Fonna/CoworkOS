import { test } from "node:test";
import assert from "node:assert/strict";
import { readLanguage, validLanguage, LANGUAGE_KEY } from "../web/assets/ui/language.js";

test("language preference accepts only supported locales and tolerates restricted storage", () => {
  assert.equal(readLanguage({ getItem: () => "en" }), "en");
  for (const value of [undefined, null, "fr", "EN", "system", ""]) {
    assert.equal(validLanguage(value), false);
    assert.equal(readLanguage({ getItem: () => value }), "zh-CN");
  }
  assert.equal(
    readLanguage({
      getItem() {
        throw new Error("blocked");
      }
    }),
    "zh-CN"
  );
  assert.equal(readLanguage(), "zh-CN");
});

test("English translation affects only literal text and never interpolated user content", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (key) => (key === LANGUAGE_KEY ? "en" : null) }
    });
    const { ui } = await import("../web/assets/ui/language.js?english-test");
    assert.equal(ui("设置"), "Settings");
    assert.equal(ui`<button title="保存">${"设置"}</button>`, '<button title="Save">设置</button>');
    assert.equal(ui`正在编辑：${"保存<script>设置</script>"}`, "Editing: 保存<script>设置</script>");
    assert.equal(ui("Unknown label"), "Unknown label");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("blocked document/draft close gate retains the current language without saving or reloading", async () => {
  const { parseHTML } = await import("linkedom");
  const { installLanguageSettings } = await import("../web/assets/controllers/language-settings.js");
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  const { document, window } = parseHTML(
    '<select id="language-select"><option value="zh-CN">中文</option><option value="en">English</option></select><span id="language-status"></span>'
  );
  try {
    globalThis.document = document;
    globalThis.window = window;
    let writes = 0,
      reloads = 0;
    installLanguageSettings({
      prepareClose: async () => false,
      storage: {
        setItem() {
          writes++;
        }
      },
      reload() {
        reloads++;
      }
    });
    const select = document.querySelector("select");
    select.options[1].selected = true;
    select.dispatchEvent(new window.Event("change"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 0);
    assert.equal(reloads, 0);
    assert.equal(select.value, "zh-CN");
    assert.equal(select.disabled, false);
    assert.equal(document.querySelector("#language-status").textContent, "请先保存当前修改后再切换语言。");
  } finally {
    for (const key of ["document", "window"]) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  }
});

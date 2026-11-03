import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { installEditContextMenu } = require("../desktop/edit-context-menu.cjs");

function fixture() {
  const contents = new EventEmitter();
  const calls = [];
  contents.mainFrame = { url: "http://localhost:4321/" };
  contents.isDestroyed = () => false;
  contents.focus = () => calls.push("focus");
  for (const command of ["cut", "copy", "paste", "pasteAndMatchStyle", "selectAll", "undo", "redo"])
    contents[command] = () => calls.push(command);
  const window = { webContents: contents, isDestroyed: () => false };
  let items;
  const Menu = {
    buildFromTemplate: (template) => {
      items = template;
      return { popup: () => calls.push("popup"), closePopup: () => calls.push("close") };
    }
  };
  installEditContextMenu(window, {
    Menu,
    clipboard: { readText: () => "文字" },
    getDashboardUrl: () => "http://localhost:4321/"
  });
  const open = (extra = {}) =>
    contents.emit(
      "context-menu",
      {},
      {
        frame: contents.mainFrame,
        isEditable: true,
        selectionText: "",
        editFlags: { canPaste: true, canSelectAll: true },
        ...extra
      }
    );
  return { contents, calls, open, items: () => items };
}

test("editable menu enables native operations according to selection and uses plain-text paste", () => {
  const f = fixture();
  f.open();
  assert.equal(f.items().find((item) => item.label === "剪切").enabled, false);
  assert.equal(f.items().find((item) => item.label === "复制").enabled, false);
  f.items()
    .find((item) => item.label === "粘贴为纯文本")
    .click();
  assert.deepEqual(f.calls, ["popup", "focus", "pasteAndMatchStyle"]);
  f.open({ selectionText: "选区", editFlags: { canCopy: true, canCut: true, canPaste: false } });
  assert.equal(f.items().find((item) => item.label === "剪切").enabled, true);
  assert.equal(f.items().find((item) => item.label === "粘贴").enabled, false);
});

test("menu rejects noneditable, remote and child frames and stale navigation actions", () => {
  const f = fixture();
  f.open({ isEditable: false });
  f.open({ frame: { url: "http://localhost:4321/" } });
  f.contents.mainFrame.url = "https://example.org/";
  f.open();
  assert.deepEqual(f.calls, []);
  f.contents.mainFrame.url = "http://localhost:4321/";
  f.open();
  f.contents.mainFrame.url = "https://example.org/";
  f.items()
    .find((item) => item.label === "粘贴")
    .click();
  f.contents.emit("did-start-navigation", {}, "https://example.org/", false, true);
  assert.deepEqual(f.calls, ["popup", "close"]);
});

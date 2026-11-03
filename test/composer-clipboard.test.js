import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { clipboardHtmlText, createComposerClipboard } from "../web/assets/controllers/composer-clipboard.js";

function fixture() {
  const listeners = new Map();
  const files = [];
  const events = [];
  const { document } = parseHTML("<html><body></body></html>");
  const input = {
    ownerDocument: document,
    value: "旧草稿尾部",
    selectionStart: 3,
    selectionEnd: 5,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
    },
    dispatchEvent: (event) => events.push(event),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name)
  };
  const controller = createComposerClipboard({ input, addFiles: (images) => files.push(...images) });
  const paste = (text, items, defaultPrevented = false, html = "") => {
    const event = {
      defaultPrevented,
      clipboardData: { getData: (type) => (type === "text/plain" ? text : html), items },
      preventDefault() {
        this.defaultPrevented = true;
      }
    };
    listeners.get("paste")(event);
    return event;
  };
  return { files, paste, controller, listeners, input, events };
}
const image = { name: "clipboard.png" };
const items = [{ kind: "file", type: "image/png", getAsFile: () => image }];

test("mixed clipboard text including whitespace keeps the native insertion path", () => {
  const f = fixture();
  for (const text of ["文字\n第二行", " \n "]) assert.equal(f.paste(text, items).defaultPrevented, false);
  assert.deepEqual(f.files, []);
});

test("image-only clipboard attaches files, ignores unavailable images and respects handled events", () => {
  const f = fixture();
  assert.equal(f.paste("", items).defaultPrevented, true);
  assert.deepEqual(f.files, [image]);
  assert.equal(
    f.paste("", [{ kind: "file", type: "image/png", getAsFile: () => null }]).defaultPrevented,
    false
  );
  f.paste("", items, true);
  assert.deepEqual(f.files, [image]);
  f.controller.dispose();
  assert.equal(f.listeners.has("paste"), false);
});

test("inert HTML extraction preserves paragraphs and breaks without scripts or image placeholders", () => {
  const { document } = parseHTML("<html><body></body></html>");
  assert.equal(
    clipboardHtmlText(
      '<p>第一行<br>第二行</p><div>第三行</div><script>坏文本</script><style>坏样式</style><img src="https://example.org/remote.png">',
      document
    ),
    "第一行\n第二行\n第三行"
  );
  assert.equal(clipboardHtmlText('<img src="https://example.org/remote.png">', document), "");
});

test("HTML-only text replaces the selected draft and emits the shared saving input event", () => {
  const f = fixture();
  assert.equal(f.paste("", items, false, "<p>第一行<br>第二行</p>").defaultPrevented, true);
  assert.equal(f.input.value, "旧草稿第一行\n第二行");
  assert.deepEqual(f.files, []);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "input");
  assert.equal(f.events[0].bubbles, true);
});

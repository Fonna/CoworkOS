import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createApplicationTaskPanel } from "../web/assets/workbench/task-panel-layout.js";

for (const collapsed of [true, false]) {
  test(`application task layout restores the original ${collapsed ? "collapsed" : "open"} panel`, () => {
    const { document } = parseHTML('<html><body class="sidebar-collapsed"></body></html>');
    const body = document.body;
    body.classList.toggle("output-collapsed", collapsed);
    const shown = [];
    const panel = createApplicationTaskPanel({ body, onShow: (options) => shown.push(options) });
    panel.sync({ applicationAvailable: true, conversationVisible: false });
    assert.equal(panel.active, false);
    panel.sync({ applicationAvailable: true, conversationVisible: true });
    assert.equal(body.classList.contains("application-task-layout"), true);
    assert.equal(body.classList.contains("output-collapsed"), false);
    assert.deepEqual(shown, [undefined], "automatic layout does not move focus");
    panel.toggle();
    panel.sync({ applicationAvailable: true, conversationVisible: true });
    assert.equal(body.classList.contains("output-collapsed"), true, "polls retain a hidden task panel");
    assert.equal(panel.active, true, "polls retain the left-column switch");
    assert.equal(body.classList.contains("sidebar-collapsed"), false, "navigation can replace tasks");
    assert.equal(body.classList.contains("sidebar-mobile-open"), true, "navigation is reachable on mobile");
    panel.toggle();
    assert.deepEqual(shown.at(-1), { focus: true });
    assert.equal(body.classList.contains("sidebar-mobile-open"), false);
    panel.sync({ applicationAvailable: true, conversationVisible: false });
    assert.equal(panel.active, true, "fullscreen retains the task layout");
    panel.sync({ applicationAvailable: false, conversationVisible: true });
    assert.equal(body.classList.contains("application-task-layout"), false);
    assert.equal(body.classList.contains("output-collapsed"), collapsed);
    assert.equal(body.classList.contains("sidebar-collapsed"), true);
    assert.equal(body.classList.contains("sidebar-mobile-open"), false);
    assert.equal(panel.toggle(), false, "an unavailable editor cannot claim the task panel");
  });
}

test("switching from mobile navigation restores its open state when the application closes", () => {
  const { document } = parseHTML('<html><body class="sidebar-mobile-open output-collapsed"></body></html>');
  const panel = createApplicationTaskPanel({ body: document.body });
  panel.sync({ applicationAvailable: true, conversationVisible: true });
  assert.equal(document.body.classList.contains("sidebar-mobile-open"), false);
  panel.toggle();
  panel.sync({ applicationAvailable: true, conversationVisible: true });
  assert.equal(document.body.classList.contains("sidebar-mobile-open"), true);
  panel.toggle();
  panel.sync({ applicationAvailable: false, conversationVisible: true });
  assert.equal(document.body.classList.contains("sidebar-mobile-open"), true);
  assert.equal(document.body.classList.contains("sidebar-collapsed"), false);
});

test("a standalone application does not undo navigation changes before the task view is used", () => {
  const { document } = parseHTML('<html><body class="output-collapsed"></body></html>');
  const panel = createApplicationTaskPanel({ body: document.body });
  panel.sync({ applicationAvailable: true, conversationVisible: false });
  document.body.classList.add("sidebar-collapsed");
  panel.sync({ applicationAvailable: false, conversationVisible: false });
  assert.equal(document.body.classList.contains("sidebar-collapsed"), true);
});

for (const mobile of [false, true]) {
  test(`sidebar visibility preserves the selected view and survives refresh (${mobile ? "mobile" : "desktop"})`, () => {
    const { document } = parseHTML('<html><body class="output-collapsed"></body></html>');
    const body = document.body;
    const shown = [];
    const panel = createApplicationTaskPanel({ body, onShow: (options) => shown.push(options) });
    assert.equal(panel.toggleVisibility({ mobile }), false);
    panel.sync({ applicationAvailable: true, conversationVisible: true });
    for (const navigation of [false, true]) {
      if (navigation) panel.toggle();
      const before = shown.length;
      panel.toggleVisibility({ mobile });
      assert.equal(body.classList.contains("sidebar-collapsed"), true);
      assert.equal(body.classList.contains("output-collapsed"), navigation);
      assert.equal(body.classList.contains("sidebar-mobile-open"), false);
      assert.equal(panel.sync({ applicationAvailable: true, conversationVisible: true }), false);
      assert.equal(body.classList.contains("sidebar-collapsed"), true);
      assert.equal(shown.length, before, "refreshing does not reopen the hidden task view");
      panel.toggleVisibility({ mobile });
      assert.equal(body.classList.contains("sidebar-collapsed"), false);
      assert.equal(body.classList.contains("output-collapsed"), navigation);
      assert.equal(body.classList.contains("sidebar-mobile-open"), navigation);
      if (!navigation) assert.equal(shown.at(-1), undefined, "restoring does not steal button focus");
    }
    if (mobile) {
      body.classList.remove("sidebar-mobile-open");
      panel.sync({ applicationAvailable: true, conversationVisible: true });
      panel.toggleVisibility({ mobile });
      assert.equal(body.classList.contains("sidebar-mobile-open"), true, "a dismissed drawer reopens");
    }
    panel.sync({ applicationAvailable: false, conversationVisible: true });
    assert.equal(body.classList.contains("sidebar-collapsed"), false);
    assert.equal(body.classList.contains("sidebar-mobile-open"), false);
  });
}

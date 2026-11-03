import assert from "node:assert/strict";
import { test } from "node:test";
import { createComposerLayout, recoverComposerLayout } from "../web/assets/controllers/composer-layout.js";

function fixture(t, { broken = true, focused = false, display = "", priority = "" } = {}) {
  const events = [];
  const parent = { width: 700, height: 58, contentVisibility: "visible" };
  parent.getBoundingClientRect = () => parent;
  const declarations = new Map(display ? [["display", [display, priority]]] : []);
  const editor = {};
  let hadStyle = Boolean(display);
  const input = {
    isConnected: true,
    hidden: false,
    parentElement: parent,
    ownerDocument: { activeElement: editor },
    value: "保留草稿\n😀 第二行",
    selectionStart: 2,
    selectionEnd: 7,
    selectionDirection: "backward",
    scrollTop: 21,
    display: "block",
    visibility: "visible",
    getClientRects: () => (broken ? [] : [{ width: 670, height: 48 }]),
    hasAttribute: () => hadStyle,
    removeAttribute: () => {
      hadStyle = false;
    },
    style: {
      getPropertyValue: (name) => declarations.get(name)?.[0] || "",
      getPropertyPriority: (name) => declarations.get(name)?.[1] || "",
      get cssText() {
        return declarations.size ? "display declaration" : "";
      },
      setProperty(name, value, priority) {
        events.push([name, value, priority]);
        declarations.set(name, [value, priority]);
        hadStyle = true;
      },
      removeProperty(name) {
        declarations.delete(name);
      }
    },
    get offsetHeight() {
      events.push("layout");
      assert.equal(this.style.getPropertyValue("display"), "none");
      broken = false;
      this.ownerDocument.activeElement = editor;
      this.scrollTop = 0;
      return 0;
    },
    focus(options) {
      assert.deepEqual(options, { preventScroll: true });
      this.ownerDocument.activeElement = this;
    },
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    }
  };
  if (focused) input.ownerDocument.activeElement = input;
  mockGlobal(t, "getComputedStyle", (node) => node);
  return { input, parent, events, editor };
}

// Node does not provide browser layout; model the observed native fault: the
// parent has bounds, textarea display is block, but its layout is absent until
// a display transition is committed. Native e2e tests cover actual navigation.
function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test("missing textarea layout is rebuilt without losing the draft, focus, selection or scroll", (t) => {
  const { input, events } = fixture(t, { focused: true });
  assert.equal(recoverComposerLayout(input), true);
  assert.deepEqual(events, [["display", "none", "important"], "layout"]);
  assert.equal(input.value, "保留草稿\n😀 第二行");
  assert.equal(input.ownerDocument.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [2, 7, "backward"]);
  assert.equal(input.scrollTop, 21);
  assert.equal(input.hasAttribute("style"), false);
  assert.equal(recoverComposerLayout(input), false);
});

test("recovery retains inline display priority and does not take focus from the editor", (t) => {
  const { input, editor } = fixture(t, { display: "block", priority: "important" });
  assert.equal(recoverComposerLayout(input), true);
  assert.equal(input.style.getPropertyValue("display"), "block");
  assert.equal(input.style.getPropertyPriority("display"), "important");
  assert.equal(input.ownerDocument.activeElement, editor);
});

test("a healthy input is never rewritten", (t) => {
  const { input, events } = fixture(t, { broken: false });
  assert.equal(recoverComposerLayout(input), false);
  assert.deepEqual(events, []);
});

test("intentional hiding, detached nodes and invisible workspaces are left alone", (t) => {
  const { input, parent, events } = fixture(t);
  for (const [node, property, value] of [
    [input, "isConnected", false],
    [input, "hidden", true],
    [input, "display", "none"],
    [input, "display", "contents"],
    [input, "visibility", "hidden"],
    [parent, "contentVisibility", "hidden"],
    [parent, "width", 0],
    [parent, "height", 0]
  ]) {
    const before = node[property];
    node[property] = value;
    assert.equal(recoverComposerLayout(input), false, `${property}=${value}`);
    node[property] = before;
  }
  assert.deepEqual(events, []);
});

test("layout notifications coalesce, restore only when visible, and stop on disposal", (t) => {
  const { input, parent, events } = fixture(t);
  const observed = [];
  const frames = new Map();
  let notify;
  let disconnected = false;
  let next = 0;
  mockGlobal(t, "window", new EventTarget());
  mockGlobal(
    t,
    "ResizeObserver",
    class {
      constructor(callback) {
        notify = callback;
      }
      observe(node) {
        observed.push(node);
      }
      disconnect() {
        disconnected = true;
      }
    }
  );
  mockGlobal(t, "requestAnimationFrame", (callback) => {
    frames.set(++next, callback);
    return next;
  });
  mockGlobal(t, "cancelAnimationFrame", (id) => frames.delete(id));
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
  };
  const dispose = createComposerLayout(input);
  assert.deepEqual(observed, [input, parent]);
  parent.height = 0;
  notify();
  notify();
  assert.equal(frames.size, 1);
  flush();
  assert.deepEqual(events, []);
  parent.height = 58;
  notify();
  flush();
  assert.equal(input.getClientRects().length, 1);
  window.dispatchEvent(new Event("focus"));
  assert.equal(frames.size, 1);
  dispose();
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0);
  window.dispatchEvent(new Event("focus"));
  assert.equal(frames.size, 0);
});

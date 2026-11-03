import assert from "node:assert/strict";
import { test } from "node:test";
import { focusedControl } from "../web/assets/ui/focus.js";

test("dialog return focus follows nested same-origin editor controls", () => {
  const button = { localName: "button" };
  const inner = { localName: "iframe", contentDocument: { activeElement: button } };
  const frame = { localName: "iframe", contentDocument: { activeElement: inner } };
  assert.equal(focusedControl({ activeElement: frame }), button);
  assert.equal(focusedControl({ activeElement: button }), button);
});

test("dialog return focus keeps the frame when its contents have no focused control or are inaccessible", () => {
  const body = { localName: "body" };
  const frame = { localName: "iframe", contentDocument: { activeElement: body, body } };
  assert.equal(focusedControl({ activeElement: frame }), frame);
  const foreign = {
    localName: "iframe",
    get contentDocument() {
      throw new Error("Blocked cross-origin access");
    }
  };
  assert.equal(focusedControl({ activeElement: foreign }), foreign);
  assert.equal(focusedControl({ activeElement: null }), null);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
const { windowBackground, followNativeTheme } = createRequire(import.meta.url)("../desktop/system-theme.cjs");

test("window background follows initial native appearance and updates until closed", () => {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    setBackgroundColor: (color) => colors.push(color)
  });
  const colors = [];
  assert.equal(windowBackground(nativeTheme), "#f7f7f8");
  followNativeTheme(window, nativeTheme);
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit("updated");
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit("updated");
  assert.deepEqual(colors, ["#f7f7f8", "#0d0d0d", "#f7f7f8"]);
  window.emit("closed");
  assert.equal(nativeTheme.listenerCount("updated"), 0);
  nativeTheme.emit("updated");
  assert.equal(colors.length, 3);
});

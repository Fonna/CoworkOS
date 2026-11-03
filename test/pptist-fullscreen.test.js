import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../vendor/pptist/src/utils/fullscreen.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("PPTist exits fullscreen even when Escape precedes completion of entry", async () => {
  let finishEntry,
    exits = 0;
  const document = {
    fullscreenElement: null,
    addEventListener() {},
    documentElement: {
      requestFullscreen: () =>
        new Promise((resolve) => {
          finishEntry = resolve;
        })
    },
    exitFullscreen: async () => {
      document.fullscreenElement = null;
      exits++;
    }
  };
  const exports = {};
  runInNewContext(compiled, { document, exports, window: { addEventListener() {} } });
  exports.enterFullscreen();
  exports.exitFullscreen();
  document.fullscreenElement = document.documentElement;
  finishEntry();
  await settle();
  assert.equal(document.fullscreenElement, null);
  assert.equal(exits, 1);
});

test("PPTist can retry a rejected fullscreen request and exit normally", async () => {
  let attempts = 0;
  const document = {
    fullscreenElement: null,
    addEventListener() {},
    documentElement: {
      requestFullscreen: async () => {
        if (++attempts === 1) throw new Error("fullscreen denied");
        document.fullscreenElement = document.documentElement;
      }
    },
    exitFullscreen: async () => {
      document.fullscreenElement = null;
    }
  };
  const exports = {};
  runInNewContext(compiled, { document, exports, window: { addEventListener() {} } });
  exports.enterFullscreen();
  await settle();
  assert.equal(exports.isFullscreen(), false);
  exports.enterFullscreen();
  await settle();
  assert.equal(exports.isFullscreen(), true);
  exports.exitFullscreen();
  await settle();
  assert.equal(exports.isFullscreen(), false);
});

test("PPTist cancels entry when the fullscreen element appears after its promise resolves", async () => {
  let changed;
  const document = {
    fullscreenElement: null,
    addEventListener: (_name, listener) => {
      changed = listener;
    },
    documentElement: { requestFullscreen: async () => {} },
    exitFullscreen: async () => {
      document.fullscreenElement = null;
    }
  };
  const exports = {};
  runInNewContext(compiled, { document, exports, window: { addEventListener() {} } });
  exports.enterFullscreen();
  await settle();
  exports.exitFullscreen();
  document.fullscreenElement = document.documentElement;
  changed();
  await settle();
  assert.equal(exports.isFullscreen(), false);
});

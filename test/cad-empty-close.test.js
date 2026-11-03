import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { cadEditorAdapter } from "../web/assets/workbench/adapters/cad-editor.js";

test("an empty CAD window does not block saving model settings or quitting", async (t) => {
  const { document } = parseHTML("<div id='editor'></div>");
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = document;
  globalThis.window = { bookmanDesktop: undefined };
  t.after(() => {
    if (previous.document === undefined) delete globalThis.document;
    else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
  });
  const host = document.querySelector("#editor");
  const controller = await cadEditorAdapter.mount(host, {
    instance: { resourceIds: [] },
    taskId: "empty-cad",
    api: { listResources: async () => ({ resources: [] }) }
  });
  try {
    assert.equal(await controller.canClose(), true);
  } finally {
    await controller.unmount();
  }
});

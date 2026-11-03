import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { browserFixture, browserTestOptions } from "./browser-fixture.mjs";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(requirePi.resolve("jiti"));
const { registerBrowserTools } = await createJiti(import.meta.url).import(
  resolve(".pi/runtime/tools/browser-use.ts")
);

test(
  "text-only Browser tools reject coordinate input before dispatch while retaining ARIA semantics",
  browserTestOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-browser-text-only-"));
    const fixture = await browserFixture();
    const previousExecutable = process.env.COWORK_BROWSER_EXECUTABLE;
    process.env.COWORK_BROWSER_EXECUTABLE = chromium.executablePath();
    const tools = new Map();
    const lifecycle = registerBrowserTools(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { taskWorkspace: root, supportsImages: true }
    );
    t.after(async () => {
      await lifecycle.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
      if (previousExecutable === undefined) delete process.env.COWORK_BROWSER_EXECUTABLE;
      else process.env.COWORK_BROWSER_EXECUTABLE = previousExecutable;
    });
    const execute = (name, params, input = ["text"]) =>
      tools.get(name).execute("browser-text-only", params, new AbortController().signal, () => {}, {
        model: { input }
      });
    const opened = await execute("browser_open", { url: fixture.url, observation: "aria" });
    const pageId = opened.details.pageId;
    for (const action of [
      { type: "click_at", x: 40, y: 40 },
      { type: "drag", from: { x: 40, y: 40 }, to: { x: 120, y: 80 } },
      { type: "scroll", x: 40, y: 40, deltaX: 0, deltaY: 100 }
    ])
      await t.test(action.type, async () => {
        const screenshot = await execute("browser_observe", { pageId, observation: "screenshot" }, [
          "text",
          "image"
        ]);
        assert.ok(screenshot.details.observationId);
        assert.equal(
          screenshot.content.some((part) => part.type === "image"),
          true
        );
        const rejected = await execute("browser_act", {
          pageId,
          observationId: screenshot.details.observationId,
          action
        });
        assert.equal(rejected.isError, true);
        assert.equal(rejected.details.errorCode, "image_input_required");
        assert.equal(rejected.details.dispatchStatus, "not_sent");
      });
    for (const params of [
      null,
      [],
      { pageId, action: null },
      { pageId, action: { type: "click_at", x: 1 } }
    ]) {
      const invalid = await execute("browser_act", params);
      assert.equal(invalid.details.errorCode, "invalid_argument");
      assert.equal(invalid.details.dispatchStatus, "not_sent");
    }
    const saved = await execute("browser_act", {
      pageId,
      observation: "aria",
      action: { type: "click", target: { kind: "role", role: "button", name: "Save" } }
    });
    assert.equal(saved.isError, undefined);
    assert.equal(saved.details.dispatchStatus, "sent");
    assert.match(saved.details.observation.ariaSnapshot, /Saved/);
  }
);

test(
  "text-only screenshot requests cannot clear the backend's uncertain-input gate",
  browserTestOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-browser-text-gate-"));
    const fixture = await browserFixture();
    const previousExecutable = process.env.COWORK_BROWSER_EXECUTABLE;
    process.env.COWORK_BROWSER_EXECUTABLE = chromium.executablePath();
    const tools = new Map();
    const lifecycle = registerBrowserTools(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { taskWorkspace: root, supportsImages: true }
    );
    t.after(async () => {
      await lifecycle.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
      if (previousExecutable === undefined) delete process.env.COWORK_BROWSER_EXECUTABLE;
      else process.env.COWORK_BROWSER_EXECUTABLE = previousExecutable;
    });
    const execute = (name, params) =>
      tools.get(name).execute("browser-text-gate", params, new AbortController().signal, () => {}, {
        model: { input: ["text"] }
      });
    const opened = await execute("browser_open", { url: fixture.url, observation: "aria" });
    const pageId = opened.details.pageId;
    const target = { kind: "role", role: "button", name: "Save" };
    const sent = await execute("browser_act", {
      pageId,
      observation: "aria",
      action: { type: "click", target, expectDownload: true },
      timeoutMs: 2000
    });
    assert.equal(sent.details.dispatchStatus, "sent");
    assert.equal(sent.details.requiresObservation, true);
    for (const [operation, params] of [
      ["browser_open", { url: fixture.url }],
      ["browser_observe", { pageId }],
      ["browser_act", { pageId, action: { type: "click", target } }],
      ["browser_wait", { pageId, condition: { type: "element", state: "visible", target } }]
    ]) {
      const rejected = await execute(operation, { ...params, observation: "screenshot" });
      assert.equal(rejected.isError, true, operation);
      assert.equal(rejected.details.errorCode, "image_input_required", operation);
      assert.equal(rejected.details.dispatchStatus, "not_sent", operation);
    }
    const blocked = await execute("browser_act", { pageId, action: { type: "click", target } });
    assert.equal(blocked.details.errorCode, "observation_required");
    const recovered = await execute("browser_observe", { pageId, observation: "aria" });
    assert.match(recovered.details.ariaSnapshot, /Saved/);
    assert.equal(recovered.details.requiresObservation, false);
    const semantic = await execute("browser_act", {
      pageId,
      observation: "both",
      action: { type: "click", target }
    });
    assert.equal(semantic.details.dispatchStatus, "sent");
    assert.match(semantic.details.observation.ariaSnapshot, /Saved/);
    assert.equal(
      semantic.content.some((part) => part.type === "image"),
      false
    );
  }
);

test(
  "Browser tool archive failure preserves live pixels and sent evidence, and lifecycle reset is reusable",
  browserTestOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-browser-feedback-"));
    const fixture = await browserFixture();
    await writeFile(join(root, "visual"), "fixture prevents archive directory creation");
    const previousExecutable = process.env.COWORK_BROWSER_EXECUTABLE;
    process.env.COWORK_BROWSER_EXECUTABLE = chromium.executablePath();
    const tools = new Map();
    const lifecycle = registerBrowserTools(
      { registerTool: (tool) => tools.set(tool.name, tool) },
      { taskWorkspace: root, supportsImages: true }
    );
    t.after(async () => {
      await lifecycle.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
      if (previousExecutable === undefined) delete process.env.COWORK_BROWSER_EXECUTABLE;
      else process.env.COWORK_BROWSER_EXECUTABLE = previousExecutable;
    });
    const execute = (name, params, input = ["text", "image"]) =>
      tools
        .get(name)
        .execute("browser-feedback", params, new AbortController().signal, () => {}, { model: { input } });
    const opened = await execute("browser_open", { url: fixture.url });
    assert.equal(opened.isError, undefined);
    assert.equal(opened.details.imageArchive.saved, false);
    assert.equal(opened.content.filter((part) => part.type === "image").length, 1);
    const pageId = opened.details.pageId;
    const sent = await execute("browser_act", {
      pageId,
      action: { type: "click", target: { kind: "role", role: "button", name: "Save" } }
    });
    assert.equal(sent.details.dispatchStatus, "sent");
    assert.equal(sent.details.requiresObservation, false);
    assert.equal(sent.details.observation.imageArchive.saved, false);
    assert.match(sent.details.observation.ariaSnapshot, /Saved/);
    assert.equal(sent.content.filter((part) => part.type === "image").length, 1);
    assert.equal(sent.content[0].text.includes('"image":"'), false);
    const textOnly = await execute("browser_observe", { pageId }, ["text"]);
    assert.equal(textOnly.details.visualFeedback.delivered, false);
    assert.equal(
      textOnly.content.some((part) => part.type === "image"),
      false
    );
    const ariaOnly = await execute("browser_observe", { pageId, observation: "aria" });
    assert.ok(ariaOnly.details.ariaSnapshot);
    assert.equal(ariaOnly.details.imageArchive, undefined);
    assert.equal(ariaOnly.details.visualFeedback, undefined);
    assert.equal(
      ariaOnly.content.some((part) => part.type === "image"),
      false
    );
    const cheap = await execute("browser_act", {
      pageId,
      observation: "none",
      action: { type: "click", target: { kind: "role", role: "button", name: "Save" } }
    });
    assert.equal(cheap.details.observationStatus, "omitted");
    assert.equal(cheap.details.observation, undefined);
    await lifecycle.closeAll();
    const stale = await execute("browser_observe", { pageId });
    assert.equal(stale.isError, true);
    assert.equal(stale.details.errorCode, "page_not_found");
    const fresh = await execute("browser_open", { url: fixture.url });
    assert.notEqual(fresh.details.pageId, pageId);
    await lifecycle.dispose();
    const closed = await execute("browser_open", { url: fixture.url });
    assert.equal(closed.details.errorCode, "closed");
  }
);

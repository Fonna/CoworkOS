import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";
import { BrowserUse } from "../dist/src/gui/browser-use.js";
import { browserFixture, browserTestOptions } from "./browser-fixture.mjs";

const role = (name, role = "button") => ({ kind: "role", role, name });
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "atria-browser-use-"));
  const fixture = await browserFixture();
  const controller = new BrowserUse({
    taskDirectory: root,
    executablePath: chromium.executablePath(),
    ...options
  });
  t.after(async () => {
    await controller.dispose();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, fixture, controller };
}
function error(code, dispatchStatus = "not_sent") {
  return (value) => value.errorCode === code && value.dispatchStatus === dispatchStatus;
}

test(
  "real owned Chromium semantic form actions, explicit waits and CSS screenshots",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t);
    const observed = await controller.execute("browser_open", { url: fixture.url });
    assert.equal(observed.title, "Browser fixture");
    assert.equal(observed.deviceScaleFactor, 1);
    const png = PNG.sync.read(Buffer.from(observed.image, "base64"));
    assert.equal(png.width, 1280);
    assert.equal(png.height, 800);
    assert.match(observed.ariaSnapshot, /Name/);
    const pageId = observed.pageId;
    const filling = controller.execute("browser_act", {
      pageId,
      action: { type: "fill", target: { kind: "label", text: "Name" }, value: "CoworkOS 中文" }
    });
    const saving = controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Save") }
    });
    await filling;
    const saved = await saving;
    assert.equal(saved.dispatchStatus, "sent");
    assert.equal(saved.effectVerified, false);
    assert.match(saved.observation.ariaSnapshot, /Saved CoworkOS 中文/);
    const selected = await controller.execute("browser_act", {
      pageId,
      action: { type: "select", target: { kind: "label", text: "Format" }, value: "json" }
    });
    assert.match(selected.observation.ariaSnapshot, /Format: json/);
    await controller.execute("browser_act", {
      pageId,
      action: { type: "press", target: role("Name", "textbox"), key: "ControlOrMeta+A" }
    });
    await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: { kind: "testId", text: "agree" } }
    });
    await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: { kind: "text", text: "Show later" } }
    });
    const waited = await controller.execute("browser_wait", {
      pageId,
      condition: { type: "element", target: { kind: "text", text: "Finished later" }, state: "visible" },
      timeoutMs: 1000
    });
    assert.equal(waited.status, "condition_met");
    assert.equal(
      (
        await controller.execute("browser_wait", {
          pageId,
          condition: { type: "element", target: role("Enabled later"), state: "enabled" }
        })
      ).status,
      "condition_met"
    );
    assert.equal(
      (
        await controller.execute("browser_wait", {
          pageId,
          condition: { type: "element", target: role("Missing"), state: "detached" }
        })
      ).status,
      "condition_met"
    );
    const timeout = await controller.execute("browser_wait", {
      pageId,
      condition: { type: "element", target: role("Missing"), state: "visible" },
      timeoutMs: 50
    });
    assert.equal(timeout.status, "timeout");
    assert.ok(timeout.observation.image);
    const navigated = await controller.execute("browser_act", {
      pageId,
      action: { type: "navigate", url: `${fixture.url}?next=1` }
    });
    assert.equal(navigated.observation.url, `${fixture.url}?next=1`);
    assert.equal(
      (
        await controller.execute("browser_wait", {
          pageId,
          condition: { type: "url", url: `${fixture.url}?next=1` }
        })
      ).status,
      "condition_met"
    );
  }
);

test(
  "duplicate locators reject input, failures expose uncertainty and post-input observation failure preserves sent",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t),
      { pageId } = await controller.execute("browser_open", { url: fixture.url });
    await assert.rejects(
      controller.execute("browser_act", { pageId, action: { type: "click", target: role("Duplicate") } }),
      error("ambiguous_target")
    );
    await assert.rejects(
      controller.execute("browser_wait", {
        pageId,
        condition: { type: "element", target: role("Duplicate"), state: "visible" }
      }),
      error("ambiguous_target")
    );
    assert.match((await controller.execute("browser_observe", { pageId })).ariaSnapshot, /Ready/);
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "select", target: { kind: "label", text: "Format" }, value: "missing" },
        timeoutMs: 100
      }),
      error("browser_failed", "unknown")
    );
    await controller.execute("browser_observe", { pageId });
    const failure = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Remove body") },
      timeoutMs: 500
    });
    assert.equal(failure.dispatchStatus, "sent");
    assert.equal(failure.requiresObservation, true);
    assert.equal(failure.observationError, "capture_failed");
  }
);

test(
  "downloads are preregistered, bounded, copied under Task and independently verified",
  browserTestOptions,
  async (t) => {
    const { controller, fixture, root } = await setup(t, { maxDownloadBytes: 1024 });
    const { pageId } = await controller.execute("browser_open", { url: fixture.url });
    const downloaded = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Download report", "link"), expectDownload: true }
    });
    assert.equal(downloaded.dispatchStatus, "sent");
    assert.equal(downloaded.download.scope, "task");
    assert.match(downloaded.download.path, /^visual\/downloads\/dl_/);
    const bytes = await readFile(join(root, downloaded.download.path));
    assert.equal(bytes.toString(), "Saved report: CoworkOS 中文\n");
    assert.equal(downloaded.download.bytes, bytes.length);
    assert.equal(downloaded.download.sha256, createHash("sha256").update(bytes).digest("hex"));
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "click", target: role("Large report", "link"), expectDownload: true }
      }),
      error("download_limit", "sent")
    );
    assert.equal((await readdir(join(root, "visual", "downloads"))).length, 1);
    await controller.execute("browser_observe", { pageId });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "click", target: role("Save"), expectDownload: true },
        timeoutMs: 1000
      }),
      error("download_timeout", "sent")
    );
    await controller.execute("browser_observe", { pageId });
    const again = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Download report", "link"), expectDownload: true }
    });
    assert.ok(again.download.path);
  }
);

test(
  "download directory symlinks refuse accepted writes while preserving sent input",
  { ...browserTestOptions, timeout: 15000 },
  async (t) => {
    const { controller, fixture, root } = await setup(t);
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(root, "visual"));
    await symlink(outside, join(root, "visual", "downloads"));
    const { pageId } = await controller.execute("browser_open", { url: fixture.url });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "click", target: role("Download report", "link"), expectDownload: true }
      }),
      error("download_path", "sent")
    );
    assert.deepEqual(await readdir(outside), []);
  }
);

test(
  "cancelled wait and download close the context; reset invalidates queued operations and enables a fresh page",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t),
      { pageId } = await controller.execute("browser_open", { url: fixture.url });
    const abort = new AbortController();
    const pending = controller.execute(
      "browser_wait",
      { pageId, condition: { type: "element", target: role("Missing"), state: "visible" }, timeoutMs: 10000 },
      abort.signal
    );
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(pending, error("cancelled"));
    await assert.rejects(controller.execute("browser_observe", { pageId }), error("page_not_found"));
    const opened = await controller.execute("browser_open", { url: fixture.url });
    const resetPending = controller.execute("browser_wait", {
      pageId: opened.pageId,
      condition: { type: "element", target: role("Missing"), state: "visible" },
      timeoutMs: 10000
    });
    const queued = controller.execute("browser_observe", { pageId: opened.pageId });
    const stopped = [
      assert.rejects(resetPending, error("cancelled")),
      assert.rejects(queued, error("session_changed"))
    ];
    setTimeout(() => {
      void controller.reset();
    }, 100);
    await Promise.all(stopped);
    const current = await controller.execute("browser_open", { url: fixture.url });
    const downloadAbort = new AbortController();
    const downloading = controller.execute(
      "browser_act",
      {
        pageId: current.pageId,
        action: { type: "click", target: role("Slow report", "link"), expectDownload: true }
      },
      downloadAbort.signal
    );
    await fixture.started;
    setTimeout(() => downloadAbort.abort(), 100);
    await assert.rejects(downloading, error("cancelled", "sent"));
    await assert.rejects(
      controller.execute("browser_observe", { pageId: current.pageId }),
      error("page_not_found")
    );
  }
);

test(
  "contexts isolate Task cookies/pageIds and own popups without switching the target",
  browserTestOptions,
  async (t) => {
    const first = await setup(t),
      second = await setup(t);
    const a = await first.controller.execute("browser_open", { url: first.fixture.url });
    await first.controller.execute("browser_act", {
      pageId: a.pageId,
      action: { type: "click", target: role("Save") }
    });
    const b = await second.controller.execute("browser_open", { url: first.fixture.url });
    assert.match(b.ariaSnapshot, /Cookie: empty/);
    const sameTask = await first.controller.execute("browser_open", { url: first.fixture.url });
    assert.match(sameTask.ariaSnapshot, /Cookie: session=task-a/);
    await assert.rejects(
      second.controller.execute("browser_observe", { pageId: a.pageId }),
      error("page_not_found")
    );
    const popup = await first.controller.execute("browser_act", {
      pageId: a.pageId,
      action: { type: "click", target: role("Popup") }
    });
    assert.equal(popup.observation.pageId, a.pageId);
    assert.equal(popup.observation.url, first.fixture.url);
    assert.equal(popup.observation.pages.length, 3);
    assert.equal(popup.observation.popupSupport, "managed");
    const ownedPopup = popup.observation.pages.find((page) => page.openerPageId === a.pageId);
    assert.ok(ownedPopup?.pageId);
    const selected = await first.controller.execute("browser_act", {
      pageId: ownedPopup.pageId,
      action: { type: "click", target: role("Save popup") }
    });
    assert.match(selected.observation.ariaSnapshot, /Popup saved/);
    assert.ok(popup.observation.events.some((event) => event.type === "popup" && event.status === "opened"));
    await first.controller.execute("browser_close", {});
    await assert.rejects(
      first.controller.execute("browser_observe", { pageId: a.pageId }),
      error("page_not_found")
    );
    const reopened = await first.controller.execute("browser_open", { url: first.fixture.url });
    assert.match(reopened.ariaSnapshot, /Cookie: empty/);
  }
);

test("model arguments cannot supply profiles/scripts/executables and a missing browser has installation guidance", async (t) => {
  const { controller } = await setup(t, { executablePath: "/atria-browser-fixture-no-binary" });
  await assert.rejects(
    controller.execute("browser_open", { url: "https://example.com", executablePath: "/bin/sh" }),
    error("invalid_argument")
  );
  for (const url of [
    "file:///tmp/secret",
    "data:text/html,hello",
    "https://user:password@example.com",
    "/relative"
  ])
    await assert.rejects(controller.execute("browser_open", { url }), error("invalid_argument"));
  await assert.rejects(
    controller.execute("browser_open", { url: "https://example.com" }),
    (value) =>
      value.errorCode === "browser_unavailable" && /playwright-core install chromium/.test(value.message)
  );
  await controller.dispose();
  await assert.rejects(controller.execute("browser_open", { url: "https://example.com" }), error("closed"));
});

test(
  "popup storms obey the shared page limit and cannot survive as untracked context pages",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t);
    const first = await controller.execute("browser_open", { url: fixture.url });
    await controller.execute("browser_act", {
      pageId: first.pageId,
      action: { type: "click", target: role("Popup storm") }
    });
    for (let i = 0; i < 5; i++) {
      try {
        await controller.execute("browser_open", { url: fixture.url });
      } catch (value) {
        assert.equal(value.errorCode, "page_limit");
      }
    }
    await controller.execute("browser_wait", {
      pageId: first.pageId,
      condition: {
        type: "element",
        target: { kind: "text", text: "Popup storm finished" },
        state: "visible"
      },
      observation: "aria"
    });
    const observation = await controller.execute("browser_observe", { pageId: first.pageId });
    assert.equal(observation.pages.length, 8);
    // Inspect the actual Playwright context, including any pages absent from the
    // controller registry: reporting only managed pages hid this resource leak.
    const actualPages = controller.context.pages();
    assert.equal(actualPages.length, observation.pages.length);
    assert.ok(actualPages.every((page) => [fixture.url, `${fixture.url}popup`].includes(page.url())));
    assert.ok(
      observation.events.some((event) => event.type === "popup" && event.status === "closed_page_limit")
    );
  }
);

test(
  "owned browser enforces 8-page limit and explicitly closing a page permits a replacement",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t);
    const pages = [];
    for (let i = 0; i < 8; i++) pages.push(await controller.execute("browser_open", { url: fixture.url }));
    assert.equal(pages.at(-1).pages.length, 8);
    await assert.rejects(controller.execute("browser_open", { url: fixture.url }), error("page_limit"));
    await controller.execute("browser_close", { pageId: pages[0].pageId });
    const replacement = await controller.execute("browser_open", { url: fixture.url });
    assert.equal(replacement.pages.length, 8);
    await assert.rejects(
      controller.execute("browser_observe", { pageId: pages[0].pageId }),
      error("page_not_found")
    );
  }
);

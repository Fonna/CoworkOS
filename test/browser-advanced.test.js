import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { BrowserUse } from "../dist/src/gui/browser-use.js";
import { browserFixture, browserTestOptions } from "./browser-fixture.mjs";

const role = (name, role = "button") => ({ kind: "role", role, name });
const error = (code) => (value) => value.errorCode === code && value.dispatchStatus === "not_sent";
async function setup(t) {
  const taskDirectory = await mkdtemp(join(tmpdir(), "atria-browser-advanced-"));
  const fixture = await browserFixture();
  const controller = new BrowserUse({ taskDirectory, executablePath: chromium.executablePath() });
  t.after(async () => {
    await controller.dispose();
    await fixture.close();
    await rm(taskDirectory, { recursive: true, force: true });
  });
  const opened = await controller.execute("browser_open", { url: `${fixture.url}advanced` });
  return { controller, fixture, opened, pageId: opened.pageId };
}

test(
  "semantic scopes and explicit nth disambiguate without silently choosing a duplicate",
  browserTestOptions,
  async (t) => {
    const { controller, pageId } = await setup(t);
    await assert.rejects(
      controller.execute("browser_act", { pageId, action: { type: "click", target: role("Save") } }),
      error("ambiguous_target")
    );
    const scoped = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: { ...role("Save"), scope: [role("Second", "region")] } }
    });
    assert.match(scoped.observation.ariaSnapshot, /Second saved/);
    const indexed = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: { ...role("Save"), nth: 0 } }
    });
    assert.match(indexed.observation.ariaSnapshot, /First saved/);
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "click", target: { ...role("Save"), nth: 10 } }
      }),
      error("target_not_found")
    );
    await controller.execute("browser_act", {
      pageId,
      observation: "none",
      action: { type: "click", target: role("Show scope") }
    });
    const waited = await controller.execute("browser_wait", {
      pageId,
      observation: "aria",
      timeoutMs: 1000,
      condition: {
        type: "element",
        state: "visible",
        target: { ...role("Late save"), scope: [role("Late scope", "region")] }
      }
    });
    assert.equal(waited.status, "condition_met");
  }
);

test(
  "observation modes omit unrequested pixels/ARIA and cheap actions continue deliberately",
  browserTestOptions,
  async (t) => {
    const { controller, pageId, fixture } = await setup(t);
    const cheapOpen = await controller.execute("browser_open", { url: fixture.url, observation: "none" });
    assert.equal(cheapOpen.observationStatus, "omitted");
    assert.equal(cheapOpen.observationId, undefined);
    assert.equal(cheapOpen.capturedAt, undefined);
    assert.equal(cheapOpen.image, undefined);
    assert.equal(cheapOpen.ariaSnapshot, undefined);
    const aria = await controller.execute("browser_observe", { pageId, observation: "aria" });
    assert.ok(aria.ariaSnapshot);
    assert.equal(aria.image, undefined);
    assert.equal(aria.observationId, undefined);
    const screenshot = await controller.execute("browser_observe", { pageId, observation: "screenshot" });
    assert.ok(screenshot.image && screenshot.observationId);
    assert.equal(screenshot.ariaSnapshot, undefined);
    for (const nth of [0, 1]) {
      const cheap = await controller.execute("browser_act", {
        pageId,
        observation: "none",
        action: { type: "click", target: { ...role("Save"), nth } }
      });
      assert.equal(cheap.observation, undefined);
      assert.equal(cheap.observationStatus, "omitted");
      assert.equal(cheap.requiresObservation, false);
    }
    assert.match(
      (await controller.execute("browser_observe", { pageId, observation: "aria" })).ariaSnapshot,
      /Second saved/
    );
  }
);

test(
  "iframe IDs explicitly select a frame and cannot cross pages or survive detach",
  browserTestOptions,
  async (t) => {
    const { controller, pageId, opened, fixture } = await setup(t);
    const frame = opened.frames.find((entry) => entry.name === "editor");
    assert.ok(frame?.frameId);
    const selected = await controller.execute("browser_act", {
      pageId,
      frameId: frame.frameId,
      observation: "aria",
      action: { type: "click", target: { ...role("Save"), frameId: frame.frameId } }
    });
    assert.match(selected.observation.ariaSnapshot, /Frame saved/);
    const other = await controller.execute("browser_open", { url: `${fixture.url}advanced` });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId: other.pageId,
        action: { type: "click", target: { ...role("Save"), frameId: frame.frameId } }
      }),
      error("frame_not_found")
    );
    await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Remove frame") }
    });
    await assert.rejects(
      controller.execute("browser_observe", { pageId, frameId: frame.frameId }),
      error("frame_not_found")
    );
  }
);

test(
  "viewport canvas input consumes fresh screenshot IDs, including cheap semantic actions",
  browserTestOptions,
  async (t) => {
    const { controller, pageId, opened, fixture } = await setup(t);
    const clicked = await controller.execute("browser_act", {
      pageId,
      observationId: opened.observationId,
      action: { type: "click_at", x: 50, y: 330 }
    });
    assert.match(clicked.observation.ariaSnapshot, /Canvas clicked/);
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observationId: opened.observationId,
        action: { type: "click_at", x: 50, y: 330 }
      }),
      error("stale_observation")
    );
    const dragged = await controller.execute("browser_act", {
      pageId,
      observationId: clicked.observation.observationId,
      action: { type: "drag", from: { x: 50, y: 330 }, to: { x: 180, y: 390 } }
    });
    assert.match(dragged.observation.ariaSnapshot, /Drag ended/);
    const scrolled = await controller.execute("browser_act", {
      pageId,
      observationId: dragged.observation.observationId,
      action: { type: "scroll", x: 50, y: 330, deltaX: 0, deltaY: 120 }
    });
    assert.match(scrolled.observation.ariaSnapshot, /Wheel 120/);
    await controller.execute("browser_act", {
      pageId,
      observation: "none",
      action: { type: "click", target: { ...role("Save"), nth: 0 } }
    });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observationId: scrolled.observation.observationId,
        action: { type: "click_at", x: 50, y: 330 }
      }),
      error("stale_observation")
    );
    const fresh = await controller.execute("browser_observe", { pageId });
    const other = await controller.execute("browser_open", { url: `${fixture.url}advanced` });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId: other.pageId,
        observationId: fresh.observationId,
        action: { type: "click_at", x: 50, y: 330 }
      }),
      error("stale_observation")
    );
  }
);

test(
  "coordinate credentials expire and reject changed viewport/navigation before input",
  browserTestOptions,
  async (t) => {
    const { controller, pageId, opened, fixture } = await setup(t);
    // Age the recorded capture rather than making this regression wait 30 seconds.
    controller.observations.get(pageId).at -= 30_001;
    const click = { type: "click_at", x: 50, y: 330 };
    await assert.rejects(
      controller.execute("browser_act", { pageId, observationId: opened.observationId, action: click }),
      error("stale_observation")
    );
    const fresh = await controller.execute("browser_observe", { pageId });
    const actualPage = controller.context.pages()[0];
    await actualPage.setViewportSize({ width: 900, height: 700 });
    await assert.rejects(
      controller.execute("browser_act", { pageId, observationId: fresh.observationId, action: click }),
      error("stale_observation")
    );
    const resized = await controller.execute("browser_observe", { pageId });
    assert.equal(resized.width, 900);
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observationId: resized.observationId,
        action: { ...click, x: 950 }
      }),
      error("invalid_argument")
    );
    await actualPage.goto(`${fixture.url}advanced?next=1`);
    await assert.rejects(
      controller.execute("browser_act", { pageId, observationId: resized.observationId, action: click }),
      error("stale_observation")
    );
  }
);

test(
  "navigation during screenshot feedback cannot bind old pixels to the new page",
  browserTestOptions,
  async (t) => {
    for (const operation of ["browser_observe", "browser_act"]) {
      await t.test(operation, async (t) => {
        const { controller, pageId, fixture } = await setup(t);
        const actualPage = controller.context.pages()[0];
        let captured, release;
        const screenshotCaptured = new Promise((resolve) => {
          captured = resolve;
        });
        const registration = new Promise((resolve) => {
          release = resolve;
        });
        controller.registrations.add(registration);
        const screenshot = actualPage.screenshot.bind(actualPage);
        actualPage.screenshot = async (...args) => {
          const pixels = await screenshot(...args);
          captured();
          return pixels;
        };
        t.after(() => {
          release();
          controller.registrations.delete(registration);
          actualPage.screenshot = screenshot;
        });
        const pending = controller.execute(operation, {
          pageId,
          observation: "screenshot",
          ...(operation === "browser_act"
            ? { action: { type: "click", target: { ...role("Save"), nth: 0 } } }
            : {})
        });
        const outcome = pending.then(
          (result) => ({ result }),
          (failure) => ({ failure })
        );
        await screenshotCaptured;
        // Real pixels from A have completed. Keep the registration await pending until real navigation B completes.
        await actualPage.goto(`${fixture.url}advanced?during-capture=${operation}`);
        release();
        const { result, failure } = await outcome;
        if (operation === "browser_observe") {
          assert.equal(failure?.errorCode, "observation_changed");
          assert.equal(failure.requiresObservation, true);
        } else {
          assert.equal(result.observationStatus, "failed");
          assert.equal(result.observationError, "observation_changed");
          assert.equal(result.dispatchStatus, "sent");
          assert.equal(result.requiresObservation, true);
        }
        assert.equal(controller.observations.has(pageId), false);
        await assert.rejects(
          controller.execute("browser_act", {
            pageId,
            observation: "none",
            action: { type: "click", target: { ...role("Save"), nth: 0 } }
          }),
          error("observation_required")
        );
        const fresh = await controller.execute("browser_observe", { pageId, observation: "screenshot" });
        assert.ok(fresh.observationId);
        assert.equal(fresh.requiresObservation, false);
      });
    }
  }
);

test(
  "failed explicit capture gates the backend even when the preceding action omitted feedback",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t);
    const { pageId } = await controller.execute("browser_open", { url: fixture.url });
    // Invalid frame selection fails before capture and must not gate an otherwise usable page.
    await assert.rejects(
      controller.execute("browser_observe", { pageId, frameId: "frame_missing", observation: "aria" }),
      error("frame_not_found")
    );
    const cheap = await controller.execute("browser_act", {
      pageId,
      observation: "none",
      action: { type: "click", target: role("Remove body") }
    });
    assert.equal(cheap.dispatchStatus, "sent");
    assert.equal(cheap.requiresObservation, false);
    await assert.rejects(
      controller.execute("browser_observe", { pageId, observation: "aria", timeoutMs: 100 }),
      (failure) => {
        assert.equal(failure.errorCode, "browser_failed");
        assert.equal(failure.dispatchStatus, "not_sent");
        assert.equal(failure.requiresObservation, true);
        return true;
      }
    );
    const metadata = await controller.execute("browser_observe", { pageId, observation: "none" });
    assert.equal(metadata.requiresObservation, true);
    // This invokes the shared backend directly, without any SDK object or VM-local state.
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observation: "none",
        action: { type: "navigate", url: fixture.url }
      }),
      error("observation_required")
    );
    const recovered = await controller.execute("browser_observe", { pageId, observation: "screenshot" });
    assert.equal(recovered.requiresObservation, false);
    assert.ok(recovered.observationId);
    const navigated = await controller.execute("browser_act", {
      pageId,
      observation: "none",
      action: { type: "navigate", url: fixture.url }
    });
    assert.equal(navigated.dispatchStatus, "sent");
  }
);

test(
  "sent errors and failed feedback gate backend actions until an actual observation succeeds",
  browserTestOptions,
  async (t) => {
    const { controller, fixture } = await setup(t);
    const { pageId } = await controller.execute("browser_open", { url: fixture.url });
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        action: { type: "click", target: role("Save"), expectDownload: true },
        timeoutMs: 2000
      }),
      (value) => value.dispatchStatus === "sent"
    );
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observation: "none",
        action: { type: "click", target: role("Save") }
      }),
      error("observation_required")
    );
    await controller.execute("browser_observe", { pageId, observation: "none" });
    await assert.rejects(
      controller.execute("browser_act", { pageId, action: { type: "click", target: role("Save") } }),
      error("observation_required")
    );
    await controller.execute("browser_observe", { pageId, observation: "aria" });
    const failure = await controller.execute("browser_act", {
      pageId,
      action: { type: "click", target: role("Remove body") },
      timeoutMs: 5000
    });
    assert.equal(failure.observationStatus, "failed");
    await assert.rejects(
      controller.execute("browser_act", {
        pageId,
        observation: "none",
        action: { type: "navigate", url: fixture.url }
      }),
      error("observation_required")
    );
    // A screenshot remains possible without body/ARIA; that real observation recovers the page.
    await controller.execute("browser_observe", { pageId, observation: "screenshot" });
    assert.equal(
      (
        await controller.execute("browser_act", {
          pageId,
          observation: "none",
          action: { type: "navigate", url: fixture.url }
        })
      ).dispatchStatus,
      "sent"
    );
  }
);

import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const editorIds = ["cad-shapes", "cad-source", "blender", "pptist"];

async function mountEditors(page, base) {
  await page.route("**/app.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "// isolated editor lifecycle fixture" })
  );
  // Geometry/rendering is an independent boundary. Exercise each editor's real
  // document session and its supported viewport-unavailable recovery path.
  await page.route(/\/assets\/cad\/generated\/(?:blender-)?viewport\.js$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: 'throw new Error("isolated fixture has no GPU viewport");'
    })
  );
  await page.route(/\/api\/components(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { components: [{ id: "pptist", available: true }] } })
  );
  await page.route("**/api/applications/blender/runtime", (route) =>
    route.fulfill({ json: { available: true, message: "fixture" } })
  );
  await page.route("**/assets/pptist/generated/index.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
        const channel = new URLSearchParams(location.hash.slice(1)).get("channel");
        let documentValue;
        const post = (type, payload = {}) => parent.postMessage({
          protocol: "atria-pptist-v1", channel, type, ...payload
        }, location.origin);
        addEventListener("message", ({ data }) => {
          if (data.channel !== channel) return;
          if (data.type === "load") {
            documentValue = data.document;
            post("loaded");
          } else if (data.type === "snapshot") {
            post("snapshot", { requestId: data.requestId, document: documentValue });
          }
        });
        window.editRemark = (remark, type = "change") => {
          documentValue.slides[0].remark = remark;
          post(type, { document: documentValue });
        };
        window.currentDocument = () => structuredClone(documentValue);
        post("ready");
      </script>`
    })
  );
  await page.goto(base);
  await page.clock.install();
  await page.evaluate(async () => {
    const [{ cadEditorAdapter }, { blenderEditorAdapter }, { pptistEditorAdapter }] = await Promise.all([
      import("/assets/workbench/adapters/cad-editor.js"),
      import("/assets/workbench/adapters/blender-editor.js"),
      import("/assets/workbench/adapters/pptist-editor.js")
    ]);
    const program = (source = "def main(p):\n    return []\n") => ({
      version: 2,
      engine: "cadquery",
      units: "mm",
      source,
      parameters: {}
    });
    const values = {
      "cad-shapes": { version: 1, units: "mm", parts: [] },
      "cad-source": program(),
      blender: { version: 1, projectId: "fixture-project", source: "# original", parameters: {} },
      pptist: { version: 1, slides: [{ id: "slide-1", elements: [], remark: "original" }] }
    };
    const reads = {},
      writes = [],
      records = {},
      controllers = {},
      hosts = {},
      dirty = {};
    const blockedReads = new Map();
    const api = {
      async readResource(taskId, resourceId) {
        if (taskId !== `task-${resourceId}`) throw new Error("editor lost its owning task");
        reads[resourceId] = (reads[resourceId] ?? 0) + 1;
        const result = structuredClone(records[resourceId]);
        const block = blockedReads.get(resourceId);
        if (block) {
          blockedReads.delete(resourceId);
          await new Promise((resolve) => (block.release = resolve));
        }
        return result;
      },
      async applyOperation(taskId, resourceId, operation) {
        const record = records[resourceId];
        if (operation.baseRevision !== record.resource.revision)
          throw Object.assign(new Error("fixture revision conflict"), { code: "revision_conflict" });
        writes.push({ resourceId, operation: structuredClone(operation) });
        record.resource.revision++;
        if (operation.operationType === "blender.document.edit")
          record.snapshot.content = { ...record.snapshot.content, ...structuredClone(operation.payload) };
        else
          record.snapshot.content = structuredClone(
            operation.payload.document ?? operation.payload.program ?? operation.payload.model
          );
        return { resource: structuredClone(record.resource) };
      },
      async previewResource() {
        return { scene: { objects: [], triangles: 0, warnings: [], diagnostics: "" } };
      },
      async saveSelection() {}
    };
    document.body.innerHTML = '<main id="fixture-editors"></main>';
    for (const [id, content] of Object.entries(values)) {
      records[id] = {
        resource: { resourceId: id, revision: 1, title: `${id}-original` },
        snapshot: { content },
        operations: []
      };
      const host = document.createElement("div");
      host.dataset.fixtureEditor = id;
      document.querySelector("#fixture-editors").append(host);
      hosts[id] = host;
      const adapter = id.startsWith("cad-")
        ? cadEditorAdapter
        : id === "blender"
          ? blenderEditorAdapter
          : pptistEditorAdapter;
      controllers[id] = await adapter.mount(host, {
        taskId: `task-${id}`,
        instance: { appInstanceId: `instance-${id}`, resourceIds: [id] },
        api,
        onDirtyChange: (value) => (dirty[id] = value)
      });
    }
    window.editorPollingFixture = {
      reads,
      writes,
      records,
      controllers,
      hosts,
      dirty,
      program,
      setVisible(id, visible) {
        hosts[id].hidden = !visible;
        controllers[id].setVisible?.(visible);
      },
      remote(id, content) {
        records[id].resource.revision++;
        records[id].resource.title = `${id}-remote-${records[id].resource.revision}`;
        if (content) records[id].snapshot.content = structuredClone(content);
      },
      setPageHidden(value) {
        Object.defineProperty(document, "hidden", { configurable: true, value });
        document.dispatchEvent(new Event("visibilitychange"));
      },
      blockRead(id) {
        const block = {};
        blockedReads.set(id, block);
        return block;
      },
      async unmount() {
        for (const controller of Object.values(controllers)) await controller.unmount();
      }
    };
  });
  await expect(page.locator("[data-pptist-loading]")).toBeHidden();
}

async function readCounts(page) {
  return page.evaluate(() => ({ ...window.editorPollingFixture.reads }));
}

test("mounted editors sleep while hidden and catch up immediately on tab and page visibility", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await mountEditors(page, dashboard.base);
    const loaded = await readCounts(page);
    await page.clock.runFor(6600);
    const visible = await readCounts(page);
    for (const id of editorIds) expect(visible[id], `${id} polls while visible`).toBeGreaterThan(loaded[id]);

    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      for (const id of Object.keys(f.controllers)) f.setVisible(id, false);
    });
    const hidden = await readCounts(page);
    await page.clock.runFor(9000);
    expect(await readCounts(page), "mounted hidden editors must make zero body reads").toEqual(hidden);

    for (const id of editorIds) {
      const before = await readCounts(page);
      await page.evaluate((id) => {
        const f = window.editorPollingFixture;
        f.remote(id);
        f.setVisible(id, true);
      }, id);
      await expect.poll(async () => (await readCounts(page))[id]).toBeGreaterThan(before[id]);
      await expect(page.locator(`[data-fixture-editor="${id}"]`)).toContainText(`${id}-remote-2`);
      for (const other of editorIds.filter((other) => other !== id))
        expect((await readCounts(page))[other], `${other} remains asleep`).toBe(before[other]);
      await page.evaluate((id) => window.editorPollingFixture.setVisible(id, false), id);
    }

    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      for (const id of Object.keys(f.controllers)) f.setVisible(id, true);
      f.setPageHidden(true);
    });
    const background = await readCounts(page);
    await page.clock.runFor(9000);
    expect(await readCounts(page), "background browser pages must make zero body reads").toEqual(background);
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      for (const id of ["cad-shapes", "cad-source", "pptist"]) f.setVisible(id, false);
      f.remote("blender");
      f.setPageHidden(false);
    });
    await expect(page.locator("[data-blender-title]")).toHaveText("blender-remote-3");
    const foreground = await readCounts(page);
    expect(foreground.blender).toBeGreaterThan(background.blender);
    for (const id of editorIds.filter((id) => id !== "blender")) expect(foreground[id]).toBe(background[id]);

    await page.evaluate(() => window.editorPollingFixture.unmount());
    const unmounted = await readCounts(page);
    await page.clock.runFor(9000);
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });
    expect(await readCounts(page), "disposed editors must not resume observation").toEqual(unmounted);
    console.log(JSON.stringify({ loaded, visible, hidden, background, foreground, unmounted }));
  } finally {
    await dashboard.stop();
  }
});

test("late CAD mode checks defer hidden remounts and in-flight hidden saves still finish", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await mountEditors(page, dashboard.base);
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      for (const id of ["cad-source", "blender", "pptist"]) f.setVisible(id, false);
      f.remote("cad-shapes", f.program("def main(p):\n    return [3]\n"));
      f.pendingModeRead = f.blockRead("cad-shapes");
    });
    await page.clock.runFor(2200);
    await expect
      .poll(() => page.evaluate(() => typeof window.editorPollingFixture.pendingModeRead.release))
      .toBe("function");
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      f.setVisible("cad-shapes", false);
      f.pendingModeRead.release();
    });
    const hidden = await readCounts(page);
    await page.clock.runFor(9000);
    expect(
      await readCounts(page),
      "finishing a mode read hidden must not start a new editor body load"
    ).toEqual(hidden);
    await expect(page.locator("[data-fixture-editor='cad-shapes'] .cad-program-editor")).toHaveCount(0);
    await page.evaluate(() => window.editorPollingFixture.setVisible("cad-shapes", true));
    await expect(page.locator("[data-fixture-editor='cad-shapes'] .cad-program-editor")).toHaveCount(1);
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      f.setVisible("cad-shapes", false);
      const source = f.hosts.blender.querySelector("[data-blender-source]");
      source.value = "# saved in background";
      source.dispatchEvent(new Event("input", { bubbles: true }));
      f.pendingSaveRead = f.blockRead("blender");
      f.saving = f.controllers.blender.flush();
    });
    await expect
      .poll(() => page.evaluate(() => typeof window.editorPollingFixture.pendingSaveRead.release))
      .toBe("function");
    await page.evaluate(() => window.editorPollingFixture.setPageHidden(true));
    const saving = await readCounts(page);
    await page.clock.runFor(9000);
    expect(await readCounts(page), "a pending save acknowledgement must not start observations").toEqual(
      saving
    );
    const result = await page.evaluate(async () => {
      const f = window.editorPollingFixture;
      f.pendingSaveRead.release();
      return {
        saved: await f.saving,
        source: f.records.blender.snapshot.content.source,
        dirty: f.dirty.blender
      };
    });
    expect(result).toEqual({ saved: true, source: "# saved in background", dirty: false });
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      f.setPageHidden(false);
      f.setVisible("blender", true);
    });
    await expect(page.locator("[data-blender-source]")).toHaveValue("# saved in background");
    await page.evaluate(() => window.editorPollingFixture.unmount());
  } finally {
    await dashboard.stop();
  }
});

test("hidden updates preserve drafts and explicit saves while CAD mode changes wait for visibility", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await mountEditors(page, dashboard.base);
    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      const source = f.hosts.blender.querySelector("[data-blender-source]");
      source.value = "# local draft";
      source.dispatchEvent(new Event("input", { bubbles: true }));
      for (const id of Object.keys(f.controllers)) f.setVisible(id, false);
      f.remote("blender", { ...f.records.blender.snapshot.content, source: "# remote edit" });
      f.remote("cad-shapes", f.program("def main(p):\n    return [1]\n"));
    });
    const beforeEvents = await readCounts(page);
    const accepted = await page.evaluate(async () => {
      const f = window.editorPollingFixture;
      return Promise.all(
        Object.entries(f.controllers).map(([id, controller]) =>
          controller.handleResourceEvent({
            type: "resource.updated",
            revision: f.records[id].resource.revision + 1
          })
        )
      );
    });
    expect(accepted, "hidden events are acknowledged and deferred to visibility catch-up").toEqual([
      true,
      true,
      true,
      true
    ]);
    expect(await readCounts(page), "hidden events must not read document bodies").toEqual(beforeEvents);
    await page.clock.runFor(9000);
    expect(await readCounts(page)).toEqual(beforeEvents);
    await expect(page.locator("[data-fixture-editor='cad-shapes'] .cad-program-editor")).toHaveCount(0);

    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      f.setVisible("blender", true);
      f.setVisible("cad-shapes", true);
    });
    await expect(page.locator("[data-blender-source]")).toHaveValue("# local draft");
    await expect(page.locator("[data-blender-error]")).toContainText("草稿已保留");
    await expect(page.locator("[data-fixture-editor='cad-shapes'] .cad-program-editor")).toHaveCount(1);
    await expect(page.locator("[data-fixture-editor='cad-shapes'] [data-program-source]")).toHaveValue(
      "def main(p):\n    return [1]\n"
    );

    await page.evaluate(() => {
      const f = window.editorPollingFixture;
      f.setVisible("blender", false);
      f.setVisible("cad-shapes", false);
      const source = f.hosts["cad-source"].querySelector("[data-program-source]");
      source.value = "def main(p):\n    return [2]\n";
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await page.evaluate(() => window.editorPollingFixture.controllers["cad-source"].flush())).toBe(
      true
    );
    await page
      .frameLocator("[data-pptist-frame]")
      .locator("html")
      .evaluate(() => window.editRemark("saved while hidden"));
    // PPT autosave must keep its necessary write and acknowledgement read while hidden.
    await page.clock.runFor(700);
    await expect.poll(() => page.evaluate(() => window.editorPollingFixture.writes.length)).toBe(2);
    const saved = await page.evaluate(() => ({
      cad: window.editorPollingFixture.records["cad-source"].snapshot.content.source,
      ppt: window.editorPollingFixture.records.pptist.snapshot.content.slides[0].remark,
      dirty: window.editorPollingFixture.dirty
    }));
    expect(saved.cad).toBe("def main(p):\n    return [2]\n");
    expect(saved.ppt).toBe("saved while hidden");
    expect(saved.dirty["cad-source"]).toBe(false);
    expect(saved.dirty.pptist).toBe(false);
    expect(saved.dirty.blender).toBe(true);
    const savedCounts = await readCounts(page);
    await page.clock.runFor(9000);
    expect(await readCounts(page), "saves must not wake hidden periodic reads").toEqual(savedCounts);
    await page.evaluate(() => window.editorPollingFixture.unmount());
  } finally {
    await dashboard.stop();
  }
});

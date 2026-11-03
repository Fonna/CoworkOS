import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createDashboardHandler } from "../dist/src/dashboard/routes.js";

for (const { appType, componentId, selector } of [
  { appType: "pptist", componentId: "pptist", selector: "[data-component-settings]" },
  { appType: "cad", componentId: "cadquery", selector: "[data-cad-component-settings]" }
]) {
  test(`${appType} missing component opens the selected settings card without downloading`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    let starts = 0;
    await page.route("**/api/components**", (route) => {
      if (route.request().method() === "POST") starts++;
      return route.fulfill({
        json: {
          components: [
            {
              id: componentId,
              phase: "missing",
              message: "内置组件缺失",
              enabled: true,
              available: false,
              supported: true,
              installing: false,
              dependencies: []
            }
          ]
        }
      });
    });
    try {
      await page.goto(dashboard.base);
      await page.locator("#apps-nav").click();
      await page.locator(`[data-create-app="${appType}"]`).click();
      await confirmApplicationWorkspace(page);
      const editor = page.locator("[data-app-mount]:not([hidden])");
      await expect(editor.locator("[data-component-manager]")).toHaveCount(0);
      await editor.locator(selector).click();
      const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
      await expect(settings).toBeVisible();
      const component = settings.locator(`[data-component-id="${componentId}"]`);
      await expect(component).toBeFocused();
      await expect(component.getByRole("button", { name: "安装 / 重试", exact: true })).toBeEnabled();
      await expect(settings.locator(".component-auth")).toHaveCount(0);
      expect(starts).toBe(0);
    } finally {
      await dashboard.stop();
    }
  });
}

test("a missing CadQuery runtime keeps the CAD document editable and exposes settings", async ({ page }) => {
  const dashboard = await startDashboard();
  await page.route("**/resources/*/preview", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "CadQuery 内置运行时缺失，请在设置的应用组件中修复安装" }
    })
  );
  await page.route(/\/api\/components(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        components: [
          {
            id: "cadquery",
            phase: "missing",
            enabled: true,
            available: false,
            supported: true,
            installing: false,
            dependencies: [],
            message: "内置组件缺失"
          }
        ]
      }
    })
  );
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="cad"]').click();
    await confirmApplicationWorkspace(page);
    await page.locator("[data-cad-new]").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("保留设计.cad.json");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.locator("[data-program-preview-details]").click();
    await expect(page.locator("[data-program-preview-error-text]")).toContainText("CadQuery 内置运行时缺失");
    await page.locator("[data-program-component-settings]").click();
    const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await expect(settings.locator('[data-component-id="cadquery"]')).toBeFocused();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.locator("[data-program-source-toggle]").click();
    await expect(page.locator("[data-program-source]")).toBeEditable();
    await expect(page.locator("[data-program-title]")).toHaveText("保留设计.cad.json");
  } finally {
    await dashboard.stop();
  }
});

for (const recover of [false, true]) {
  test(`the PPT workbench exposes missing iframe settings and ${recover ? "recovers after repair" : "closes safely"}`, async ({
    page
  }) => {
    const dashboard = await startDashboard();
    const fallback = await readFile(resolve("web/assets/pptist/missing.html"), "utf8");
    let available = true;
    let missing = true;
    await page.route(/\/api\/components(?:\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          components: [
            {
              id: "pptist",
              phase: available ? "ready" : "missing",
              enabled: true,
              available,
              supported: true,
              installing: false,
              dependencies: [],
              message: "PPT 编辑器状态"
            }
          ]
        }
      })
    );
    await page.route("**/assets/pptist/generated/index.html", (route) => {
      if (!missing) return route.continue();
      available = false;
      return route.fulfill({ status: 409, contentType: "text/html; charset=utf-8", body: fallback });
    });
    try {
      await page.goto(dashboard.base);
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="pptist"]').click();
      await confirmApplicationWorkspace(page);
      await page.locator("[data-pptist-new]").click();
      await page.getByRole("textbox", { name: "文件名" }).fill("保留演示文稿");
      await page.getByRole("button", { name: "创建", exact: true }).click();
      const frame = page.frameLocator("[data-pptist-frame]");
      await expect(page.locator("[data-pptist-loading]")).toBeHidden();
      await expect(page.locator("[data-pptist-retry]")).toBeVisible();
      await frame.getByRole("button", { name: "在设置中安装", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
      const component = settings.locator('[data-component-id="pptist"]');
      await expect(component).toBeFocused();
      await expect(component.getByRole("button", { name: "安装 / 重试", exact: true })).toBeEnabled();
      await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
      if (recover) {
        missing = false;
        available = true;
        await page.locator("[data-pptist-retry]").click();
        await expect(frame.locator("[data-pptist-save]")).toBeEnabled({ timeout: 30_000 });
        await expect(page.locator("[data-pptist-loading]")).toBeHidden();
        await expect(page.locator("[data-pptist-status]")).toHaveAttribute("data-state", "saved");
        await expect(page.locator("[data-pptist-status]")).not.toContainText("暂不可用");
      }
      await page.locator('[data-tab-rail] [data-close-tab][aria-label="关闭 保留演示文稿"]').click();
      await expect(page.locator("[data-pptist-frame]")).toHaveCount(0);
    } finally {
      await dashboard.stop();
    }
  });
}

test("a missing PPT iframe blocks closing while its source file has unsaved changes", async ({ page }) => {
  const dashboard = await startDashboard();
  const fallback = await readFile(resolve("web/assets/pptist/missing.html"), "utf8");
  await page.route(/\/api\/components(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { components: [{ id: "pptist", available: true }] } })
  );
  await page.route("**/assets/pptist/generated/index.html", (route) =>
    route.fulfill({ status: 409, contentType: "text/html; charset=utf-8", body: fallback })
  );
  try {
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { pptistEditorAdapter } = await import("/assets/workbench/adapters/pptist-editor.js");
      const host = document.createElement("div");
      host.dataset.pptSourceGuard = "";
      document.body.append(host);
      window.pptSourceFixture = {
        read: {
          resource: {
            revision: 2,
            title: "原文件尚未回写",
            sourceFile: { path: "original.pptx", savedRevision: 1 }
          },
          snapshot: { content: { version: 1, slides: [] } },
          operations: []
        },
        sourceSaves: 0
      };
      window.pptSourceController = await pptistEditorAdapter.mount(host, {
        instance: { resourceIds: ["fixture-presentation"] },
        taskId: "source-guard",
        api: {
          readResource: async () => structuredClone(window.pptSourceFixture.read),
          saveSourceFile: async () => {
            window.pptSourceFixture.sourceSaves++;
            return { resource: structuredClone(window.pptSourceFixture.read.resource) };
          }
        }
      });
    });
    const host = page.locator("[data-ppt-source-guard]");
    await expect(host.locator("[data-pptist-retry]")).toBeVisible();
    expect(await page.evaluate(() => window.pptSourceController.canClose())).toBe(false);
    expect(await page.evaluate(() => window.pptSourceFixture.sourceSaves)).toBe(0);
    await page.evaluate(async () => {
      window.pptSourceFixture.read.resource.sourceFile.savedRevision = 2;
      await window.pptSourceController.handleResourceEvent({ type: "resource.updated", revision: 3 });
    });
    expect(await page.evaluate(() => window.pptSourceController.canClose())).toBe(true);
  } finally {
    await page.evaluate(async () => {
      await window.pptSourceController?.unmount();
      document.querySelector("[data-ppt-source-guard]")?.remove();
    });
    await dashboard.stop();
  }
});

test("a missing PPT iframe serves a recovery page whose button reaches its parent", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "atria-ppt-missing-"));
  for (const file of [
    "pptist/missing.html",
    "pptist/missing.js",
    "pptist/missing.css",
    "workbench/component-entry.js",
    "system-theme.css"
  ]) {
    const target = join(root, "assets", file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve("web/assets", file), target);
  }
  let handler;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        '<iframe title="PPT 编辑器" src="/assets/pptist/generated/index.html"></iframe><script>document.addEventListener("atria:component-settings", (event) => { document.body.dataset.selectedComponent = event.detail.componentId; });</script>'
      );
    } else void handler(request, response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createDashboardHandler({ dashboardUrl: base, uiRoot: root });
  try {
    await page.goto(base);
    const frame = page.frameLocator('iframe[title="PPT 编辑器"]');
    await expect(frame.getByRole("heading", { name: "PPT 编辑器暂不可用" })).toBeVisible();
    await frame.getByRole("button", { name: "在设置中安装", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-selected-component", "pptist");
    expect((await page.request.get(`${base}/assets/pptist/generated/index.html`)).status()).toBe(409);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("Blender usage opens component settings, preserves recovery and never starts a download", async ({
  page
}) => {
  const dashboard = await startDashboard();
  let failed = true;
  let state = { available: false, installing: false, canInstall: false, message: "Blender 内置组件缺失" };
  let starts = 0;
  await page.route("**/api/applications/blender/runtime", (route) =>
    route.fulfill(failed ? { status: 503, json: { error: "本机服务暂不可用" } } : { json: state })
  );
  await page.route("**/api/applications/blender/install", (route) => {
    starts++;
    return route.fulfill({ status: 500, json: { error: "使用位置不能直接安装" } });
  });
  await page.route("**/api/components", (route) =>
    route.fulfill({
      json: {
        components: [
          {
            id: "blender",
            phase: state.available ? "ready" : "missing",
            enabled: true,
            available: state.available,
            supported: true,
            installing: false,
            dependencies: [],
            message: state.message
          }
        ]
      }
    })
  );
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await expect(page.locator("#apps-panel [data-blender-install]")).toHaveCount(0);
    await page.locator('[data-create-app="blender"]').click();
    await confirmApplicationWorkspace(page);
    const runtime = page.locator("[data-app-mount]:not([hidden]) [data-blender-install]");
    await expect(runtime).toContainText("本机服务暂不可用");
    failed = false;
    await runtime.getByRole("button", { name: "重新检查", exact: true }).click();
    await expect(runtime).toContainText("Blender 内置组件缺失");
    await runtime.getByRole("button", { name: "在设置中安装", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await expect(settings).toBeVisible();
    const component = settings.locator('[data-component-id="blender"]');
    await expect(component).toBeFocused();
    await expect(component.getByRole("button", { name: "安装 / 重试", exact: true })).toBeEnabled();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    state = { ...state, available: true, message: "Blender 可用" };
    await page.evaluate(() => document.dispatchEvent(new Event("atria:components-changed")));
    await expect(runtime).toHaveAttribute("data-ready", "true");
    await expect(runtime).toBeHidden();
    await expect(runtime.locator("[data-install-button]")).toBeHidden();
    await page.reload();
    await expect(runtime).toHaveAttribute("data-ready", "true");
    await expect(runtime).toBeHidden();
    expect(starts).toBe(0);
  } finally {
    await dashboard.stop();
  }
});

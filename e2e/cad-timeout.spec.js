import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("native timeout retries raise 180 to 300 to 600 seconds and retain the model at the limit", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const budgets = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = page.locator("[data-app-mount]:not([hidden])");
  const q = (selector) => editor.locator(selector);
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="cad"]').click();
    await confirmApplicationWorkspace(page);
    await page.locator("[data-cad-new]").click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("超时恢复.cad.json");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });
    await expect(q("[data-program-budget]")).toHaveValue("180000");
    await expect(q("[data-program-budget] option")).toHaveText([
      "20 秒",
      "60 秒",
      "180 秒",
      "300 秒",
      "600 秒"
    ]);
    await page.route("**/preview", async (route) => {
      const body = route.request().postDataJSON();
      budgets.push(body.options.timeoutMs);
      if (budgets.length <= 3)
        return route.fulfill({
          status: 422,
          json: { error: { code: "invalid_operation", message: "CAD 计算超时；源码已保留，可增加预算重试" } }
        });
      await route.continue();
    });
    await q("[data-program-file]").setInputFiles("test/fixtures/cad-inline-four.py");
    await expect(q("[data-program-retry]")).toHaveText("延长时限并重试");
    const before = await q("[data-program-source]").inputValue();
    await q("[data-program-retry]").click();
    await expect(q("[data-program-budget]")).toHaveValue("300000");
    await expect(q("[data-program-retry]")).toHaveText("延长时限并重试");
    await expect(q("[data-program-source]")).toHaveValue(before);
    await q("[data-program-retry]").click();
    await expect(q("[data-program-budget]")).toHaveValue("600000");
    await expect(q("[data-program-retry]")).toHaveText("重试");
    await expect(q("[data-program-source]")).toHaveValue(before);
    expect(budgets).toEqual([180000, 300000, 600000]);
    await q("[data-program-retry]").click();
    await expect(q("[data-program-count]")).toHaveText("21", { timeout: 30000 });
    expect(budgets).toEqual([180000, 300000, 600000, 600000]);
    await expect(q("[data-program-budget]")).toHaveValue("600000");
    await expect(q("[data-program-source]")).toHaveValue(before);
    await expect(q("[data-program-error]")).toBeHidden();
    await q("[data-program-play]").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-playing", "true");
    await expect.poll(() => q("[data-cad-viewport]").getAttribute("data-motion-time")).not.toBe("0.0000");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("a native queue timeout retries at 180 seconds and preserves the source", async ({ page }) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const budgets = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator("[data-app-mount]:not([hidden])");
  const q = (selector) => editor.locator(selector);
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="cad"]').click();
    await confirmApplicationWorkspace(page);
    await page.locator("[data-cad-new]").click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("排队恢复.cad.json");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });
    await page.route("**/preview", async (route) => {
      const body = route.request().postDataJSON();
      budgets.push(body.options.timeoutMs);
      if (budgets.length === 1)
        return route.fulfill({
          status: 422,
          json: {
            error: { code: "invalid_operation", message: "CAD 计算排队超时，请稍后重试；源码已保留" }
          }
        });
      await route.continue();
    });
    await q("[data-program-file]").setInputFiles("test/fixtures/cad-inline-four.py");
    await q("[data-program-preview-details]").click();
    await expect(q("[data-program-preview-error-text]")).toContainText("排队超时");
    await q("[data-program-inspector-close]").click();
    await expect(q("[data-program-retry]")).toHaveText("重试");
    await expect(q("[data-program-budget]")).toHaveValue("180000");
    const before = await q("[data-program-source]").inputValue();
    await q("[data-program-retry]").click();
    await expect(q("[data-program-count]")).toHaveText("21", { timeout: 30000 });
    expect(budgets).toEqual([180000, 180000]);
    await expect(q("[data-program-budget]")).toHaveValue("180000");
    await expect(q("[data-program-source]")).toHaveValue(before);
    await expect(q("[data-program-error]")).toBeHidden();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

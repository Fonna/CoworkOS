import { newPresentation, presentationSave, openPresentationSlideImport } from "./pptist-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("browsing a table does not save rendered height or invalidate agent revisions", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("表格浏览不写入");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(page.locator("[data-app-mount]:not([hidden]) [data-pptist-loading]")).toBeHidden();
    const table = {
      id: "table",
      type: "table",
      left: 80,
      top: 180,
      width: 500,
      height: 160,
      rotate: 0,
      colWidths: [0.5, 0.5],
      cellMinHeight: 40,
      outline: { width: 1, color: "#999999", style: "solid" },
      data: [
        ["名称", "数值"],
        ["甲", "12"]
      ].map((row, r) => row.map((text, c) => ({ id: `c${r}${c}`, text, colspan: 1, rowspan: 1 })))
    };
    await openPresentationSlideImport(page);
    await frame.locator('input[accept=".json"]').setInputFiles({
      name: "table.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          width: 1000,
          height: 562.5,
          slides: [
            { id: "first", elements: [] },
            { id: "second", elements: [table] }
          ]
        })
      )
    });
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2);
    await presentationSave(page).click();
    const { tabs } = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = tabs.find((t) => t.resourceId);
    const read = async () =>
      (
        await (
          await page.request.get(
            `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`
          )
        ).json()
      ).snapshot;
    await page.waitForTimeout(1000);
    const before = await read();
    await frame.locator(".thumbnail-item").nth(1).click();
    await expect(frame.locator(".canvas table")).toContainText("名称");
    // Let native layout/ResizeObserver run, then explicitly flush any local draft.
    await frame
      .locator(".canvas table")
      .evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await presentationSave(page).click();
    // Allow the debounced autosave and its round trip to settle.
    await page.waitForTimeout(1000);
    const after = await read();
    expect(after.content.slides[1].elements[0].height).toBe(160);
    expect(after.revision).toBe(before.revision);
  } finally {
    await dashboard.stop();
  }
});

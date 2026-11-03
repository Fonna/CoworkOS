import { presentationSave, presentationStatus } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { quotedFontTablePptx } from "../test/fixtures/pptx-quoted-fonts.mjs";

test("PPT body undo and redo survive draft persistence and explicit saving", async ({ page }) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await page.locator("[data-local-file]").setInputFiles({
      name: "undo-body.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: await quotedFontTablePptx()
    });
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    const text = frame.locator('.canvas .ProseMirror[contenteditable="true"]').first();
    const undo = frame.locator('[aria-label="撤销（Ctrl + Z）"]');
    const redo = frame.locator('[aria-label="重做（Ctrl + Y）"]');
    const status = presentationStatus(page);
    await expect(text).toContainText("Quoted font table");
    await text.fill("保存后仍可撤销的正文");
    // Let both the history coalescing and recovery-draft debounce complete.
    await page.waitForTimeout(1500);
    await expect(undo).toBeEnabled();
    await presentationSave(page).click();
    await expect(status).toHaveAttribute("data-state", "saved");
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(frame.locator(".canvas")).toContainText("Quoted font table");
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(frame.locator(".canvas")).toContainText("保存后仍可撤销的正文");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

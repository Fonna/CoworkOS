import { presentationSave, presentationStatus } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { quotedFontTablePptx } from "../test/fixtures/pptx-quoted-fonts.mjs";

test("embedded PPT chrome follows appearance without recoloring the document or losing edits", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await page.locator("[data-local-file]").setInputFiles({
      name: "appearance.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: await quotedFontTablePptx()
    });
    const frame = page.frameLocator('iframe[title="PPT 演示文稿编辑器"]');
    const text = frame.locator('.canvas .ProseMirror[contenteditable="true"]').first();
    await expect(text).toContainText("Quoted font table");
    expect(
      await frame.locator(".canvas-tool").evaluate((element) => element.getBoundingClientRect().height)
    ).toBeLessThanOrEqual(44);
    expect(
      await frame.locator(".editor-command-bar").evaluate((element) => element.getBoundingClientRect().height)
    ).toBeLessThanOrEqual(44);
    await text.fill("主题切换保留正文");
    const background = await frame.locator(".viewport-background").getAttribute("style");
    const artworkColor = await frame
      .locator(".viewport-background")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    for (const theme of ["dark", "light", "dark"]) {
      await page.locator("#user-menu-button").click();
      await page.locator("#appearance-select").selectOption(theme);
      await page.locator("#profile-close").click();
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator(".canvas-tool")).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(32, 32, 32)" : "rgb(255, 255, 255)"
      );
      await expect(frame.locator(".canvas")).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(22, 22, 22)" : "rgb(243, 243, 243)"
      );
      await expect(frame.locator(".viewport-background")).toHaveAttribute("style", background);
      await expect(frame.locator(".viewport-background")).toHaveCSS("background-color", artworkColor);
      await expect(text).toHaveText("主题切换保留正文");
      await page.screenshot({ path: test.info().outputPath(`${theme}-ppt-editor.png`), fullPage: true });
    }
    const undo = frame.getByRole("button", { name: "撤销（Ctrl + Z）", exact: true });
    const redo = frame.getByRole("button", { name: "重做（Ctrl + Y）", exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(frame.locator(".canvas")).toContainText("Quoted font table");
    await redo.click();
    await expect(text).toHaveText("主题切换保留正文");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    await page.reload();
    await expect(text).toHaveText("主题切换保留正文");
  } finally {
    await dashboard.stop();
  }
});

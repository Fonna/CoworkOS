import { newPresentation, presentationSave, presentationStatus } from "./pptist-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("manual save confirms both unchanged and edited presentations", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("保存反馈");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const mount = page.locator("[data-app-mount]:not([hidden])");
    const save = presentationSave(page);
    const status = presentationStatus(page);
    const frame = page.frameLocator("[data-app-mount]:not([hidden]) iframe");
    await expect(mount.locator("[data-pptist-loading]")).toBeHidden();
    await expect(status).toHaveAttribute("data-state", "saved");
    const initial = await status.innerText();
    await save.click();
    await expect(save).toHaveText("已保存");
    await expect(status).toHaveText(initial);
    await expect(save).toBeEnabled();
    await frame.locator(".remark .ProseMirror").fill("手动保存后的备注");
    await save.click();
    await expect(save).toHaveText("已保存");
    await page.reload();
    await expect(frame.locator(".remark .ProseMirror")).toContainText("手动保存后的备注");
    await frame.locator(".remark .ProseMirror").fill("快捷键保存后的备注");
    await frame.locator(".remark .ProseMirror").press("ControlOrMeta+s");
    await expect(save).toHaveText("已保存");
    await page.reload();
    await expect(frame.locator(".remark .ProseMirror")).toContainText("快捷键保存后的备注");
  } finally {
    await dashboard.stop();
  }
});

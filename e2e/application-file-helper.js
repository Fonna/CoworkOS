import { expect } from "@playwright/test";

/** Use the document's file menu rather than reaching into a hidden action. */
export async function openApplicationFileMenu(page) {
  const presentation = page.locator("[data-app-mount]:not([hidden]) [data-pptist-frame]");
  if (await presentation.count()) {
    const editor = page.frameLocator("[data-app-mount]:not([hidden]) [data-pptist-frame]");
    const menu = editor.locator("[data-pptist-file-panel]");
    if (!(await menu.isVisible()))
      await editor.getByRole("button", { name: "文件操作", exact: true }).click();
    await expect(menu).toBeVisible();
    return menu;
  }
  const panel = page.locator("[data-application-file-panel]:visible");
  if (!(await panel.count())) await page.locator("[data-application-file-menu]:visible").click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function openSaveCopy(page) {
  const panel = await openApplicationFileMenu(page);
  await panel.locator('[data-application-save-copy], [data-pptist-command="save-copy"]').click();
}

import { expect } from "@playwright/test";

export function presentationFrame(page) {
  return page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
}

export function presentationSave(page) {
  return presentationFrame(page).locator("[data-pptist-save]");
}

export function presentationStatus(page) {
  return presentationFrame(page).locator("[data-pptist-status]");
}

/** Exercise the visible embedded menu, leaving document lifecycle to the host. */
export async function openPresentationFileMenu(page) {
  const frame = presentationFrame(page);
  const trigger = frame.getByRole("button", { name: "文件操作", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(frame.locator('[data-pptist-command="new"]')).toBeVisible();
  return frame;
}

export async function presentationCommand(page, command) {
  const frame = await openPresentationFileMenu(page);
  await frame.locator(`[data-pptist-command="${command}"]`).click();
}

export async function openPresentationSlideImport(page) {
  const frame = await openPresentationFileMenu(page);
  const details = frame.locator("details.import-slides");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  await expect(frame.getByRole("button", { name: "插入 PPTX 幻灯片", exact: true })).toBeVisible();
  return frame;
}

export async function newPresentation(page) {
  const empty = page.locator(".pptist-empty:visible [data-pptist-new]");
  await expect
    .poll(async () => (await empty.isVisible()) || (await presentationSave(page).isVisible()))
    .toBe(true);
  if (await empty.isVisible()) await empty.click();
  else await presentationCommand(page, "new");
}

export async function openPresentationInsertMenu(page) {
  const frame = presentationFrame(page);
  const trigger = frame.getByRole("button", { name: "插入", exact: true });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(frame.getByRole("button", { name: "插入文字", exact: true })).toBeVisible();
  return frame;
}

export async function insertPresentationElement(page, type) {
  const frame = await openPresentationInsertMenu(page);
  await frame.getByRole("button", { name: `插入${type}`, exact: true }).click();
}

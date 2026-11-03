import { presentationSave, presentationFrame } from "./pptist-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("desktop-opened PPTX saves to its original location, persists across reload and refuses external overwrite", async ({
  page
}) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const directory = join(dashboard.root, "outside-documents");
  await mkdir(directory);
  const path = join(directory, "客户方案.pptx");
  const deck = new PptxGenJS();
  deck.addSlide().addText("在原位置编辑", { x: 1, y: 1, w: 6, h: 1 });
  const original = await deck.write({ outputType: "nodebuffer" });
  await writeFile(path, original);
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await expect(page.locator("[data-local-open]:visible")).toBeVisible();
    // The actual desktop bridge returns the OS-selected File's native path.
    await page.evaluate((path) => {
      window.bookmanDesktop = { pathForFile: () => path };
    }, path);
    await page.locator("[data-local-file]").setInputFiles(path);
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    const save = presentationSave(page);
    const status = presentationFrame(page).locator("[data-pptist-status]");
    await expect(frame.locator(".canvas")).toContainText("在原位置编辑");
    await expect(save).toBeEnabled();
    await expect.poll(() => save.getAttribute("title")).toContain(`保存到原文件：${await realpath(path)}`);
    expect(await readFile(path)).toEqual(original);
    await save.click();
    await expect(save).toHaveText("已保存");
    expect(await readFile(path)).toEqual(original);
    await frame.locator(".remark .ProseMirror").fill("这条备注直接保存到原PPTX");
    await save.click();
    await expect(save).toHaveText("已保存");
    const saved = await JSZip.loadAsync(await readFile(path));
    expect(await saved.file("ppt/notesSlides/notesSlide1.xml").async("string")).toContain(
      "这条备注直接保存到原PPTX"
    );
    await expect(status).toContainText("已保存到原文件");
    await page.reload();
    await expect(frame.locator(".remark .ProseMirror")).toContainText("这条备注直接保存到原PPTX");
    await expect(save).toBeEnabled();
    await expect.poll(() => save.getAttribute("title")).toContain(`保存到原文件：${await realpath(path)}`);
    await writeFile(path, "外部软件修改后的内容");
    await frame.locator(".remark .ProseMirror").fill("保留我的未保存草稿");
    await save.click();
    await expect(status).toContainText("原文件已被其他软件修改");
    await expect(frame.locator(".remark .ProseMirror")).toContainText("保留我的未保存草稿");
    expect(await readFile(path, "utf8")).toBe("外部软件修改后的内容");
  } finally {
    await dashboard.stop();
  }
});

test("desktop-opened Markdown writes the original file instead of requiring an export", async ({ page }) => {
  const dashboard = await startDashboard();
  const path = join(dashboard.root, "outside.md");
  await writeFile(path, "# 原文件");
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await confirmApplicationWorkspace(page);
    await expect(page.locator("[data-local-open]:visible")).toBeVisible();
    await page.evaluate((path) => {
      window.bookmanDesktop = { pathForFile: () => path };
    }, path);
    await page.locator("[data-local-file]").setInputFiles(path);
    const input = page.locator("[data-editor-input]:visible");
    await expect(input).toHaveValue("# 原文件");
    await input.fill("# 修改直接写回原文件");
    await page.locator("[data-editor-save]:visible").click();
    await expect.poll(() => readFile(path, "utf8")).toBe("# 修改直接写回原文件");
    await page.reload();
    await expect(input).toHaveValue("# 修改直接写回原文件");
  } finally {
    await dashboard.stop();
  }
});

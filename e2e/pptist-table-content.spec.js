import {
  newPresentation,
  presentationSave,
  presentationStatus,
  presentationCommand,
  openPresentationSlideImport
} from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { styleDeck } from "../test/fixtures/pptist-style.mjs";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";

test("table rich text is filtered without losing styles and remains editable after reopening", async ({
  page
}) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("表格富文本兼容性");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator('iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    const deck = styleDeck();
    deck.slides[2].elements[1].data[0][0].text =
      '<span style="font-size:24.5px; color:#F59B45" data-layout="review"><b>季度 &amp; 预算</b></span><button type="button">说明</button><br>下一行';
    deck.slides[2].elements[1].data[1][0].text = "价格 <20 & >10";
    await openPresentationSlideImport(page);
    await frame.locator('input[accept=".json"]').setInputFiles({
      name: "styled-table.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(deck))
    });
    await expect(frame.locator(".thumbnail-item")).toHaveCount(3);
    await frame.locator(".thumbnail-item").nth(2).click();
    const cell = frame.locator(".canvas .editable-element-table .cell-text").first();
    await expect(cell).toContainText("季度 & 预算");
    await expect(cell).toContainText("说明");
    await expect(cell.locator("button")).toHaveCount(0);
    await expect(cell.locator("[data-layout]")).toHaveCount(0);
    await expect(cell.locator("b")).toHaveCount(1);
    await expect(cell.locator("span")).toHaveCSS("font-size", "24.5px");
    await expect(cell.locator("span")).toHaveCSS("color", "rgb(245, 155, 69)");
    const save = async () => {
      await presentationSave(page).click();
      await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    };
    await save();
    const { tabs, activeTabId } = await (
      await page.request.get(`${dashboard.base}/api/workbench/tabs`)
    ).json();
    const tab = tabs.find((entry) => entry.tabId === activeTabId);
    const snapshot = async () =>
      (
        await (
          await page.request.get(
            `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`
          )
        ).json()
      ).snapshot.content;
    const imported = (await snapshot()).slides[2].elements.find((element) => element.type === "table");
    expect(imported.data[0][0].text).toContain("<b>季度 &amp; 预算</b>");
    expect(imported.data[0][0].text).not.toMatch(/button|data-layout/);
    expect(imported.data[0][0].style).toEqual(deck.slides[2].elements[1].data[0][0].style);

    await presentationCommand(page, "export");
    const download = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
    const zip = await JSZip.loadAsync(await readFile(await (await download).path()));
    const exported = await zip.file("ppt/slides/slide3.xml").async("string");
    expect(exported).toContain("季度 &amp; 预算");
    expect(exported).toContain("价格 &lt;20 &amp; &gt;10");
    expect(exported).not.toMatch(/&amp;(?:amp|lt|gt);|&lt;(?:span|b|br)/);
    expect(exported).toMatch(/<a:rPr[^>]*sz="1764"[^>]*b="1"/);
    expect(exported).toContain('<a:srgbClr val="F59B45"');
    await frame.getByRole("button", { name: "关闭", exact: true }).click();

    await frame.locator(".canvas .editable-element-table .table-mask").dblclick();
    await frame.locator('.canvas .editable-element-table [data-cell-index="0_0"]').click();
    const editor = frame.locator(".canvas .custom-textarea").first();
    await expect(editor).toBeVisible();
    await expect(editor.locator("b")).toHaveCount(1);
    await editor.fill("人工编辑中文 👩🏽‍💻");
    await frame.locator(".remark .ProseMirror").click();
    await save();
    expect(
      (await snapshot()).slides[2].elements.find((element) => element.type === "table").data[0][0].text
    ).toContain("人工编辑中文 👩🏽‍💻");
    await page.reload();
    await expect(frame.locator(".thumbnail-item")).toHaveCount(3);
    await frame.locator(".thumbnail-item").nth(2).click();
    await expect(cell).toContainText("人工编辑中文 👩🏽‍💻");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

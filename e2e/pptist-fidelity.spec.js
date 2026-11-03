import {
  newPresentation,
  presentationSave,
  presentationStatus,
  presentationCommand,
  openPresentationSlideImport
} from "./pptist-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { styleDeck } from "../test/fixtures/pptist-style.mjs";
import { exportPptx } from "../dist/src/software/pptist/export.js";
import { normalizePresentation } from "../dist/src/software/pptist/model.js";

test("dark chart/table styles and one-line page numbers survive both PPTX export paths", async ({
  page
}, testInfo) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    const create = async (name) => {
      await newPresentation(page);
      await page.getByRole("textbox", { name: "文件名" }).fill(name);
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await expect(frame.locator(".thumbnail-item")).toHaveCount(1);
    };
    const upload = async (accept, bytes) => {
      await openPresentationSlideImport(page);
      await frame.locator(`input[accept="${accept}"]`).setInputFiles({
        name: "source" + accept,
        mimeType: "application/octet-stream",
        buffer: Buffer.from(bytes)
      });
      await expect(frame.locator(".thumbnail-item")).toHaveCount(3);
    };
    const save = async () => {
      await presentationSave(page).click();
      await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    };
    const snapshot = async () => {
      await save();
      const { tabs, activeTabId } = await (
        await page.request.get(dashboard.base + "/api/workbench/tabs")
      ).json();
      const tab = tabs.find((t) => t.tabId === activeTabId);
      return (
        await (
          await page.request.get(
            `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`
          )
        ).json()
      ).snapshot.content;
    };
    await create("原始深色稿");
    await upload(".json", JSON.stringify(styleDeck()));
    const pageText = frame
      .locator(".canvas .editable-element-text")
      .filter({ hasText: "01 / 03" })
      .locator("p");
    expect(
      await pageText.evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      })
    ).toBe(1);
    await expect(frame.locator(".remark")).toContainText("人工备注必须保留");
    await presentationCommand(page, "export");
    const download = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
    const uiBytes = await readFile(await (await download).path());
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    const headless = await exportPptx(normalizePresentation(styleDeck()), "headless");
    for (const [name, bytes] of [
      ["聊天导出", headless],
      ["编辑器导出", uiBytes]
    ]) {
      await create(name);
      await upload(".pptx", bytes);
      const doc = await snapshot();
      const chart = doc.slides[1].elements.find((e) => e.type === "chart");
      const table = doc.slides[2].elements.find((e) => e.type === "table");
      const title = doc.slides[0].elements
        .map((e) => (e.type === "text" ? e : e.text))
        .find((e) => e?.content.replace(/<[^>]*>/g, "").includes("咖啡门店"));
      expect(title, JSON.stringify(doc.slides[0].elements)).toBeTruthy();
      [2, 4, 6, 8].forEach((value, index) => expect(title.inset[index]).toBeCloseTo(value * 0.96, 1));
      expect(chart.textColor.toUpperCase()).toBe("#FFFFFF");
      expect(chart.options).toMatchObject({ showLegend: false, showLabel: true });
      expect(chart.data.legends).toEqual(["营收（万元）"]);
      expect(table.data[0][0].style.bold).toBe(true);
      expect(Boolean(table.data[1][1].style.bold)).toBe(false);
      expect(table.data[0][0].style.backcolor.toUpperCase()).toBe("#9C4D10");
      expect(table.data[1][0].style.backcolor.toUpperCase()).toBe("#1D3855");
      expect(parseFloat(table.data[0][0].style.fontsize)).toBeCloseTo(23.52, 1);
      await frame.locator(".thumbnail-item").nth(1).click();
      await expect(frame.locator(".canvas .chart svg")).toBeVisible();
      expect(
        await frame
          .locator(".canvas .chart svg text")
          .evaluateAll((es) => es.filter((e) => e.textContent === "Q1").map((e) => e.getAttribute("fill")))
      ).toContain("#FFFFFF");
      await page.screenshot({ path: testInfo.outputPath(name + "-chart.png") });
      await frame.locator(".thumbnail-item").nth(2).click();
      await page.screenshot({ path: testInfo.outputPath(name + "-table.png") });
    }
    // The exporter may use scheme colors, arbitrary part names and a slide order
    // different from ZIP order. The metadata must stay attached to its chart.
    const zip = await JSZip.loadAsync(headless);
    for (const part of zip.file(/^ppt\/charts\/chart\d+\.xml$/))
      zip.file(
        part.name,
        (await part.async("string")).replaceAll('<a:srgbClr val="FFFFFF"/>', '<a:schemeClr val="lt1"/>')
      );
    const xml = await zip.file("ppt/presentation.xml").async("string");
    zip.file(
      "ppt/presentation.xml",
      xml.replace(
        /<p:sldIdLst>(.*?)<\/p:sldIdLst>/s,
        (_whole, ids) =>
          "<p:sldIdLst>" +
          ids
            .match(/<p:sldId\b[^>]*\/>/g)
            .reverse()
            .join("") +
          "</p:sldIdLst>"
      )
    );
    await create("主题颜色与倒序");
    await upload(".pptx", await zip.generateAsync({ type: "nodebuffer" }));
    const doc = await snapshot();
    expect(doc.slides[0].elements.some((e) => e.type === "table")).toBe(true);
    expect(doc.slides[1].elements.find((e) => e.type === "chart").textColor).toBe("#FFFFFF");
    expect(doc.slides[2].remark).toContain("人工备注必须保留");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

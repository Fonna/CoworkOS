import { presentationSave, presentationStatus, presentationCommand } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { quotedFontTablePptx } from "../test/fixtures/pptx-quoted-fonts.mjs";

for (const legacy of [true, false]) {
  test(`PPTX drop preserves a complete table with ${legacy ? "legacy quoted" : "normal"} fonts`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const dashboard = await startDashboard({ defaultProject: false });
    const open = async (body) => {
      if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="pptist"]').click();
      await expect(page.locator("[data-pptist-new]:visible")).toBeVisible();
      await page.locator(".pptist-empty:visible").evaluate(
        (target, bytes) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(bytes)], "table.pptx"));
          target.dispatchEvent(
            new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true })
          );
        },
        [...body]
      );
    };
    const snapshot = async () => {
      const { tabs, activeTabId } = await (
        await page.request.get(`${dashboard.base}/api/workbench/tabs`)
      ).json();
      const tab = tabs.find((entry) => entry.tabId === activeTabId);
      return (
        await (
          await page.request.get(
            `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`
          )
        ).json()
      ).snapshot.content;
    };
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    const completeTable = async () => {
      await expect(frame.locator(".canvas")).toContainText("Cell 5:3", { timeout: 30_000 });
      const table = (await snapshot()).slides[0].elements.find((element) => element.type === "table");
      expect(table.data.map((row) => row.length)).toEqual([3, 3, 3, 3, 3]);
      expect(table.data.flat().every((cell) => cell.style.fontname.includes("PingFang SC"))).toBe(true);
      expect(table.data.flat().map((cell) => cell.text.replace(/\u00a0/g, " "))).toEqual(
        Array.from({ length: 5 }, (_, row) =>
          Array.from({ length: 3 }, (_, column) => `Cell ${row + 1}:${column + 1}`)
        ).flat()
      );
      for (const [index, width] of [0.22, 0.35, 0.43].entries())
        expect(table.colWidths[index]).toBeCloseTo(width, 5);
    };
    try {
      await page.goto(dashboard.base);
      await open(await quotedFontTablePptx({ legacy }));
      await completeTable();
      await presentationSave(page).click();
      await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
      await page.reload();
      await completeTable();
      await presentationCommand(page, "export");
      const download = page.waitForEvent("download");
      await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
      const exported = await readFile(await (await download).path());
      const zip = await JSZip.loadAsync(exported);
      const xml = await Promise.all(
        Object.values(zip.files)
          .filter((file) => file.name.endsWith(".xml"))
          .map(async (file) => ({ name: file.name, text: await file.async("string") }))
      );
      expect(
        await page.evaluate(
          (files) =>
            files
              .filter(({ text }) =>
                new DOMParser().parseFromString(text, "application/xml").querySelector("parsererror")
              )
              .map(({ name }) => name),
          xml
        )
      ).toEqual([]);
      await frame.getByRole("button", { name: "关闭", exact: true }).click();
      await open(exported);
      await completeTable();
    } finally {
      await dashboard.stop();
    }
  });
}

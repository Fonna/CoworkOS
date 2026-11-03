import { openCadProgram, openCadView } from "./cad-editor-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("assembly inspection, surface measurement and a downloadable motion viewport share the same design", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(150000);
  page.setDefaultTimeout(10000);
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = page.locator("[data-app-mount]:not([hidden])"),
    q = (s) => editor.locator(s);
  const group = () => q('[data-program-select-group="assembly:/engine/pistons"]');
  const menu = (name) => editor.getByRole("menuitem", { name, exact: true });
  async function setPartsOpen(open) {
    if (open && (await q("[data-program-view-panel]").isVisible()))
      await q("[data-program-view-close]").click();
    if ((await q("[data-program-parts-panel]").isVisible()) !== open)
      await q("[data-program-parts-toggle]").click();
    if (open) await expect(q("[data-program-parts-panel]")).toBeVisible();
    else await expect(q("[data-program-parts-panel]")).toBeHidden();
  }
  async function rightClickGroup() {
    await group().click({ button: "right" });
    await expect(q(".cad-context-menu")).toBeVisible();
  }
  try {
    await openCadProgram(page, dashboard, "装配检查.cad.json");
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });
    await q("[data-program-file]").setInputFiles("test/fixtures/cad-inline-four.py");
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "21", { timeout: 30000 });
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json(),
      tab = tabs.tabs.find((t) => t.resourceId),
      url = `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`,
      before = await (await page.request.get(url)).json();
    await setPartsOpen(true);
    await q("[data-program-tree-pin]").check();
    await group().click();
    await expect(q("[data-program-parts-panel]")).toBeVisible();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-selected", "assembly:/engine/pistons");
    await expect
      .poll(async () => (await (await page.request.get(url)).json()).selection?.schema)
      .toBe("cad.assembly-node/v1");
    const selected = (await (await page.request.get(url)).json()).selection;
    expect(selected.data.path).toBe("/engine/pistons");
    expect(selected.summary).toContain("4 个计算实体");
    const visibility = () => q('[data-program-group-visible="assembly:/engine/pistons"]');
    await visibility().uncheck();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "17");
    await visibility().check();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "21");
    await q('[data-program-select][title="/engine/pistons/piston_1"]')
      .locator("..")
      .locator("input")
      .uncheck();
    expect(await visibility().evaluate((e) => e.indeterminate)).toBe(true);
    await visibility().check();
    await rightClickGroup();
    await menu("其他零件淡化").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "21");
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-focused-parts", "4");
    await rightClickGroup();
    await menu("隔离选中").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "4");
    await rightClickGroup();
    await menu("显示全部零件").click();
    await rightClickGroup();
    await menu("隐藏其他零件").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "4");
    await rightClickGroup();
    await menu("显示全部零件").click();
    await rightClickGroup();
    await menu("复制引用").click();
    await expect(q("[data-inspect-notice]")).toContainText(/已复制零件引用|引用已选中/);
    await expect(q("[data-inspect-reference]")).toHaveValue(
      new RegExp(`${tab.resourceId}@r.*#/engine/pistons`)
    );
    await setPartsOpen(true);
    await q('[data-inspect-expand="false"]').click();
    await expect(q('[data-program-branch="/engine"]')).not.toHaveAttribute("open", "");
    await q('[data-inspect-expand="true"]').click();
    await expect(group()).toBeVisible();
    await setPartsOpen(false);
    await openCadView(editor);
    await q("[data-inspect-explode-mode]").selectOption("groups");
    await q("[data-inspect-explode-number]").fill("54");
    await expect(q("[data-program-explode]")).toHaveValue("54");
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-explode-mode", "groups");
    await q(".cad-multi-section summary").click();
    await q('[data-inspect-axis="x"] [data-inspect-section-enabled]').check();
    await q('[data-inspect-axis="y"] [data-inspect-section-enabled]').check();
    await q('[data-inspect-axis="y"] [data-inspect-section-invert]').check();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-sections", "2");
    await q("[data-program-reset-view]").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-sections", "0");
    await setPartsOpen(true);
    const rod = q('[data-program-select][title="/engine/rods/rod_1"]');
    await rod.click({ button: "right" });
    await menu("隔离选中").click();
    await setPartsOpen(false);
    await q("[data-program-view]").selectOption("front");
    if (!(await q(".cad-inspector").isVisible())) await q("[data-program-inspector-toggle]").click();
    await q("[data-inspect-fit-selected]").click();
    await openCadView(editor);
    await q('[data-inspect-nav="measure"]').click();
    const canvas = q("[data-cad-viewport] canvas"),
      rect = await canvas.boundingBox();
    await canvas.click({ position: { x: rect.width * 0.495, y: rect.height * 0.48 } });
    await canvas.click({ position: { x: rect.width * 0.505, y: rect.height * 0.52 } });
    await expect(q("[data-inspect-measure-result]")).toContainText(/\d+\.\d{3} mm.*ΔX.*ΔY.*ΔZ/);
    await openCadView(editor);
    await q("[data-program-reset-view]").click();
    await expect(q("[data-inspect-measure-result]")).toBeHidden();
    await q('[data-inspect-zoom="0.833333"]').click();
    await expect(q("[data-inspect-zoom-label]")).toHaveText("120%");
    await q("[data-inspect-zoom-reset]").click();
    await expect(q("[data-inspect-zoom-label]")).toHaveText("100%");
    await q("[data-program-view-close]").click();
    await editor.getByRole("button", { name: "沿 Z 轴观察", exact: true }).click();
    await q("[data-program-view]").selectOption("iso");
    await openCadView(editor);
    await q("[data-inspect-simulation]").click();
    await expect(q(".cad-simulation-dialog")).toBeVisible();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-playing", "true");
    await expect.poll(() => q("[data-cad-viewport]").getAttribute("data-motion-time")).not.toBe("0.0000");
    await q("[data-program-play]").click();
    await setPartsOpen(true);
    await visibility().uncheck();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "17");
    await visibility().check();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "21");
    await setPartsOpen(false);
    const image = await canvas.screenshot(),
      modalRect = await canvas.boundingBox();
    await page.mouse.move(modalRect.x + modalRect.width * 0.4, modalRect.y + modalRect.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(modalRect.x + modalRect.width * 0.6, modalRect.y + modalRect.height * 0.6, {
      steps: 10
    });
    await page.mouse.up();
    expect(image.equals(await canvas.screenshot())).toBe(false);
    await q("[data-program-view]").selectOption("iso");
    await q("[data-program-speed]").selectOption("2");
    const downloading = page.waitForEvent("download");
    await q("[data-inspect-record]").click();
    const file = await downloading,
      bytes = await readFile(await file.path());
    expect(file.suggestedFilename()).toMatch(/motion\.webm$/);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    await file.saveAs("test-results/cad-inspection-motion.webm");
    await page.screenshot({ path: "test-results/cad-motion-viewer.png" });
    await q("[data-inspect-simulation-close]").click();
    await expect(q(".cad-simulation-dialog")).not.toBeVisible();
    await expect(canvas).toBeVisible();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-playing", "false");
    await openCadView(editor);
    await q("[data-program-reset-view]").click();
    await q("[data-program-view-close]").click();
    await setPartsOpen(true);
    await group().click();
    await openCadView(editor);
    await q("[data-inspect-explode-number]").fill("45");
    await q("[data-inspect-explode-mode]").selectOption("groups");
    await q("[data-program-view]").selectOption("iso");
    await setPartsOpen(true);
    await q('[data-inspect-expand="false"]').click();
    await q('[data-program-branch="/engine"]').evaluate((e) => {
      e.open = true;
    });
    await q("[data-program-parts-panel]").evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.screenshot({ path: "test-results/cad-inspection-viewer.png" });
    const after = await (await page.request.get(url)).json();
    expect(after.resource.revision).toBe(before.resource.revision);
    expect(after.snapshot.content).toEqual(before.snapshot.content);
    await page.reload();
    if (!(await editor.isVisible())) await page.locator("[data-composer-context]").click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-selected", "assembly:/engine/pistons", {
      timeout: 30000
    });
    for (const width of [960, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await editor.isVisible())) await page.locator("[data-composer-context]").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await openCadView(editor);
      await expect(q("[data-inspect-simulation]")).toBeVisible();
      await q("[data-program-view-close]").click();
    }
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

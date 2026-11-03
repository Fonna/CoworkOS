import { openCadProgram, openCadExport, openCadView } from "./cad-editor-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("native CAD menus, imports, picking, camera gestures, parameters and drafts work together", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(180000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator("[data-app-mount]:not([hidden])");
  const q = (selector) => editor.locator(selector);
  try {
    await openCadProgram(page, dashboard, "点击验收.cad.json");
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });

    const menu = q("[data-program-file-menu]");
    await menu.press("ArrowDown");
    await expect(q("[data-program-import]")).toBeFocused();
    await q("[data-program-import]").press("ArrowDown");
    await expect(q("[data-program-export-menu]")).toBeFocused();
    await q("[data-program-export-menu]").press("ArrowRight");
    await expect(q('[data-program-export="json"]')).toBeFocused();
    for (const format of ["step", "stl", "png"])
      await expect(q(`[data-program-export="${format}"]`)).toBeDisabled();
    await q('[data-program-export="json"]').press("End");
    await expect(q('[data-program-export="python"]')).toBeFocused();
    await q('[data-program-export="python"]').press("ArrowDown");
    await expect(q('[data-program-export="json"]')).toBeFocused();
    await q('[data-program-export="json"]').press("Escape");
    await expect(q("[data-program-export-panel]")).toBeHidden();
    await expect(q("[data-program-export-menu]")).toBeFocused();
    await q("[data-program-export-menu]").press("Escape");
    await expect(q("[data-program-file-panel]")).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await editor.getByRole("button", { name: "显示完整模型", exact: true }).click();
    await expect(q("[data-program-file-panel]")).toBeHidden();

    await q("[data-program-file]").setInputFiles({
      name: "wrong.jscad",
      mimeType: "text/plain",
      buffer: Buffer.from("module.exports.main = () => []; ")
    });
    await expect(q("[data-program-error]")).toContainText("当前引擎一致");
    await menu.click();
    const chooser = page.waitForEvent("filechooser");
    await q("[data-program-import]").click();
    await (await chooser).setFiles("test/fixtures/cad-rocket.py");
    await expect(q("[data-program-count]")).toHaveText("11", { timeout: 30000 });
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await expect(q("[data-program-error]")).toBeHidden();

    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const original = tabs.tabs.find((tab) => tab.resourceId);
    const resourceUrl = `${dashboard.base}/api/tasks/${original.accessTaskId}/resources/${original.resourceId}`;
    const read = async () => (await page.request.get(resourceUrl)).json();
    const revision = (await read()).resource.revision;
    const viewport = q("[data-cad-viewport]");
    const canvas = viewport.locator("canvas");
    // Every row selects the corresponding solid and tells the Agent about it.
    for (let index = 0; index < 11; index++) {
      await q("[data-program-parts-toggle]").click();
      const row = q("[data-program-select]").nth(index);
      const id = await row.getAttribute("data-program-select");
      const selectedResponse = page.waitForResponse(
        (response) => response.url().endsWith("/selection") && response.request().method() === "PUT"
      );
      await row.click();
      expect((await selectedResponse).ok()).toBe(true);
      await expect(viewport).toHaveAttribute("data-selected", id);
      await expect(q("[data-program-parts-panel]")).toBeHidden();
      expect((await read()).selection.data.id).toBe(id);
    }
    await q("[data-program-parts-toggle]").click();
    await q("[data-program-parts-toggle]").press("Escape");
    await expect(q("[data-program-parts-panel]")).toBeHidden();
    await expect(q("[data-program-parts-toggle]")).toBeFocused();

    const view = editor.getByRole("combobox", { name: "观察方向", exact: true });
    const images = [];
    for (const direction of ["front", "right", "top", "iso"]) {
      await view.selectOption(direction);
      await editor.getByRole("button", { name: "显示完整模型", exact: true }).click();
      images.push(await canvas.screenshot());
      await expect(view).toHaveValue(direction);
    }
    expect(images[0].equals(images[1])).toBe(false);
    expect(images[1].equals(images[2])).toBe(false);
    await view.selectOption("front");
    const clearedResponse = page.waitForResponse(
      (response) => response.url().endsWith("/selection") && response.request().method() === "PUT"
    );
    await canvas.click({ position: { x: 3, y: 3 } });
    expect((await clearedResponse).ok()).toBe(true);
    await expect(viewport).toHaveAttribute("data-selected", "");
    expect((await read()).selection.data).toEqual({});
    expect((await read()).selection.summary).toBe("未选中模型部件");
    // Click the actual visible body, rather than only clicking the part list.
    await canvas.click();
    await expect(viewport).toHaveAttribute("data-selected", /solid_\d+/);
    const box = await canvas.boundingBox();
    const beforeRotate = await canvas.screenshot();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.65, { steps: 8 });
    await page.mouse.up();
    expect(beforeRotate.equals(await canvas.screenshot())).toBe(false);
    const beforeZoom = await canvas.screenshot();
    await canvas.hover();
    await page.mouse.wheel(0, -350);
    await expect.poll(async () => beforeZoom.equals(await canvas.screenshot())).toBe(false);
    await editor.getByRole("button", { name: "显示完整模型", exact: true }).click();
    expect((await read()).resource.revision).toBe(revision);
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");

    const radius = editor.getByRole("spinbutton", { name: "机身半径 (mm)", exact: true });
    await radius.fill("50");
    await radius.press("ControlOrMeta+s");
    await expect(q("[data-program-error]")).toContainText("有效的设计参数");
    expect((await read()).resource.revision).toBe(revision);
    await radius.fill("26");
    await radius.press("ControlOrMeta+s");
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await expect(q("[data-program-preview-notice]")).toBeHidden({ timeout: 30000 });
    expect((await read()).snapshot.content.parameters.radius).toBe(26);
    const fins = editor.getByRole("spinbutton", { name: "尾翼数量", exact: true });
    await fins.fill("5");
    await q("[data-program-save]").click();
    await expect(q("[data-program-count]")).toHaveText("12", { timeout: 30000 });
    await q("[data-program-undo]").click();
    // Parameter controls follow the computed model; wait for the undo preview
    // before checking them rather than imposing the default 10s on CadQuery.
    await expect(q("[data-program-count]")).toHaveText("11", { timeout: 30000 });
    await expect(fins).toHaveValue("4");
    await expect(radius).toHaveValue("26");

    await q("[data-program-rename]").click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("取消的名称.cad.json");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(q("[data-program-title]")).toHaveText("点击验收.cad.json");
    await q("[data-program-rename]").click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("人工优化火箭.cad.json");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(q("[data-program-title]")).toHaveText("人工优化火箭.cad.json");
    const beforeLostReply = (await read()).resource.revision;
    // The server commits, but the response is lost. Reload must retain the
    // pending operation ID and retry it without creating a second edit.
    await page.route("**/resources/*/operations", async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await radius.fill("28");
    await radius.press("Tab");
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "error");
    await page.reload();
    await expect(q("[data-program-count]")).toHaveText("11", { timeout: 30000 });
    if (!(await q(".cad-inspector").isVisible())) await q("[data-program-inspector-toggle]").click();
    await q('[data-program-inspector-tab="properties"]').click();
    await expect(radius).toHaveValue("28", { timeout: 30000 });
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    expect((await read()).snapshot.content.parameters.radius).toBe(28);
    await page.unroute("**/resources/*/operations");
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await expect(q("[data-program-preview-notice]")).toBeHidden({ timeout: 30000 });
    expect((await read()).snapshot.content.parameters.radius).toBe(28);
    expect((await read()).resource.revision).toBe(beforeLostReply + 1);

    // A failed update keeps the last model visible; retry restores selectable geometry.
    await page.route("**/resources/*/preview", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"preview unavailable"}' })
    );
    await radius.fill("29");
    await radius.press("Tab");
    await expect(q("[data-program-preview-message]")).toContainText("上次的模型");
    await q("[data-program-parts-toggle]").click();
    await expect(q("[data-program-select]").first()).toBeDisabled();
    await page.unroute("**/resources/*/preview");
    await q("[data-program-retry]").click();
    await expect(q("[data-program-preview-notice]")).toBeHidden({ timeout: 30000 });
    await expect(q("[data-program-select]").first()).toBeEnabled();
    await q("[data-program-parts-toggle]").click();
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await openCadExport(editor);
    const downloaded = page.waitForEvent("download");
    await q('[data-program-export="json"]').click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe("人工优化火箭.cad.json");
    expect(JSON.parse(await readFile(await file.path(), "utf8")).parameters.radius).toBe(29);
    await q("[data-program-parts-toggle]").click();
    await q('[data-program-select="solid_10"]').click();
    await expect(viewport).toHaveAttribute("data-selected", "solid_10");
    const boundResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workbench/load-instance") && response.request().method() === "POST"
    );
    await loadCurrentApplication(page, { newConversation: true, appInstanceId: original.appInstanceId });
    expect((await boundResponse).ok()).toBe(true);
    // The old editor remains visible while adoption is pending. Its count and
    // selection cannot establish that the new acting Task has finished mounting.
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(q("[data-program-count]")).toHaveText("11", { timeout: 30000 });
    await expect(viewport).toHaveAttribute("data-selected", "solid_10");
    await expect(page.locator("[data-composer-context]")).toContainText("内部加强框 3");
    await page.reload();
    await expect(viewport).toHaveAttribute("data-selected", "solid_10", { timeout: 30000 });
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    const final = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    expect(final.tabs.filter((tab) => tab.resourceId === original.resourceId)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

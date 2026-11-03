import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { blenderStatus } from "../dist/src/software/blender/engine.js";

const nativeAvailable = (await blenderStatus()).available;
async function openBlender(page, base) {
  await page.goto(base);
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="blender"]').click();
  await confirmApplicationWorkspace(page);
  await page.locator("[data-blender-new]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("浏览器 Blender 验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator("[data-blender-title]")).toHaveText("浏览器 Blender 验收");
}
const source = `import bpy
def main(p):
    obj = bpy.data.objects.get('Body')
    if obj is None:
        bpy.ops.mesh.primitive_cube_add(size=2)
        obj=bpy.context.object
        obj.name='Body'
    obj.dimensions=(p.get('width', 2), 2, 2)
`;
test("Blender workbench creates real geometry, selects and edits objects, exports/imports native bytes and retains failures", async ({
  page
}, info) => {
  test.skip(!nativeAvailable, "Blender native runtime not installed");
  test.setTimeout(120000);
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openBlender(page, dashboard.base);
    await expect(page.locator("[data-blender-empty]")).toBeVisible();
    await page.locator("[data-blender-source-toggle]").click();
    await expect(page.locator("[data-blender-budget]")).toHaveValue("180");
    expect(
      await page
        .locator("[data-blender-budget] option")
        .evaluateAll((options) => options.map((option) => option.value))
    ).toEqual(["60", "180", "300", "600"]);
    await page.locator("[data-blender-budget]").selectOption("600");
    await page.locator("[data-blender-source]").fill(source);
    await page.locator("[data-blender-run]").click();
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    await expect(page.locator("[data-blender-viewport]")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("[data-blender-metrics]")).toContainText("12 个三角面");
    await page.locator("[data-blender-select]").click();
    await expect(page.getByRole("textbox", { name: "对象名称" })).toHaveValue("Body");
    await page.getByRole("spinbutton", { name: "位置 X", exact: true }).fill("4");
    await page.getByRole("spinbutton", { name: "位置 X", exact: true }).press("Tab");
    await expect(page.locator("[data-blender-status]")).toContainText("未保存");
    await page.locator("[data-blender-save]").click();
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("4");
    await page.locator("[data-blender-parameters]").fill('{"width":3}');
    await page.locator("[data-blender-parameters]").press("Tab");
    await page.locator("[data-blender-run]").click();
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("4");
    await page.locator("[data-blender-view-toggle]").click();
    await expect(page.locator("[data-blender-image]")).toBeVisible();
    await expect
      .poll(() =>
        page.locator("[data-blender-image]").evaluate((img) => img.complete && img.naturalWidth > 0)
      )
      .toBe(true);
    await page.locator("[data-blender-view-toggle]").click();
    const downloaded = page.waitForEvent("download");
    await page.locator("[data-blender-file-menu]").click();
    await page.locator('[data-blender-export="blend"]').click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toBe("浏览器 Blender 验收.blend");
    const bytes = await readFile(await file.path());
    expect(bytes.length).toBeGreaterThan(1000);
    await page
      .locator("[data-blender-file]")
      .setInputFiles({ name: "import.blend", mimeType: "application/octet-stream", buffer: bytes });
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    await page.locator("[data-blender-source]").fill("raise RuntimeError('intentional failure')");
    await page.locator("[data-blender-run]").click();
    await expect(page.locator("[data-blender-error]")).toContainText("intentional failure", {
      timeout: 30000
    });
    await expect(page.locator("[data-blender-metrics]")).toContainText("12 个三角面");
    await expect(page.locator("[data-blender-source]")).toHaveValue(
      "raise RuntimeError('intentional failure')"
    );
    await page.reload();
    await expect(page.locator("[data-blender-title]")).toHaveText("浏览器 Blender 验收");
    await expect(page.locator("[data-blender-viewport]")).toHaveAttribute("data-ready", "true");
    await page.locator("[data-blender-select]").click();
    await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("4");
    await page.locator("[data-blender-inspector-toggle]").click();
    await expect(page.locator(".blender-inspector")).toBeHidden();
    await expect(page.locator("[data-blender-inspector-toggle]")).toHaveAttribute("aria-expanded", "false");
    await page.locator("[data-blender-inspector-toggle]").click();
    await expect(page.getByRole("textbox", { name: "对象名称" })).toHaveValue("Body");
    await page.getByRole("textbox", { name: "对象名称" }).press("Escape");
    await expect(page.locator(".blender-inspector")).toBeHidden();
    await expect(page.locator("[data-blender-inspector-toggle]")).toBeFocused();
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const canvas = page.locator("[data-blender-viewport] canvas");
      const pixels = PNG.sync.read(await canvas.screenshot());
      expect(pixels.data[0] > 150).toBe(theme === "light");
      for (const width of [1440, 700, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator("[data-blender-inspector-toggle]").click();
        await expect(page.locator(".blender-inspector")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "对象名称" })).toHaveValue("Body");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`blender-scene-${theme}-${width}.png`) });
        await page.locator("[data-blender-inspector-close]").click();
        await expect(page.locator("[data-blender-inspector-toggle]")).toBeFocused();
      }
    }
    await page.screenshot({ path: ".tmp/blender-workbench.png" });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
test("Blender empty window and source draft work without executing native software, including narrow layout", async ({
  page
}) => {
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openBlender(page, dashboard.base);
    await expect(page.locator(".blender-inspector")).toBeHidden();
    await page.locator("[data-blender-inspector-toggle]").click();
    await expect(page.locator(".blender-inspector")).toBeVisible();
    await page.locator("[data-blender-inspector-close]").click();
    await expect(page.locator("[data-blender-inspector-toggle]")).toBeFocused();
    await page.locator("[data-blender-source-toggle]").click();
    await page.locator("[data-blender-source]").fill("draft ! invalid Python");
    await page.locator("[data-blender-save]").click();
    await expect(page.locator("[data-blender-status]")).toContainText("已保存");
    await page.setViewportSize({ width: 700, height: 820 });
    await expect(page.locator("[data-blender-title]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await page.locator("[data-blender-source-toggle]").click();
    await expect(page.locator("[data-blender-source]")).toHaveValue("draft ! invalid Python");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});
test("Blender preserves invalid parameter drafts, keeps narrow controls reachable and binds its saved document", async ({
  page
}) => {
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openBlender(page, dashboard.base);
    await page.locator("[data-blender-source-toggle]").click();
    const parameters = page.locator("[data-blender-parameters]");
    await parameters.fill('{"width":');
    await parameters.press("Tab");
    await expect(parameters).toHaveValue('{"width":');
    await expect(page.locator("[data-blender-error]")).toContainText("当前输入已保留");
    await page.locator("[data-blender-save]").click();
    await expect(parameters).toHaveValue('{"width":');
    await expect(page.locator("[data-blender-error]")).toContainText("修正参数 JSON");
    await page.reload();
    await page.locator("[data-blender-source-toggle]").click();
    await expect(parameters).toHaveValue('{"width":');
    await parameters.fill('{"width":3}');
    await parameters.press("ControlOrMeta+s");
    await expect(page.locator("[data-blender-status]")).toContainText("已保存");
    await expect(page.locator("[data-blender-error]")).toBeHidden();
    for (const width of [1440, 1280, 474, 320]) {
      await page.setViewportSize({ width, height: 820 });
      const stage = await page.locator(".blender-stage").boundingBox();
      expect(stage.width).toBeGreaterThan(Math.min(300, width - 24));
      for (const selector of ["[data-blender-save]", "[data-blender-run]"]) {
        const button = page.locator(selector);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(820);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`blender-after-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("[data-blender-source]").fill("# unsaved draft before binding");
    await loadCurrentApplication(page, { newConversation: true });
    await expect(page.locator("#toast")).toContainText("已关联");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json(),
      resource = tabs.tabs.find((tab) => tab.resourceId),
      conversation = tabs.tabs.find((tab) => tab.kind === "conversation");
    expect(resource).toBeTruthy();
    expect(conversation).toBeTruthy();
    expect(resource.conversations.some((item) => item.taskId === conversation.taskId)).toBe(true);
    expect(tabs.tabs.filter((tab) => tab.resourceId === resource.resourceId)).toHaveLength(1);
    const read = await (
      await page.request.get(
        `${dashboard.base}/api/tasks/${conversation.taskId}/resources/${resource.resourceId}`
      )
    ).json();
    expect(read.snapshot.content.source).toBe("# unsaved draft before binding");
    expect(read.snapshot.content.parameters).toEqual({ width: 3 });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

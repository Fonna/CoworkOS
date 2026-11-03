import {
  newPresentation,
  presentationSave,
  presentationStatus,
  presentationCommand,
  openPresentationFileMenu,
  openPresentationInsertMenu
} from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";

test("presentation chrome follows appearance and keeps tools reachable at narrow widths", async ({
  page
}, testInfo) => {
  test.setTimeout(120000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="pptist"]').click();
    await confirmApplicationWorkspace(page);
    const mount = page.locator("[data-app-mount]:not([hidden])");
    await expect(mount.getByRole("heading", { name: "演示文稿", exact: true })).toBeVisible();
    await expect(mount.locator("[data-local-open]")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("presentation-home.png") });
    await newPresentation(page);
    await page.getByRole("textbox", { name: "文件名" }).fill("界面与窄屏验证");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const frame = page.frameLocator("[data-app-mount]:not([hidden]) iframe");
    await expect(mount.locator("[data-pptist-loading]")).toBeHidden();
    await expect(frame.getByRole("button", { name: "导出", exact: true })).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "文件操作", exact: true })).toBeVisible();
    await expect(mount.locator(".pptist-toolbar")).toBeHidden();
    const controls = frame.locator(".editor-command-bar");
    expect((await controls.boundingBox()).height).toBeLessThanOrEqual(44);
    const workbench = await mount.locator(".pptist-workbench").boundingBox();
    expect((await mount.locator("iframe").boundingBox()).y).toBeCloseTo(workbench.y, 0);
    await frame.locator(".remark .ProseMirror").fill("窄屏保存后仍保留演讲备注");
    await presentationSave(page).click();
    await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
    await expect(presentationSave(page)).toBeEnabled();
    const selectedSlides = () =>
      frame.locator(".thumbnail-item.selected").evaluateAll((items) => items.map((item) => item.textContent));
    const beforeKeyboard = await selectedSlides();
    const fileTrigger = frame.getByRole("button", { name: "文件操作", exact: true });
    await fileTrigger.focus();
    await fileTrigger.press("Enter");
    await expect(frame.locator('[data-pptist-command="new"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(frame.getByRole("button", { name: "打开 PPTX…", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(fileTrigger).toBeFocused();
    await expect(fileTrigger).toHaveAttribute("aria-expanded", "false");
    const insertTrigger = frame.getByRole("button", { name: "插入", exact: true });
    await insertTrigger.focus();
    await insertTrigger.press("Enter");
    await expect(frame.getByRole("button", { name: "插入文字", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(frame.getByRole("button", { name: "插入竖排文字", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(insertTrigger).toBeFocused();
    await expect(insertTrigger).toHaveAttribute("aria-expanded", "false");
    expect(await selectedSlides()).toEqual(beforeKeyboard);
    await expect(frame.locator(".thumbnail-item")).toHaveCount(1);
    const artwork = await frame
      .locator(".viewport")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect
        .poll(() =>
          frame
            .locator(".atria-pptist-header")
            .evaluate((element) => getComputedStyle(element).backgroundColor)
        )
        .toBe(theme === "light" ? "rgb(255, 255, 255)" : "rgb(32, 32, 32)");
      expect(
        await frame.locator(".viewport").evaluate((element) => getComputedStyle(element).backgroundColor)
      ).toBe(artwork);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`presentation-${theme}-1440.png`)
      });
    }
    for (const width of [760, 608, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect((await controls.boundingBox()).height).toBeLessThanOrEqual(44);
      const row = await controls.boundingBox();
      for (const control of [
        frame.getByRole("button", { name: "文件操作", exact: true }),
        frame.getByRole("button", { name: "插入", exact: true }),
        frame.getByRole("button", { name: "从头放映", exact: true }),
        frame.getByRole("button", { name: "幻灯片列表", exact: true }),
        frame.getByRole("button", { name: "属性面板", exact: true }),
        presentationSave(page)
      ]) {
        await expect(control).toBeInViewport();
        const box = await control.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(row.y);
        expect(box.y + box.height).toBeLessThanOrEqual(row.y + row.height);
      }
      await openPresentationFileMenu(page);
      for (const command of ["new", "rename", "review", "undo-save", "export", "save-copy"]) {
        await expect(frame.locator(`[data-pptist-command="${command}"]`)).toBeInViewport();
      }
      await frame.getByRole("button", { name: "文件操作", exact: true }).click();
      await openPresentationInsertMenu(page);
      for (const name of ["文字", "形状", "图片", "线条", "图表", "表格", "公式", "音视频", "符号"]) {
        await expect(frame.getByRole("button", { name: `插入${name}`, exact: true })).toBeInViewport();
      }
      await frame.getByRole("button", { name: "插入", exact: true }).click();
      await expect(frame.getByRole("button", { name: "属性面板", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
      await expect(frame.locator(".layout-content-right")).toBeHidden();
      await expect(frame.locator(".layout-content-left")).toBeHidden();
      const properties = frame.getByRole("button", { name: "属性面板", exact: true });
      await properties.focus();
      await properties.press("Enter");
      await expect(frame.locator(".layout-content-right")).toBeVisible();
      await expect(properties).toHaveAttribute("aria-pressed", "true");
      await frame
        .getByRole("button", { name: "关闭侧栏", exact: true })
        .click({ position: { x: 2, y: 100 } });
      await expect(frame.locator(".layout-content-right")).toBeHidden();
      await frame.getByRole("button", { name: "幻灯片列表", exact: true }).click();
      await expect(frame.locator(".layout-content-left")).toBeVisible();
      await frame.getByText("添加幻灯片", { exact: true }).click();
      await frame.getByRole("button", { name: "幻灯片列表", exact: true }).click();
      await expect(frame.locator(".layout-content-left")).toBeHidden();
      await expect(frame.locator("body")).toHaveJSProperty(
        "scrollWidth",
        await frame.locator("body").evaluate((element) => element.clientWidth)
      );
      const canvas = await frame.locator(".canvas").boundingBox();
      const editor = await mount.locator("iframe").boundingBox();
      expect(canvas.width).toBeGreaterThan(editor.width * 0.9);
      await presentationSave(page).click();
      await expect(presentationStatus(page)).toHaveAttribute("data-state", "saved");
      await expect(presentationSave(page)).toBeEnabled();
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`presentation-dark-${width}.png`)
      });
    }
    await presentationCommand(page, "export");
    await expect(frame.getByRole("button", { name: "导出 PPTX", exact: true })).toBeInViewport();
    for (const name of ["全部", "当前页", "自定义"]) {
      expect(
        await frame.getByRole("button", { name, exact: true }).evaluate((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return range.getBoundingClientRect().height <= button.clientHeight;
        })
      ).toBe(true);
    }
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("presentation-export-320.png")
    });
    const download = page.waitForEvent("download");
    await frame.getByRole("button", { name: "导出 PPTX", exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.pptx$/);
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await frame.locator(".thumbnail-item").first().click();
    await expect(frame.locator(".remark .ProseMirror")).toContainText("窄屏保存后仍保留演讲备注");
    await expect(frame.locator(".thumbnail-item")).toHaveCount(4);
    await presentationCommand(page, "save-copy");
    const saveCopy = page.getByRole("dialog", { name: "保存到目录或项目", exact: true });
    await expect(saveCopy).toBeVisible();
    await expect(saveCopy.getByRole("combobox", { name: "保存位置", exact: true })).toBeFocused();
    await saveCopy.getByRole("button", { name: "取消", exact: true }).click();
    await expect(saveCopy).toHaveCount(0);
    await expect(fileTrigger).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

import { openSaveCopy } from "./application-file-helper.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const appearances = [
  [1440, "light"],
  [320, "light"],
  [1440, "dark"],
  [320, "dark"]
];

async function checkDialog(dialog, width, height) {
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
  await expect(dialog).toHaveCSS("border-top-width", "0px");
  await expect(dialog).toHaveCSS("border-radius", "24px");
  expect(
    await dialog.locator("input,select").evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node);
        return style.fontSize === "14px" && style.borderTopStyle === "solid";
      })
    )
  ).toBe(true);
  expect(
    await dialog.locator("button").evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node);
        return style.fontSize === "14px" && style.borderTopStyle !== "outset";
      })
    )
  ).toBe(true);
}

test("workbench naming, save-copy and change review share styled dialogs and retain failed edits", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await page.locator("[data-empty-new]:visible").click();
    const naming = page.locator(".editor-name-form");
    for (const [width, colorScheme] of appearances) {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await checkDialog(naming, width, 720);
      await expect(naming.locator(".is-primary")).toHaveCSS(
        "background-color",
        colorScheme === "dark" ? "rgb(237, 237, 237)" : "rgb(38, 38, 38)"
      );
      await expect(naming.locator(".is-secondary")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.screenshot({ path: info.outputPath(`document-name-${colorScheme}-${width}.png`) });
    }
    await naming.getByRole("textbox", { name: "文件名" }).fill("界面验收.txt");
    await naming.getByRole("button", { name: "创建", exact: true }).click();
    const input = page.locator("[data-editor-input]:visible");
    await expect(input).toBeEnabled();
    for (const text of ["第一版\n", "第二版\n"]) {
      await input.fill(text);
      await input.press("Control+s");
      await expect(page.locator("[data-editor-status]:visible")).toHaveAttribute("data-state", "saved");
    }
    await page.route("**/api/tasks/*/resources/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await gate;
      return route.fulfill({ status: 409, json: { error: "名称已被占用" } });
    });
    await page.locator("[data-editor-rename]:visible").click();
    await naming.getByRole("textbox", { name: "文件名" }).fill("保留这个名称.txt");
    await naming.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(naming).toHaveAttribute("aria-busy", "true");
    await page.keyboard.press("Tab");
    await expect(naming).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(naming).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(naming).toBeVisible();
    release();
    await expect(naming.locator("[role=alert]")).toContainText("名称已被占用");
    await expect(naming.getByRole("textbox", { name: "文件名" })).toHaveValue("保留这个名称.txt");
    await expect(naming.getByRole("textbox", { name: "文件名" })).toBeFocused();
    await naming.getByRole("button", { name: "取消", exact: true }).click();
    await page.unroute("**/api/tasks/*/resources/*");

    await openSaveCopy(page);
    const saveCopy = page.getByRole("dialog", { name: "保存到目录或项目" });
    await expect(saveCopy.locator(".dialog-description")).toHaveCount(0);
    await expect(saveCopy.getByRole("combobox", { name: "保存位置", exact: true })).toBeVisible();
    for (const [width, colorScheme] of appearances) {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme });
      await checkDialog(saveCopy, width, 720);
      await page.screenshot({ path: info.outputPath(`save-copy-${colorScheme}-${width}.png`) });
    }
    await saveCopy.locator("[data-save-directory]").fill(dashboard.root);
    await saveCopy.locator("[data-save-format]").selectOption("text");
    await saveCopy.getByRole("button", { name: "保存", exact: true }).click();
    await expect(saveCopy).toHaveCount(0);
    expect(await readFile(join(dashboard.root, "界面验收.txt"), "utf8")).toBe("第二版\n");
    await page.locator("[data-editor-review]:visible").click();
    const review = page.locator(".resource-review");
    await expect(review.locator("[data-review-before]")).toContainText("第一版");
    await expect(review.locator("[data-review-after]")).toContainText("第二版");
    for (const [width, colorScheme] of appearances) {
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme });
      await checkDialog(review, width, 720);
      await page.screenshot({ path: info.outputPath(`resource-review-${colorScheme}-${width}.png`) });
    }
    await review.getByRole("button", { name: "撤销这次修改", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect(input).toHaveValue("第一版\n");
  } finally {
    release();
    await dashboard.stop();
  }
});

test("the compatibility workspace picker uses shared fields and actions without clipping", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createApplicationWorkspacePicker } =
        await import("/assets/workbench/application-workspace-picker.js");
      createApplicationWorkspacePicker({
        displayName: "文本编辑器",
        api: { chooseWorkspace: async () => ({ cancelled: true }) },
        workspaces: ["/fixture/一个很长的项目文件夹名称/用于检查工作区选项是否完整可读"]
      });
    });
    const dialog = page.getByRole("dialog", { name: "新建文本编辑器实例" });
    await expect(dialog.locator(".dialog-description")).toHaveCount(0);
    await expect(dialog.getByRole("combobox").locator("option").nth(1)).toHaveText(
      "/fixture/一个很长的项目文件夹名称/用于检查工作区选项是否完整可读"
    );
    await expect(dialog.getByRole("button", { name: "创建实例", exact: true })).toBeDisabled();
    await dialog.getByRole("combobox").selectOption({ index: 1 });
    await expect(dialog.getByRole("button", { name: "创建实例", exact: true })).toBeEnabled();
    for (const [width, colorScheme] of appearances) {
      await page.setViewportSize({ width, height: 620 });
      await page.emulateMedia({ colorScheme });
      await checkDialog(dialog, width, 620);
      await page.screenshot({ path: info.outputPath(`workspace-picker-${colorScheme}-${width}.png`) });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openApplicationFileMenu, openSaveCopy } from "./application-file-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";

async function createText(page) {
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="text-editor"]').click();
  await page.locator("[data-empty-new]:visible").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("整理后的文件操作.txt");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator("[data-editor-input]:visible")).toBeEnabled();
  await expect(page.locator("[data-editor-input]:visible")).toBeFocused();
}

test("document destinations share a compact file menu with download and restore keyboard focus", async ({
  page
}, info) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(dashboard.base);
    await createText(page);
    const input = page.locator("[data-editor-input]:visible");
    await input.fill("项目计划\n\n1. 整理需求\n2. 完成设计\n3. 验证与交付\n");
    await input.press("ControlOrMeta+s");
    await expect(page.locator("[data-editor-status]:visible")).toContainText("已");
    const fileInfo = page.locator("[data-editor-info]:visible");
    await fileInfo.locator("summary").press("Enter");
    await expect(fileInfo.locator("[data-editor-revision]")).toBeVisible();
    await fileInfo.locator("summary").press("Escape");
    await expect(fileInfo.locator("[data-editor-revision]")).toBeHidden();
    await expect(fileInfo.locator("summary")).toBeFocused();
    const trigger = page.locator("[data-application-file-menu]:visible");
    const saveCopy = page.locator("[data-application-save-copy]");
    const label = page.locator("[data-app-task-status]");
    await expect(saveCopy).toBeHidden();
    await expect(label).toHaveText("临时工作区");
    await expect(label).not.toBeInViewport();
    await expect(page.locator("[data-workbench-header]")).toHaveAttribute("data-state", "idle");
    for (const [width, colorScheme] of [
      [1440, "light"],
      [700, "light"],
      [320, "light"],
      [1440, "dark"],
      [700, "dark"],
      [320, "dark"]
    ]) {
      await page.setViewportSize({ width, height: 760 });
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(page.locator("[data-editor-title]:visible")).toBeInViewport();
      expect(
        await page.locator(".editor-menubar:visible").evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`text-editor-${colorScheme}-${width}.png`) });
      await trigger.focus();
      await trigger.press("ArrowDown");
      const menu = page.locator("[data-application-file-panel]:visible");
      await expect(menu.getByRole("menuitem", { name: "下载到本机" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("menuitem", { name: "保存副本…", exact: true })).toBeFocused();
      const bounds = await menu.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await page.locator("[data-workbench-header]").evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`document-file-menu-${colorScheme}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    await openSaveCopy(page);
    const dialog = page.getByRole("dialog", { name: "保存到目录或项目" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(trigger).toBeFocused();
    await openApplicationFileMenu(page);
    const downloaded = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "下载到本机" }).click();
    expect((await downloaded).suggestedFilename()).toBe("整理后的文件操作.txt");
  } finally {
    await dashboard.stop();
  }
});

test("a delayed save-copy preparation does not open over a later conversation draft", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let requested;
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  try {
    await page.goto(dashboard.base);
    await createText(page);
    await page.route("**/api/tasks/*/resources/*", async (route) => {
      if (route.request().method() === "GET") {
        requested();
        await gate;
      }
      await route.continue();
    });
    await openSaveCopy(page);
    await started;
    const saveCopy = page.locator("[data-application-save-copy]");
    await expect(saveCopy).toHaveAttribute("aria-busy", "true");
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("保留后来会话的草稿");
    release();
    await expect(saveCopy).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("dialog", { name: "保存到目录或项目" })).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("保留后来会话的草稿");
  } finally {
    release();
    await dashboard.stop();
  }
});

test("the right workspace keeps one header and restores its session, size and draft through view controls", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await createText(page);
    const editor = page.locator("[data-editor-input]:visible");
    await editor.fill("保留人工文稿");
    await editor.press("ControlOrMeta+s");
    await loadCurrentApplication(page, { newConversation: true });
    await page.locator("[data-composer-context]").click();
    const workbench = page.locator("#workbench");
    const header = page.locator("[data-workbench-header]");
    const rail = header.locator("[data-tab-rail]");
    const draft = page.locator("#composer-input");
    await draft.fill("保留当前会话草稿");
    await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
    await expect(page.locator("[data-tab-strip]")).toBeHidden();
    await expect(page.locator("[data-file-switcher], [data-app-return-conversation]")).toHaveCount(0);
    await expect(header).toHaveAttribute("aria-describedby", /.+/);
    await expect(page.locator("[data-app-task-status]")).not.toBeInViewport();
    const row = await header.boundingBox();
    expect(row.height).toBeLessThanOrEqual(48);
    const chat = await page.locator("#conversation-pane").boundingBox();
    expect(row.x).toBeGreaterThanOrEqual(chat.x + chat.width);
    for (const button of [rail.locator("[data-tab]"), header.locator("[data-app-expand]")]) {
      await expect(button).toBeInViewport();
      const bounds = await button.boundingBox();
      expect(bounds.y).toBeGreaterThanOrEqual(row.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(row.y + row.height);
    }
    const divider = page.getByRole("separator", { name: "调整对话与工作台宽度" });
    await divider.press("ArrowRight");
    const ratio = await divider.getAttribute("aria-valuenow");
    await header.getByRole("button", { name: "全屏编辑", exact: true }).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(divider).toBeHidden();
    await expect(editor).toBeVisible();
    expect((await editor.boundingBox()).height).toBeGreaterThan(100);
    await expect(editor).toHaveValue("保留人工文稿");
    await header.getByRole("button", { name: "恢复并排协作", exact: true }).click();
    await expect(editor).toBeVisible();
    expect((await editor.boundingBox()).height).toBeGreaterThan(100);
    await expect(divider).toHaveAttribute("aria-valuenow", ratio);
    await expect(draft).toHaveValue("保留当前会话草稿");
    const topToggle = page.locator("#output-pane-toggle");
    await expect(topToggle).toHaveAttribute("aria-controls", "workbench");
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(workbench).toBeHidden();
    await expect(topToggle).toHaveAttribute("aria-expanded", "false");
    await expect(topToggle).toHaveAccessibleName("展开工作区");
    await topToggle.click();
    await expect(workbench).toBeVisible();
    await expect(topToggle).toHaveAttribute("aria-expanded", "true");
    await expect(topToggle).toHaveAccessibleName("收起工作区");
    await expect(divider).toHaveAttribute("aria-valuenow", ratio);
    await expect(editor).toHaveValue("保留人工文稿");
    await expect(draft).toHaveValue("保留当前会话草稿");
    await topToggle.click();
    await expect(workbench).toBeHidden();
    await topToggle.click();
    await expect(workbench).toBeVisible();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(header.locator("[data-app-collaborate]")).toBeHidden();
    await page.screenshot({ path: info.outputPath("workspace-single-header.png") });
    await expect(header.locator("[data-workbench-tasks]")).toHaveCount(0);
    const tasks = page.getByRole("button", { name: "显示任务面板", exact: true });
    await page.getByRole("button", { name: "显示默认侧栏", exact: true }).click();
    await expect(page.locator("#agent-pane")).toBeHidden();
    await expect(workbench).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeVisible();
    await tasks.click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator("#panel-heading")).toBeFocused();
    await expect(editor).toHaveValue("保留人工文稿");
    await expect(draft).toHaveValue("保留当前会话草稿");
    await topToggle.click();
    await expect(workbench).toBeHidden();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(draft).toHaveValue("保留当前会话草稿");
  } finally {
    await dashboard.stop();
  }
});

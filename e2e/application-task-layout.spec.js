import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("left sidebar switches views while preserving collaboration and drafts", async ({ page }, info) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    const collaborate = page.getByRole("button", { name: "在对话中使用", exact: true });
    const tasks = page.locator('[data-sidebar-view="tasks"]');
    const navigation = page.locator('[data-sidebar-view="navigation"]');
    await expect(collaborate).toBeVisible();
    await expect(tasks).toBeVisible();
    await expect(page.locator("[data-workbench-tasks]")).toHaveCount(0);
    await tasks.click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await expect(navigation).toBeEnabled();
    await navigation.press("Enter");
    await expect(page.locator("#agent-pane")).toBeHidden();
    await expect(page.locator(".conversation-sidebar")).toBeVisible();
    await expect(tasks).toBeFocused();
    await collaborate.click();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(collaborate).toBeHidden();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await navigation.click();
    await expect(tasks).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeVisible();
    await tasks.click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await page.locator("#composer-input").fill("保留会话草稿");
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tasks" && response.ok()
    );
    await page.getByRole("button", { name: "刷新任务面板", exact: true }).click();
    await refreshed;
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("保留会话草稿");
    for (const [width, colorScheme] of [
      [1440, "dark"],
      [1280, "dark"],
      [1440, "light"],
      [1280, "light"]
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      const taskBox = await page.locator("#agent-pane").boundingBox();
      const chatBox = await page.locator("#conversation-pane").boundingBox();
      const appBox = await page.locator("#workbench").boundingBox();
      expect(taskBox.x).toBeLessThan(chatBox.x);
      expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(chatBox.x + 1);
      expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(appBox.x + 1);
      await expect(navigation).toBeInViewport();
      expect(
        await page.locator(".output-heading").evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`collaboration-${colorScheme}-${width}.png`) });
      await navigation.click();
      await expect(tasks).toBeInViewport();
      expect(
        await page.locator(".sidebar-header").evaluate((node) => node.scrollWidth <= node.clientWidth)
      ).toBe(true);
      await expect(page.locator("#composer-input")).toHaveValue("保留会话草稿");
      await page.screenshot({ path: info.outputPath(`navigation-${colorScheme}-${width}.png`) });
      await tasks.click();
      await expect(navigation).toBeEnabled();
      await expect(page.locator("#agent-pane")).toBeVisible();
    }
    await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
    await expect(collaborate).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await page.getByRole("button", { name: "恢复并排协作", exact: true }).click();
    await expect(collaborate).toBeHidden();
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(page.locator("#workbench")).toBeHidden();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("保留会话草稿");
    await page.getByRole("button", { name: "展开工作区", exact: true }).click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(collaborate).toBeHidden();
  } finally {
    await d.stop();
  }
});

test("first collaboration opens the task panel automatically", async ({ page }) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await page.locator("[data-app-collaborate]").click();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(page.locator("[data-app-collaborate]")).toBeHidden();
  } finally {
    await d.stop();
  }
});

for (const initialView of ["tasks", "navigation"]) {
  test(`the editor destination keeps the ${initialView} sidebar independent of right-pane visibility`, async ({
    page
  }) => {
    const d = await startDashboard({ defaultProject: false });
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(d.base);
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="text-editor"]').click();
      await page.locator("[data-empty-new]:visible").click();
      await page.getByRole("textbox", { name: "文件名" }).fill("独立侧栏.txt");
      await page.getByRole("button", { name: "创建", exact: true }).click();
      const editor = page.locator("[data-editor-input]");
      await editor.fill("保留文档内容");
      await editor.press("ControlOrMeta+s");
      await page.locator("[data-app-collaborate]").click();
      await page.locator("#composer-input").fill("保留会话草稿");
      const tasks = page.locator('[data-sidebar-view="tasks"]');
      const navigation = page.locator('[data-sidebar-view="navigation"]');
      if (initialView === "navigation") await navigation.click();
      const pane = page.locator(initialView === "tasks" ? "#agent-pane" : "#conversation-sidebar");
      const other = page.locator(initialView === "tasks" ? "#conversation-sidebar" : "#agent-pane");
      const sidebar = page.getByRole("button", { name: "切换侧栏", exact: true });
      const right = page.locator("#output-pane-toggle");
      await expect(page.locator("#workbench")).toBeVisible();
      await expect(right).toHaveAccessibleName("收起工作区");
      await right.click();
      await expect(page.locator("#workbench")).toBeHidden();
      await expect(pane).toBeVisible();
      await expect(other).toBeHidden();
      await expect(right).toHaveAccessibleName("展开工作区");
      await page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/workbench/tabs" && response.request().method() === "GET"
      );
      await expect(pane).toBeVisible();
      await (initialView === "tasks" ? navigation : tasks).click();
      await expect(other).toBeVisible();
      await expect(pane).toBeHidden();
      await sidebar.click();
      await expect(other).toBeHidden();
      await right.click();
      await expect(page.locator("#workbench")).toBeVisible();
      await expect(other).toBeHidden();
      await expect(pane).toBeHidden();
      await sidebar.click();
      await expect(other).toBeVisible();
      await expect(pane).toBeHidden();
      await expect(editor).toHaveValue("保留文档内容");
      await expect(page.locator("#composer-input")).toHaveValue("保留会话草稿");

      // Removing the editor changes the destination to the task panel.
      await page.locator("[data-tab-rail] [data-close-tab]:visible").click();
      await expect(right).toHaveAttribute("aria-controls", "agent-pane");
      await expect(page.locator("#conversation-sidebar")).toBeVisible();
      await expect(tasks).toBeHidden();
      await expect(navigation).toBeHidden();
      if ((await right.getAttribute("aria-expanded")) === "false") await right.click();
      await expect(page.locator("#agent-pane")).toBeVisible();
      const chat = await page.locator("#conversation-pane").boundingBox();
      const task = await page.locator("#agent-pane").boundingBox();
      expect(task.x).toBeGreaterThan(chat.x);
      await expect(page.locator("#composer-input")).toHaveValue("保留会话草稿");
    } finally {
      await d.stop();
    }
  });
}

for (const width of [1440, 474]) {
  test(`the top-left control hides and restores the current sidebar at ${width}px`, async ({ page }) => {
    const d = await startDashboard({ defaultProject: false });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(d.base);
      const toggle = page.getByRole("button", { name: "切换侧栏", exact: true });
      if (!(await page.locator("#apps-nav").isVisible())) await toggle.click();
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="text-editor"]').click();
      await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
      const tasks = page.getByRole("button", { name: "显示任务面板", exact: true });
      const navigation = page.getByRole("button", { name: "显示默认侧栏", exact: true });
      if (!(await tasks.isVisible())) await toggle.click();
      await tasks.click();

      for (const view of ["tasks", "navigation"]) {
        const pane = page.locator(view === "tasks" ? "#agent-pane" : "#conversation-sidebar");
        const other = page.locator(view === "tasks" ? "#conversation-sidebar" : "#agent-pane");
        if (view === "navigation") await navigation.click();
        await expect(pane).toBeVisible();
        await expect(other).toBeHidden();
        const originalWidth = (await pane.boundingBox()).width;
        await expect(toggle).toHaveAttribute("aria-controls", await pane.getAttribute("id"));
        await toggle.click();
        await expect(pane).toBeHidden();
        await expect(other).toBeHidden();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        if (width > 900) await expect(page.locator("#sidebar-divider")).toBeHidden();
        if (width > 900) expect((await page.locator(".chat-pane").boundingBox()).x).toBeLessThan(1);
        await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
        // A normal catalog refresh must not reopen the sidebar or change its view.
        await page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/workbench/tabs" &&
            response.request().method() === "GET"
        );
        await expect(pane).toBeHidden();
        await toggle.click();
        await expect(pane).toBeVisible();
        await expect(other).toBeHidden();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect((await pane.boundingBox()).width).toBeCloseTo(originalWidth, 0);
      }
    } finally {
      await d.stop();
    }
  });
}

test("returning from full-screen editing keeps the editor visible until collaboration is ready", async ({
  page
}, info) => {
  const d = await startDashboard({ defaultProject: false });
  let release = () => {};
  try {
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("返回对话.txt");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const editor = page.locator("[data-editor-input]:visible");
    await editor.fill("切换期间保留编辑器");
    await editor.press("ControlOrMeta+s");
    await page.locator("[data-app-collaborate]").click();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await page.locator("#composer-input").fill("保留对话草稿");
    await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();

    // Hold the conversation-tab request after binding succeeds. The previous
    // implementation exposed a conversation-only layout during this wait.
    let reached;
    const started = new Promise((resolve) => (reached = resolve));
    const gate = new Promise((resolve) => (release = resolve));
    await page.route("**/api/workbench/tabs", async (route) => {
      if (route.request().method() === "POST") {
        reached();
        await gate;
      }
      await route.continue();
    });
    await page.evaluate(() => {
      window.returnFrames = [];
      window.captureReturn = true;
      const sample = () => {
        if (!window.captureReturn) return;
        const visible = (selector) => Boolean(document.querySelector(selector)?.getClientRects().length);
        window.returnFrames.push({
          editor: visible("[data-editor-input]"),
          conversation: visible("#conversation-pane"),
          task: visible("#agent-pane"),
          taskOnLeft: document.body.classList.contains("application-task-layout")
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator("[data-app-collaborate]").click();
    await started;
    await expect(editor).toBeVisible();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await page.screenshot({ path: info.outputPath("return-waiting.png") });
    release();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    await expect(page.locator("[data-app-collaborate]")).toBeHidden();
    await expect(editor).toHaveValue("切换期间保留编辑器");
    await expect(page.locator("#composer-input")).toHaveValue("保留对话草稿");
    const frames = await page.evaluate(() => {
      window.captureReturn = false;
      return window.returnFrames;
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.filter((frame) => !frame.editor || (frame.task && !frame.taskOnLeft))).toEqual([]);
    await page.screenshot({ path: info.outputPath("return-ready.png") });
  } finally {
    release();
    await d.stop();
  }
});

test("direct actions remain reachable on narrow application views", async ({ page }, info) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    for (const width of [474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const tasks = page.locator('[data-sidebar-view="tasks"]');
      const navigation = page.locator('[data-sidebar-view="navigation"]');
      if (!(await tasks.isVisible()))
        await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
      await expect(tasks).toBeInViewport();
      await tasks.click();
      await expect(page.locator("#agent-pane")).toBeVisible();
      await expect(page.locator(".conversation-sidebar")).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`task-panel-${width}.png`) });
      await navigation.click();
      await expect(page.locator("#agent-pane")).toBeHidden();
      await expect(tasks).toBeInViewport();
      await expect(page.locator(".conversation-sidebar")).toBeVisible();
      await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    }
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(page.locator("body")).toHaveClass(/application-task-layout/);
  } finally {
    await d.stop();
  }
});

test("the title switch respects reduced motion and preserves its choice when the workspace collapses", async ({
  page
}) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await page.locator("[data-app-collaborate]").click();
    const navigation = page.getByRole("button", { name: "显示默认侧栏", exact: true });
    const tasks = page.getByRole("button", { name: "显示任务面板", exact: true });
    await expect(navigation.getByText("任务面板", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "任务面板", exact: true })).toBeVisible();
    await page.locator("#composer-input").fill("翻转时保留草稿");
    await navigation.click();
    await expect(tasks).toBeFocused();
    await expect(tasks).toBeEnabled();
    expect(
      await page
        .locator("[data-sidebar-view]")
        .evaluateAll((buttons) => buttons.flatMap((button) => button.getAnimations()).length)
    ).toBe(0);
    await tasks.click();
    await expect(navigation).toBeVisible();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await navigation.click();
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    const reopen = page.getByRole("button", { name: "展开工作区", exact: true });
    await expect(page.locator('[data-sidebar-view="navigation"]')).toBeEnabled();
    await expect(page.locator("#workbench")).toBeHidden();
    await expect(page.locator(".conversation-sidebar")).toBeVisible();
    await expect(reopen).toBeFocused();
    await expect(page.locator("#composer-input")).toHaveValue("翻转时保留草稿");
    await reopen.click();
    await expect(tasks).toBeVisible();
    await tasks.click();
    await expect(navigation).toBeVisible();
    await expect(navigation).toBeEnabled();
    // Hiding the sidebar during a flip cancels its pending view change.
    await page.evaluate(() => {
      document.querySelector('[data-sidebar-view="navigation"]').click();
      document.querySelector('.window-nav[aria-label="切换侧栏"]').click();
    });
    await expect(page.locator('[data-sidebar-view="navigation"]')).toBeEnabled();
    await expect(page.locator("#agent-pane")).toBeHidden();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
    const sidebarToggle = page.getByRole("button", { name: "切换侧栏", exact: true });
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
    await sidebarToggle.click();
    await expect(navigation).toBeVisible();
    await expect(page.locator(".conversation-sidebar")).toBeHidden();
  } finally {
    await d.stop();
  }
});

test("the left task panel can be resized and shares its saved width with navigation", async ({
  page
}, info) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("调整宽度.txt");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const editor = page.locator("[data-editor-input]:visible");
    await editor.fill("调整侧栏不改变文档");
    await editor.press("ControlOrMeta+s");
    await page.locator("[data-app-collaborate]").click();
    await page.locator("#composer-input").fill("调整侧栏不改变草稿");
    const pane = page.locator("#agent-pane");
    const divider = page.locator("#sidebar-divider");
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(pane).toBeVisible();
      await expect(divider).toBeVisible();
      await expect(divider).toHaveAccessibleName("调整任务面板宽度");
      await expect(divider).toHaveAttribute("aria-controls", "agent-pane");
      const before = await pane.boundingBox();
      const handle = await divider.boundingBox();
      expect(handle.x + 3).toBeCloseTo(before.x + before.width, 0);
      await page.mouse.move(handle.x + 3, handle.y + 150);
      await page.mouse.down();
      await page.mouse.move(handle.x + 63, handle.y + 150, { steps: 6 });
      await page.mouse.up();
      await expect.poll(async () => (await pane.boundingBox()).width).toBeGreaterThan(before.width + 40);
      const grown = (await pane.boundingBox()).width;
      await divider.press("ArrowLeft");
      await expect.poll(async () => (await pane.boundingBox()).width).toBeCloseTo(grown - 16, 0);
      const taskWidth = (await pane.boundingBox()).width;
      await page.getByRole("button", { name: "显示默认侧栏", exact: true }).click();
      const navigation = page.locator("#conversation-sidebar");
      await expect(navigation).toBeVisible();
      await expect(divider).toHaveAccessibleName("调整会话侧栏宽度");
      await expect(divider).toHaveAttribute("aria-controls", "conversation-sidebar");
      await expect.poll(async () => (await navigation.boundingBox()).width).toBeCloseTo(taskWidth, 0);
      await divider.press("ArrowRight");
      await expect.poll(async () => (await navigation.boundingBox()).width).toBeCloseTo(taskWidth + 16, 0);
      await page.getByRole("button", { name: "显示任务面板", exact: true }).click();
      await expect(pane).toBeVisible();
      await expect.poll(async () => (await pane.boundingBox()).width).toBeCloseTo(taskWidth + 16, 0);
      await expect(editor).toHaveValue("调整侧栏不改变文档");
      await expect(page.locator("#composer-input")).toHaveValue("调整侧栏不改变草稿");
      await page.screenshot({ path: info.outputPath(`resized-tasks-${width}.png`) });
    }
    const savedWidth = (await pane.boundingBox()).width;
    await page.reload();
    await expect(pane).toBeVisible();
    await expect.poll(async () => (await pane.boundingBox()).width).toBeCloseTo(savedWidth, 0);
    await divider.press("Home");
    await expect.poll(async () => (await pane.boundingBox()).width).toBe(180);
    expect(
      await page.locator(".output-heading").evaluate((node) => node.scrollWidth <= node.clientWidth)
    ).toBe(true);
    await divider.press("End");
    await expect.poll(async () => (await pane.boundingBox()).width).toBe(420);
    const handle = await divider.boundingBox();
    await page.mouse.dblclick(handle.x + 3, handle.y + 150);
    await expect.poll(async () => (await pane.boundingBox()).width).toBeLessThan(420);
    await page.setViewportSize({ width: 474, height: 900 });
    await expect(divider).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(474);
  } finally {
    await d.stop();
  }
});

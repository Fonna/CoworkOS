import { openApplicationFileMenu } from "./application-file-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

const test = base.extend({
  dashboard: async ({}, use) => {
    const server = await startDashboard();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
  page: async ({ page, dashboard }, use) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.prompt = () => {
        throw new Error("prompt() is not supported");
      };
    });
    // Fonts are optional presentation assets; these tests run without external services.
    await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await page.goto(dashboard.base);
    await use(page);
    expect(errors, "no uncaught page errors").toEqual([]);
  }
});

async function createDocument(page, name = "浏览器验收.txt") {
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="text-editor"]').click();
  await confirmApplicationWorkspace(page);
  await page.locator("[data-empty-new]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill(name);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator("[data-editor-input]")).toBeEnabled();
}

async function save(page, content) {
  await page.locator("[data-editor-input]").fill(content);
  await page.locator("[data-editor-input]").press("Control+s");
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "saved");
}

test("TXT creation, rename, clearing, undo, download and reload work in Chromium", async ({ page }) => {
  const content = "真实浏览器验证\n中文与 Emoji 😀\n";
  await createDocument(page);
  await expect(page.locator("#session-menu-button")).toBeHidden();
  await save(page, content);
  await page.locator("[data-editor-rename]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("重命名后的文档.txt");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator("[data-editor-title]")).toHaveText("重命名后的文档.txt");
  await save(page, "");
  await page.locator("[data-editor-undo]").click();
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "saved");
  const downloaded = page.waitForEvent("download");
  await openApplicationFileMenu(page);
  await page.locator("[data-editor-download]").click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("重命名后的文档.txt");
  expect(await readFile(await file.path(), "utf8")).toBe(content);
  await page.reload();
  await expect(page.locator("[data-editor-input]")).toHaveValue(content);
  await page.locator("[data-editor-history-toggle]").click();
  await expect(page.locator("[data-editor-history-pane]")).toBeVisible();
});

test("a failed background poll retains the editor and a failed save retains its draft", async ({ page }) => {
  await createDocument(page);
  await save(page, "已保存的内容\n");
  await page.route("**/api/workbench/tabs", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"temporarily unavailable"}'
      });
    return route.continue();
  });
  await page.route("**/operations", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"save unavailable"}' })
  );
  await page.locator("[data-editor-input]").fill("唯一的未保存草稿\n");
  await page.locator("[data-editor-input]").press("Control+s");
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#toast")).toContainText("当前文档已保留");
  await expect(page.locator("[data-editor-input]")).toHaveValue("唯一的未保存草稿\n");
  await page.unroute("**/api/workbench/tabs");
  await page.unroute("**/operations");
  await page.locator("[data-editor-save]").click();
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator("[data-editor-input]")).toHaveValue("唯一的未保存草稿\n");
});

test("shared edits arrive through real SSE across conversations without replacing a draft", async ({
  page,
  dashboard,
  request
}) => {
  await createDocument(page);
  await save(page, "共享的原文\n");
  await loadCurrentApplication(page, { newConversation: true });
  await expect(page.locator("#conversation-pane")).toBeVisible();
  const tasks = (await (await request.get(`${dashboard.base}/api/tasks`)).json()).tasks;
  const taskId = tasks.find((task) => task.taskId !== "workspace").taskId;
  const tabs = (await (await request.get(`${dashboard.base}/api/workbench/tabs`)).json()).tabs;
  const resourceId = tabs.find((tab) => tab.resourceId).resourceId;
  const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
  // Persist running task metadata to enable the real SSE path, without starting a model.
  await store.createRun(taskId, "browser-sse");
  await store.createTask("other-conversation", { goal: "另一个协作者" });
  const referenced = await request.post(`${dashboard.base}/api/workbench/bind-resource`, {
    data: { taskId: "other-conversation", fromTaskId: taskId, resourceId, appType: "text-editor" }
  });
  expect(referenced.ok()).toBe(true);
  await page.reload();
  await page.locator(`#project-list [data-task="${taskId}"]`).click();
  await page
    .locator(`[data-tab-rail] [data-tab="${tabs.find((tab) => tab.resourceId === resourceId).tabId}"]`)
    .click();
  await expect(page.locator("[data-editor-input]")).toHaveValue("共享的原文\n");
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  await page.route("**/operations", async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator("[data-editor-input]").fill("我的未保存草稿\n");
  await page.locator("[data-editor-input]").press("Control+s");
  const before = await (
    await request.get(`${dashboard.base}/api/tasks/${taskId}/resources/${resourceId}`)
  ).json();
  const edited = await request.post(
    `${dashboard.base}/api/tasks/other-conversation/resources/${resourceId}/operations`,
    {
      data: {
        operationId: "browser-remote",
        appType: "text-editor",
        operationType: "text.rewrite",
        baseRevision: before.resource.revision,
        payload: { content: "另一对话保存的内容\n" }
      }
    }
  );
  expect(edited.ok()).toBe(true);
  try {
    await expect(page.locator("[data-editor-conflict]")).toBeVisible();
    await expect(page.locator("[data-editor-input]")).toHaveValue("我的未保存草稿\n");
  } finally {
    release();
  }
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "conflict");
  await page.unroute("**/operations");
  await page.locator("[data-editor-input]").fill("明确合并后的内容\n");
  await page.locator('[data-conflict="merge"]').click();
  await expect(page.locator("[data-editor-status]")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator("[data-editor-input]")).toHaveValue("明确合并后的内容\n");
});

test("the application entry remains reachable in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 752, height: 748 });
  await expect(page.locator("#apps-nav")).not.toBeVisible();
  await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await expect(page.locator("#apps-nav")).toBeVisible();
  await createDocument(page, "窄窗口.txt");
  await save(page, "窄窗口中新建成功\n");
  await expect(page.locator("[data-editor-input]")).toHaveValue("窄窗口中新建成功\n");
});

test("document menus, naming dialogs and tabs keep keyboard focus usable", async ({ page }) => {
  await createDocument(page, "键盘验收.txt");
  const open = page.locator("[data-editor-open]");
  await open.press("ArrowDown");
  await expect(page.locator("[data-open-new]")).toBeFocused();
  await page.locator("[data-open-new]").press("Escape");
  await expect(page.locator("[data-editor-open-sheet]")).toBeHidden();
  await expect(open).toBeFocused();
  const rename = page.locator("[data-editor-rename]");
  await rename.click();
  const name = page.getByRole("textbox", { name: "文件名" });
  await expect(name).toBeFocused();
  await name.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "保存名称", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "保存名称", exact: true }).press("Tab");
  await expect(name).toBeFocused();
  await name.press("Escape");
  await expect(page.getByRole("dialog", { name: "重命名", exact: true })).toBeHidden();
  await expect(rename).toBeFocused();
  await expect(page.locator("[data-editor-title]")).toHaveText("键盘验收.txt");
  await page.setViewportSize({ width: 960, height: 751 });
  const railTabs = page.locator("[data-tab-rail] [data-tab]");
  const active = page.locator('[data-tab-rail] [data-tab][aria-pressed="true"]');
  await active.press("Home");
  await expect(railTabs.first()).toHaveAttribute("aria-pressed", "true");
  await expect(railTabs.first()).toBeFocused();
  await railTabs.first().press("End");
  await expect(railTabs.last()).toHaveAttribute("aria-pressed", "true");
  await expect(railTabs.last()).toBeFocused();
  await expect(page.locator("[data-editor-input]")).toBeVisible();
  for (const width of [474, 320]) {
    await page.setViewportSize({ width, height: 751 });
    await expect(page.locator("[data-editor-save]")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tab = document.querySelector('[data-tab-rail] [data-tab][aria-pressed="true"]');
          const strip = document.querySelector("[data-tab-rail]");
          if (!tab || !strip) return false;
          const selected = tab.getBoundingClientRect(),
            row = strip.getBoundingClientRect();
          return selected.width > 0 && selected.left >= row.left && selected.right <= row.right + 1;
        })
      )
      .toBe(true);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      topbar: [...document.querySelectorAll(".window-controls, .topbar-context, .topbar-actions")].map(
        (el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right };
        }
      )
    }));
    expect(layout.scroll).toBeLessThanOrEqual(layout.width);
    for (let i = 1; i < layout.topbar.length; i++)
      expect(layout.topbar[i].left).toBeGreaterThanOrEqual(layout.topbar[i - 1].right);
  }
});

test("shell dialogs dismiss with Escape and restore focus", async ({ page }) => {
  // Browser previews retain navigation without pretending to be a native window.
  await expect(page.locator(".traffic")).toHaveCount(0);
  await expect(page.locator(".chat-header")).toHaveCount(0);
  await expect(page.locator(".topbar-actions button")).toHaveCount(1);
  await expect(page.locator("#share-button")).toHaveCount(0);
  const panelToggle = page.getByRole("button", { name: "切换任务面板", exact: true });
  await expect(page.locator("#agent-pane")).toBeHidden();
  await expect(panelToggle).toHaveAttribute("aria-expanded", "false");
  const profile = page.locator("#user-menu-button");
  const menuTrigger = page.locator("#session-menu-button");
  const menu = page.locator("#session-menu");
  await expect(menuTrigger).toBeVisible();
  await menuTrigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(7);
  for (const action of ["rename", "pin", "unread", "export", "open", "archive"])
    await expect(menu.locator(`[data-session-action="${action}"]`)).toBeDisabled();
  await expect(menu.locator('[data-session-submenu="copy"]')).toBeDisabled();
  await expect(menu.locator('[data-session-action="stop"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuTrigger).toBeFocused();
  for (const width of [1440, 1280, 474, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(menuTrigger).toBeVisible();
    await expect(panelToggle).toBeVisible();
    await expect(page.locator("#agent-pane")).toBeHidden();
    const collapsed = await page
      .locator("body")
      .evaluate((node) => node.classList.contains("output-collapsed"));
    await panelToggle.click();
    await expect
      .poll(() => page.locator("body").evaluate((node) => node.classList.contains("output-collapsed")))
      .toBe(!collapsed);
    await expect(page.locator("#agent-pane")).toBeVisible();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "true");
    await panelToggle.click();
    await expect(page.locator("#agent-pane")).toBeHidden();
    await expect(panelToggle).toHaveAttribute("aria-expanded", "false");
    if (!(await profile.isVisible()))
      await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    await profile.click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings).toBeVisible();
    const box = await settings.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
    await expect(profile).toBeFocused();
    if (width <= 900) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await page.locator("html").getAttribute("data-desktop-platform")).toBeNull();
  expect(
    await page
      .locator(".app-topbar")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("-webkit-app-region"))
  ).not.toBe("drag");
  await profile.click();
  const close = page.locator("#profile-close");
  const memory = page.getByRole("checkbox", { name: "使用个人记忆", exact: true });
  const appearance = page.locator("#appearance-select");
  await expect(page.locator("#profile-modal .computer-setting")).toHaveCount(1);
  await expect(page.locator("#computer-access-enabled")).toBeDisabled();
  await expect(page.getByRole("switch", { name: "流星动态背景" })).toHaveCount(0);
  await expect(close).toBeFocused();
  await close.press("Tab");
  await expect(appearance).toBeFocused();
  await appearance.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.press("Tab");
  await expect(appearance).toBeFocused();
  await appearance.press("Tab");
  await expect(memory).toBeFocused();
  await memory.press("Escape");
  await expect(page.locator("#profile-modal")).toBeHidden();
  await expect(profile).toBeFocused();
  await expect(page.locator("#details-modal, #details-close")).toHaveCount(0);
});

test("conversation and file share a resizable workspace without losing input, selection or drafts", async ({
  page
}) => {
  await page.locator("#new-conversation").click();
  await createDocument(page, "并排协作.txt");
  await save(page, "人工编辑的文字");
  await loadCurrentApplication(page, { newConversation: true });
  await expect(page.locator("#conversation-pane")).toBeVisible();
  await page.locator("[data-composer-context]").click();
  const editor = page.locator("[data-app-mount]:not([hidden])");
  await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
  await expect(page.locator("#conversation-pane")).toBeVisible();
  await expect(page.locator("[data-tab-strip]")).toBeHidden();
  await expect(page.getByRole("button", { name: "返回对话", exact: true })).toBeHidden();
  await page.locator("#composer-input").fill("请在这段文字上继续修改");
  const input = editor.locator("[data-editor-input]");
  await input.focus();
  await input.press("Home");
  await input.press("Shift+ArrowRight");
  await expect(page.locator("[data-composer-context]")).toContainText("选中：1 字符");
  const sidebarDivider = page.getByRole("separator", { name: "调整会话侧栏宽度" });
  const sidebar = page.locator(".conversation-sidebar");
  const sidebarWidth = (await sidebar.boundingBox()).width;
  const handle = await sidebarDivider.boundingBox();
  await page.mouse.move(handle.x + 3, handle.y + 120);
  await page.mouse.down();
  await page.mouse.move(handle.x + 63, handle.y + 120, { steps: 5 });
  await page.mouse.up();
  expect((await sidebar.boundingBox()).width).toBeGreaterThan(sidebarWidth + 40);
  await expect(input).toHaveValue("人工编辑的文字");
  await expect(page.locator("#composer-input")).toHaveValue("请在这段文字上继续修改");
  await page.screenshot({ path: ".tmp/sidebar-split-preview.png" });
  const divider = page.getByRole("separator", { name: "调整对话与工作台宽度" });
  await expect(divider).toHaveAttribute("aria-valuenow", "42");
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "44");
  const boundBefore = await page.locator("#app-bind-select").textContent();
  await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
  await expect(page.locator("#conversation-pane")).toBeHidden();
  await expect(page.getByRole("button", { name: "返回对话", exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("人工编辑的文字");
  await page.getByRole("button", { name: "恢复并排协作", exact: true }).click();
  await expect(page.locator("#composer-input")).toHaveValue("请在这段文字上继续修改");
  await expect(page.locator("#app-bind-select")).toHaveText(boundBefore);
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(page.locator("[data-app-mount]:not([hidden])")).toHaveCount(0);
  await expect(page.locator("#conversation-pane")).toBeVisible();
  await page.locator("[data-composer-context]").click();
  await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
  await expect(input).toHaveValue("人工编辑的文字");
  await page.locator("#new-conversation").click();
  await expect(page.locator("[data-composer-context]")).toBeHidden();
  await expect(page.locator(".chat-pane")).not.toHaveClass(/is-collaborating/);
  await page.locator("[data-task]").filter({ hasText: "编辑《并排协作》" }).first().click();
  await page.locator("#apps-nav").click();
  await page.locator("#apps-panel [data-open-resource]").click();
  await expect(page.locator("#app-bind-select")).toContainText("并排协作.txt");
  await expect(page.locator("#conversation-pane")).toBeHidden();
  await page.getByRole("button", { name: "恢复并排协作", exact: true }).click();
  await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
  const boxes = await page.evaluate(() =>
    ["#conversation-pane", "#workbench", "#send-button"].map((selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    })
  );
  expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left);
  expect(boxes[2].right).toBeLessThanOrEqual(boxes[0].right);
  for (const width of [1280, 1100, 960, 474, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(input).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width >= 1100) {
      const chat = await page.locator("#conversation-pane").boundingBox();
      const send = await page.locator("#send-button").boundingBox();
      expect(send.x + send.width).toBeLessThanOrEqual(chat.x + chat.width);
    }
    if (width < 1100) {
      await page.getByRole("button", { name: "收起工作区", exact: true }).click();
      await expect(page.locator("#composer-input")).toBeVisible();
      await page.getByRole("button", { name: "展开工作区", exact: true }).click();
    }
  }
});

test("switching conversations while a bound app is open keeps the new selection and both drafts", async ({
  page,
  dashboard
}) => {
  await page.request.post(`${dashboard.base}/api/tasks`, {
    data: { taskId: "switch-target", goal: "另一个会话" }
  });
  await page.request.post(`${dashboard.base}/api/tasks`, {
    data: { taskId: "switch-source", goal: "原会话" }
  });
  await page.reload();
  await page.locator('.conversation-item[data-task="switch-source"]').click();
  await createDocument(page, "切换保留.txt");
  await save(page, "已保存的原文");
  await loadCurrentApplication(page, { taskId: "switch-source" });
  await expect(page.locator("#conversation-pane")).toBeVisible();
  await page.locator("[data-composer-context]").click();
  await expect
    .poll(
      async () => (await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json()).activeTabId
    )
    .toMatch(/^window:/);
  const original = await page.locator(".conversation-item.active").getAttribute("data-task");
  expect(original).toBe("switch-source");
  await page.locator("#composer-input").fill("原会话的草稿");
  await page.locator("[data-editor-input]").fill("应用里尚未保存的修改");
  let release,
    opening = false,
    polls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workbench/tabs", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.postDataJSON()?.taskId === "switch-target") {
      const response = await route.fetch();
      opening = true;
      await gate;
      await route.fulfill({ response });
    } else {
      await route.continue();
      if (opening && request.method() === "GET") polls++;
    }
  });
  try {
    await page.locator('.conversation-item[data-task="switch-target"]').click();
    await expect.poll(() => polls).toBeGreaterThan(0);
    await expect(page.locator('.conversation-item[data-task="switch-target"]')).toHaveClass(/active/);
  } finally {
    release();
  }
  await expect(page.locator("#topbar-task")).toHaveText("另一个会话");
  await expect(page.locator('.conversation-item[data-task="switch-target"]')).toHaveClass(/active/);
  await page.locator("#composer-input").fill("另一个会话的草稿");
  await expect
    .poll(
      async () => (await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json()).activeTabId
    )
    .toBe("conversation:switch-target");
  await page.locator(`.conversation-item[data-task="${original}"]`).click();
  await expect(page.locator("#composer-input")).toHaveValue("原会话的草稿");
  await expect(page.locator("[data-editor-input]")).toBeVisible();
  await expect(page.locator("[data-editor-input]")).toHaveValue("应用里尚未保存的修改");
  await page.locator('.conversation-item[data-task="switch-target"]').click();
  await expect(page.locator("#composer-input")).toHaveValue("另一个会话的草稿");
  await page.reload();
  await expect(page.locator("#topbar-task")).toHaveText("另一个会话");
  await page.unrouteAll({ behavior: "wait" });
});

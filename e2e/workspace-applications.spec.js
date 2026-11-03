import { useApplicationInConversation } from "./workbench-menu-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("application creation, loading and collaboration stay in the owning workspace", async ({ page }) => {
  const dashboard = await startDashboard();
  const otherRoot = join(dashboard.root, "project-B");
  await mkdir(otherRoot);
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await post("/api/tasks", { taskId: "a", goal: "A 的对话" });
    await post("/api/tasks", { taskId: "b", goal: "B 的对话", workspaceRoot: otherRoot });
    await post("/api/tasks", { taskId: "b-other", goal: "B 的其他对话", workspaceRoot: otherRoot });
    const a = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: dashboard.workspaceRoot
    });
    await post(`/api/workbench/instances/${a.appInstance.appInstanceId}/resources`, {
      kind: "text/markdown",
      title: "A 文档.md",
      initialContent: "A"
    });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "b" });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="b"]').click();
    // Preserve the explicit project-root workflow while independent launches now use temporary storage.
    const openedB = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: otherRoot
    });
    await page.locator("#apps-nav").click();
    if (!(await page.locator('[data-app-instances="text-editor"]').isVisible()))
      await page.locator('[data-toggle-instances="text-editor"]').click();
    await page.locator(`[data-open-instance="window:${openedB.appInstance.appInstanceId}"]`).click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    const b = (await get("/api/workbench/tabs")).tabs.find(
      (tab) => tab.kind === "application" && tab.appInstanceId !== a.appInstance.appInstanceId
    );
    expect(b.workspaceRoot).toBe(otherRoot);
    await expect(page.locator("[data-empty-list]")).not.toContainText("A 文档");
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("B 文档.md");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator("[data-editor-input]:visible")).toBeEnabled();
    await page.locator("[data-editor-open]:visible").click();
    await expect(page.locator("[data-editor-open-sheet]:visible")).not.toContainText("A 文档");
    await page.locator("[data-open-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("B 第二份.md");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator("[data-editor-title]:visible")).toHaveText("B 第二份.md");
    const sibling = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.title === "B 第二份.md");
    expect(sibling.workspaceRoot).toBe(otherRoot);

    // Restore B while A is selected: navigation is global, loading is scoped.
    await page.locator('#project-list [data-task="a"]').click();
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${a.appInstance.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${b.appInstanceId}"]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    if (!(await page.locator('[data-app-instances="text-editor"]').isVisible()))
      await page.locator('[data-toggle-instances="text-editor"]').click();
    await expect(page.locator(`[data-open-instance="${b.tabId}"]`)).toContainText("project-B");
    await page.locator(`[data-open-instance="${b.tabId}"]`).click();
    await useApplicationInConversation(page);
    // Returning from B cannot silently reuse A's selected conversation.
    await expect(page.locator("#project-context")).toHaveAttribute("title", otherRoot);
    await expect(page.getByRole("menu", { name: "与 AI 协作" })).toHaveCount(0);
    await expect(page.locator("#app-bind-select")).toContainText("B 文档.md");
    expect((await get("/api/tasks")).tasks).toHaveLength(4);
    await loadCurrentApplication(page, { taskId: "b", appInstanceId: b.appInstanceId });
    await expect(page.locator('#project-list [data-task="b"]')).toHaveClass(/active/);
    await expect(page.locator("#app-bind-select")).toContainText("B 文档.md");
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${a.appInstance.appInstanceId}"]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Select a different workspace, restore B, and return to B's loaded chat.
    await page.locator('#project-list [data-task="a"]').click();
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    await page.locator(`[data-open-instance="${b.tabId}"]`).click();
    const returningTask = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.tabId === b.tabId)
      .loadedConversations[0].taskId;
    await useApplicationInConversation(page);
    await expect(page.locator(`#project-list [data-task="${returningTask}"]`)).toHaveClass(/active/);
    await expect(page.locator("#app-bind-select")).toContainText("B 文档.md");
    await loadCurrentApplication(page, { taskId: "b-other", appInstanceId: b.appInstanceId });
    expect((await get("/api/tasks/b-other/app-instances")).loadedInstanceId).toBe(b.appInstanceId);
    expect((await get("/api/tasks/b/app-instances")).loadedInstanceId).toBe(b.appInstanceId);
    const forbidden = await page.request.post(`${dashboard.base}/api/workbench/load-instance`, {
      data: { taskId: "a", appInstanceId: b.appInstanceId }
    });
    expect(forbidden.ok()).toBe(false);
    expect((await get("/api/tasks/a/app-instances")).loadedInstanceId).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("a delayed return from another workspace cannot overwrite a later conversation choice", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const otherRoot = join(dashboard.root, "return-project-B");
  await mkdir(otherRoot);
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = false;
  let delayedCompleted = 0;
  try {
    await post("/api/tasks", { taskId: "return-a", goal: "会话 A 的草稿" });
    await post("/api/projects", { projectName: "返回项目 B", projectDirectory: otherRoot });
    const opened = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: otherRoot
    });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "return-a" });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="return-a"]').click();
    await page.locator("#composer-input").fill("保留 A 的未发送草稿");
    await page.locator("#apps-nav").click();
    if (!(await page.locator('[data-app-instances="text-editor"]').isVisible()))
      await page.locator('[data-toggle-instances="text-editor"]').click();
    await page.locator(`[data-open-instance="window:${opened.appInstance.appInstanceId}"]`).click();
    await page.route("**/api/workbench/load-instance", async (route) => {
      if (route.request().method() === "POST") {
        const response = await route.fetch();
        waiting = true;
        await gate;
        await route.fulfill({ response });
        delayedCompleted++;
      } else await route.continue();
    });
    await useApplicationInConversation(page);
    await expect.poll(() => waiting).toBe(true);
    // The new conversation owns its draft while automatic loading is pending.
    await expect(page.locator(".conversation-item.active")).toHaveCount(1);
    await expect(page.locator("#composer-input")).toHaveValue("");
    await expect(page.locator("#project-context")).toHaveAttribute("title", otherRoot);
    await page.locator('#project-list [data-task="return-a"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("保留 A 的未发送草稿");
    release();
    await expect.poll(() => delayedCompleted).toBe(1);
    await expect(page.locator("#project-context")).toHaveAttribute("title", dashboard.workspaceRoot);
    await expect(page.locator('#project-list [data-task="return-a"]')).toHaveClass(/active/);
    await expect(page.locator("#app-bind-select")).not.toHaveClass(/is-bound/);
    expect(
      (await (await page.request.get(`${dashboard.base}/api/tasks/return-a`)).json()).applications
        .loadedInstanceId
    ).toBeUndefined();
    await expect(page.locator("#composer-input")).toHaveValue("保留 A 的未发送草稿");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json()).activeTabId
      )
      .toBe("conversation:return-a");
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await dashboard.stop();
  }
});

test("independent launching stays temporary even with a selected project and explicit roots remain available", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const b = join(dashboard.root, "project-B");
  await mkdir(b);
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  try {
    await post("/api/tasks", { taskId: "a", goal: "保留 A 对话" });
    await post("/api/workbench/workspaces", { workspaceRoot: b });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "a" });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="a"]').click();
    await page.locator("#composer-input").fill("保留项目对话草稿");
    for (let count = 1; count <= 2; count++) {
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="text-editor"]').click();
      await expect(page.getByRole("dialog", { name: /^新建.*实例$/ })).toHaveCount(0);
      await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
      await expect
        .poll(
          async () =>
            (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application").length
        )
        .toBe(count);
    }
    const tabs = (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application");
    expect(new Set(tabs.map((tab) => tab.workspaceRoot)).size).toBe(2);
    expect(tabs.every((tab) => tab.project === null && tab.loadedConversations.length === 0)).toBe(true);
    expect(tabs.every((tab) => ![dashboard.workspaceRoot, b].includes(tab.workspaceRoot))).toBe(true);
    await page.locator('#project-list [data-task="a"]').click();
    await expect(page.locator("#composer-input")).toHaveValue("保留项目对话草稿");
    const explicit = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: b
    });
    expect(
      explicit.tabs.find((tab) => tab.appInstanceId === explicit.appInstance.appInstanceId).workspaceRoot
    ).toBe(b);
    const tasks = await get("/api/tasks");
    expect(tasks.currentWorkspaceRoot).toBe(dashboard.workspaceRoot);
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0].storageRoot).toBe(dashboard.workspaceRoot);
    expect((await get("/api/tasks/a/app-instances")).loadedInstanceId).toBeUndefined();
  } finally {
    await dashboard.stop();
  }
});

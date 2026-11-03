import { useApplicationInConversation } from "./workbench-menu-helper.js";
import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("a first independent document returns to a loaded conversation and keeps its draft recoverable", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(dashboard.base);
    await expect(page.locator(".project-group")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "有什么可以帮忙的？", exact: true })).toBeVisible();
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#team-view")).toBeHidden();
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await confirmApplicationWorkspace(page);
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("第一份文档.md");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator("[data-editor-input]:visible")).toBeEnabled();
    await page.locator("[data-editor-input]:visible").fill("# 保留这份文档\n");
    await page.locator("[data-editor-save]:visible").click();
    await expect(page.locator("[data-editor-status]:visible")).toHaveAttribute("data-state", "saved");
    await expect(page.locator("#topbar-task")).toHaveText("第一份文档.md");
    await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.locator("[data-editor-title]:visible")).toHaveText("第一份文档.md");
    const identity = await page.locator(".editor-menu-identity:visible").boundingBox();
    expect(identity.width).toBeGreaterThan(150);
    await expect(page.locator("[data-editor-save]:visible")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("narrow-text-editor-fixed.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await useApplicationInConversation(page);
    await expect(page.getByRole("dialog", { name: "新建项目", exact: true })).toHaveCount(0);
    await expect(page.locator(".project-group")).toHaveCount(0);
    await expect(page.locator(".temporary-conversations .conversation-item")).toHaveText(
      "编辑《第一份文档》"
    );
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.locator("#topbar-task")).toHaveText("编辑《第一份文档》");
    await expect(page.locator("#app-bind-select")).toContainText("第一份文档.md");
    await page.locator("#composer-input").fill("与这份文档继续协作");
    await page.reload();
    await expect(page.locator("#composer-input")).toHaveValue("与这份文档继续协作");
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("app launches are independent; restoration and collaboration have explicit destinations", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  const launch = async () => {
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/workbench/open-application") && r.request().method() === "POST"
    );
    await page.locator('[data-create-app="text-editor"]').click();
    await confirmApplicationWorkspace(page);
    await response;
    await expect(page.locator("#apps-nav")).toBeEnabled();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(page.locator("#project-context")).toBeHidden();
  };
  const createFile = async (title) => {
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill(title);
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator("[data-editor-input]:visible")).toBeEnabled();
  };
  try {
    await post("/api/tasks", { taskId: "old", goal: "之前的会话" });
    await post("/api/tasks", { taskId: "target", goal: "明确选择的会话" });
    await page.goto(dashboard.base);
    await page.locator('[data-task="old"]').first().click();
    await expect(page.locator("#project-context")).toBeVisible();
    await expect(page.locator("#project-context")).toHaveText("测试项目");
    await launch();
    const first = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.kind === "application");
    expect(first.taskId).toBeUndefined();
    await launch();
    let applications = (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application");
    expect(applications).toHaveLength(2);
    expect(new Set(applications.map((tab) => tab.appInstanceId)).size).toBe(2);
    expect((await get("/api/tasks")).tasks).toHaveLength(2);
    await createFile("第二个实例.md");
    const second = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.resourceId);
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await page.locator(`[data-open-instance="${first.tabId}"]`).click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    expect((await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application")).toHaveLength(
      2
    );
    await createFile("第一个实例.md");
    const firstResource = (await get("/api/workbench/tabs")).tabs.find(
      (tab) => tab.resourceId && tab.resourceId !== second.resourceId
    );
    await useApplicationInConversation(page);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.locator("#project-context")).toBeVisible();
    await expect(page.locator("#project-context")).toHaveText("测试项目");
    await expect(page.getByRole("menu", { name: "与 AI 协作" })).toHaveCount(0);
    expect((await get("/api/tasks/old/resources")).resources.map((resource) => resource.resourceId)).toEqual([
      firstResource.resourceId
    ]);
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    await page.locator(`[data-open-instance="${firstResource.tabId}"]`).click();

    // Unsaved edits must be saved before the document is loaded into a conversation.
    await page.locator("[data-editor-input]:visible").fill("协作前保存的修改");
    await page.route("**/operations", (route) =>
      route.fulfill({ status: 503, json: { error: "save failed" } })
    );
    await page.locator('#project-list [data-task="target"]').click();
    await page.locator("#app-bind-select").click();
    await page.locator(`[data-bind-instance="${firstResource.appInstanceId}"]`).click();
    await expect(page.locator("#toast")).toContainText("请先保存草稿");
    expect((await get("/api/tasks/target/resources")).resources).toHaveLength(0);
    await page.unroute("**/operations");
    await loadCurrentApplication(page, { taskId: "target", appInstanceId: firstResource.appInstanceId });
    await expect(page.locator('.conversation-item[data-task="target"]')).toHaveClass(/active/);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    expect((await get("/api/tasks/target/resources")).resources.map((r) => r.resourceId)).toEqual([
      firstResource.resourceId
    ]);
    expect((await get("/api/tasks/old/resources")).resources.map((resource) => resource.resourceId)).toEqual([
      firstResource.resourceId
    ]);
    applications = (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application");
    expect(applications.find((tab) => tab.resourceId === second.resourceId).standalone).toBe(true);
    expect((await get(`/api/tasks/target/resources/${firstResource.resourceId}`)).snapshot.content).toBe(
      "协作前保存的修改"
    );

    // Restoring the second independent instance loads through the same composer.
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    await page.locator(`[data-open-instance="${second.tabId}"]`).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(page.locator("[data-editor-title]:visible")).toHaveText("第二个实例.md");
    await loadCurrentApplication(page, { newConversation: true });
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect.poll(async () => (await get("/api/tasks")).tasks.length).toBe(3);
    const createdTask = (await get("/api/tasks")).tasks.find(
      (task) => !["old", "target"].includes(task.taskId)
    );
    expect(createdTask.status).toBe("created");
    await expect
      .poll(async () =>
        (await get(`/api/tasks/${createdTask.taskId}/resources`)).resources.map((r) => r.resourceId)
      )
      .toEqual([second.resourceId]);

    // A draft conversation is not consumed by launching another independent app.
    await page.locator("#new-conversation").click();
    await page.locator("#composer-input").fill("还未发送的会话草稿");
    await launch();
    await expect(page.locator("#composer-input")).toHaveValue("还未发送的会话草稿");
    expect((await get("/api/tasks")).tasks).toHaveLength(3);
    await loadCurrentApplication(page, { taskId: "old" });
    await expect(page.locator('.conversation-item[data-task="old"]')).toHaveClass(/active/);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    expect((await get("/api/tasks")).tasks).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("not loading an application keeps Blender closed and stays unbound across polls", async ({ page }) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const post = async (path, data) => {
      const response = await page.request.post(`${dashboard.base}${path}`, { data });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await post("/api/tasks", { taskId: "unload", goal: "海滩协作" });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "unload" });
    const { resource } = await post("/api/tasks/unload/resources", {
      kind: "project/atria-blender+json",
      title: "海滩"
    });
    await post("/api/workbench/tabs", {
      kind: "application",
      resourceId: resource.resourceId,
      bindTo: "unload"
    });
    await page.goto(dashboard.base);
    await expect(page.locator("[data-blender-title]:visible")).toHaveText("海滩");
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(page.locator("[data-app-mount]:visible")).toHaveCount(0);
    await expect(page.locator("#app-bind-select")).toContainText("海滩");
    await page.locator("#app-bind-select").click();
    await page.locator('[data-bind-instance="__unbound__"]').click();
    await expect(page.locator("#app-bind-select")).toContainText("未加载应用");
    await expect(page.locator("[data-app-mount]:visible")).toHaveCount(0);
    await expect(page.locator("[data-composer-context]")).toBeHidden();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await page.waitForResponse(
      (r) => r.url().endsWith("/api/workbench/tabs") && r.request().method() === "GET"
    );
    await expect(page.locator("[data-app-mount]:visible")).toHaveCount(0);
    const detail = await (await page.request.get(`${dashboard.base}/api/tasks/unload`)).json();
    expect(detail.applications.boundResourceId).toBeUndefined();
    await page.reload();
    await expect(page.locator("#app-bind-select")).toContainText("未加载应用");
    await expect(page.locator("[data-app-mount]:visible")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("unloading keeps the editor and draft; returning saves and reloads the same instance", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  try {
    await post("/api/tasks", { taskId: "visible", goal: "保留编辑器" });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "visible" });
    const { resource } = await post("/api/tasks/visible/resources", {
      kind: "text/markdown",
      title: "保留.md",
      initialContent: "原文"
    });
    await post("/api/workbench/tabs", {
      kind: "application",
      resourceId: resource.resourceId,
      bindTo: "visible"
    });
    await page.goto(dashboard.base);
    const input = page.locator("[data-editor-input]:visible");
    await expect(input).toHaveValue("原文");
    await page.route("**/operations", (route) =>
      route.fulfill({ status: 503, json: { error: "暂时无法保存" } })
    );
    await input.fill("人工草稿");
    await page.locator("#app-bind-select").click();
    await page.locator('[data-bind-instance="__unbound__"]').click();
    await expect(page.locator("#app-bind-select")).toContainText("未加载应用");
    await expect(input).toHaveValue("人工草稿");
    await page.waitForResponse(
      (r) => r.url().endsWith("/api/workbench/tabs") && r.request().method() === "GET"
    );
    await expect(input).toHaveValue("人工草稿");
    await expect(page.locator("#conversation-pane")).toBeVisible();
    expect((await get("/api/tasks/visible")).applications.boundResourceId).toBeUndefined();
    const tab = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.resourceId === resource.resourceId);
    expect(tab.loadedConversations).toEqual([]);
    expect(tab.conversations.map((entry) => entry.taskId)).toContain("visible");
    await page.locator("[data-app-expand]").click();
    await useApplicationInConversation(page);
    await expect(page.getByRole("menu", { name: "与 AI 协作" })).toHaveCount(0);
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(input).toHaveValue("人工草稿");
    expect((await get("/api/tasks/visible")).applications.boundResourceId).toBeUndefined();
    await page.unroute("**/operations");
    // Returning saves the retained draft and loads the app without a manual selection.
    await useApplicationInConversation(page);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect(page.locator("#app-bind-select")).toContainText("保留.md");
    expect((await get("/api/tasks")).tasks).toHaveLength(1);
    await page.locator("[data-app-expand]").click();
    await useApplicationInConversation(page);
    await expect(page.locator("#conversation-pane")).toBeVisible();
    expect((await get("/api/tasks")).tasks).toHaveLength(1);
    await loadCurrentApplication(page, { newConversation: true, appInstanceId: tab.appInstanceId });
    await expect.poll(async () => (await get("/api/tasks")).tasks.length).toBe(2);
  } finally {
    await dashboard.stop();
  }
});

test("the applications panel scrolls to the last instance in a short window", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await page.setViewportSize({ width: 1100, height: 620 });
    for (let i = 0; i < 9; i++) {
      const response = await page.request.post(`${dashboard.base}/api/workbench/open-application`, {
        data: { appType: "text-editor" }
      });
      expect(response.ok()).toBe(true);
    }
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    const panel = page.locator("#apps-panel");
    await expect.poll(() => panel.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const last = panel.locator("[data-open-instance]").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect.poll(() => panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await last.click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
  } finally {
    await dashboard.stop();
  }
});

test("two conversations load one empty instance and keep the same editor when a document is created", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  const loadedId = async (taskId) => (await get(`/api/tasks/${taskId}`)).applications.loadedInstanceId;
  try {
    await post("/api/tasks", { taskId: "a", goal: "会话 A" });
    await post("/api/tasks", { taskId: "b", goal: "会话 B" });
    const opened = await post("/api/workbench/open-application", { appType: "text-editor" });
    const id = opened.appInstance.appInstanceId;
    await page.goto(dashboard.base);
    await loadCurrentApplication(page, { taskId: "a" });
    await expect(page.locator("#app-bind-select")).toContainText("文本编辑器");
    await expect.poll(() => loadedId("a")).toBe(id);
    if (!(await page.locator("[data-empty-new]:visible").isVisible()))
      await page.getByRole("button", { name: "展开工作区", exact: true }).click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await page.locator("[data-app-expand]").click();
    await loadCurrentApplication(page, { taskId: "b", appInstanceId: id });
    await expect.poll(() => loadedId("b")).toBe(id);
    if (!(await page.locator("[data-empty-new]:visible").isVisible()))
      await page.getByRole("button", { name: "展开工作区", exact: true }).click();
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("同一个实例.md");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.locator("[data-editor-input]:visible")).toBeVisible();
    let tabs = (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tabId).toBe(`window:${id}`);
    expect(tabs[0].loadedConversations.map((entry) => entry.taskId).sort()).toEqual(["a", "b"]);
    await page.locator("#app-bind-select").click();
    await page.locator('[data-bind-instance="__unbound__"]').click();
    await expect(page.locator("#app-bind-select")).toContainText("未加载应用");
    await expect(page.locator("[data-editor-input]:visible")).toBeVisible();
    expect(await loadedId("a")).toBe(id);
    expect(await loadedId("b")).toBeUndefined();
    await page.locator("[data-app-expand]").click();
    await loadCurrentApplication(page, { taskId: "a", appInstanceId: id });
    await expect(page.locator("#app-bind-select")).toContainText("同一个实例.md");
    await page.reload();
    await expect(page.locator("#app-bind-select")).toContainText("同一个实例.md");
    tabs = (await get("/api/workbench/tabs")).tabs.filter((tab) => tab.kind === "application");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].appInstanceId).toBe(id);
  } finally {
    await dashboard.stop();
  }
});

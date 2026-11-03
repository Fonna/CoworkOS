import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { useApplicationInConversation } from "./workbench-menu-helper.js";

test("application names list instances and only the plus creates an instance", async ({ page }, testInfo) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    await page.goto(d.base);
    await page.locator("#apps-nav").click();
    const toggle = page.locator('[data-toggle-instances="text-editor"]');
    await toggle.click();
    const tabs = async () => (await (await page.request.get(`${d.base}/api/workbench/tabs`)).json()).tabs;
    expect((await tabs()).filter((tab) => tab.kind === "application")).toHaveLength(0);
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    const instance = (await tabs()).find((tab) => tab.kind === "application");
    await page.locator("#apps-nav").click();
    await toggle.click();
    await expect(page.locator(`[data-open-instance="${instance.tabId}"]`)).toBeVisible();
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const create = page.locator('[data-create-app="text-editor"]');
      const box = await create.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(32);
      expect(box.x).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThan(width);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${width}.png`) });
    }
    expect((await tabs()).filter((tab) => tab.kind === "application")).toHaveLength(1);
    await toggle.click();
    await expect(page.locator(`[data-open-instance="${instance.tabId}"]`)).toBeHidden();
    await toggle.click();
    await page.locator(`[data-open-instance="${instance.tabId}"]`).click();
    expect((await tabs()).filter((tab) => tab.kind === "application")).toHaveLength(1);
  } finally {
    await d.stop();
  }
});

test("an unlinked instance creates its own temporary conversation and returns to it later", async ({
  page
}) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    const post = async (path, data) => {
      const response = await page.request.post(`${d.base}${path}`, { data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const get = async (path) => await (await page.request.get(`${d.base}${path}`)).json();
    await post("/api/tasks", { taskId: "existing", goal: "已有临时会话" });
    await post("/api/workbench/tabs", { kind: "conversation", taskId: "existing" });
    await page.goto(d.base);
    await page.locator('#project-list [data-task="existing"]').click();
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    const instance = (await get("/api/workbench/tabs")).tabs.find((tab) => tab.kind === "application");
    await useApplicationInConversation(page);
    await expect.poll(async () => (await get("/api/tasks")).tasks.length).toBe(2);
    const created = (await get("/api/tasks")).tasks.find((task) => task.taskId !== "existing");
    await expect(page.locator(`#project-list [data-task="${created.taskId}"]`)).toHaveClass(/active/);
    expect((await get("/api/tasks/existing/app-instances")).loadedInstanceId).toBeUndefined();
    expect((await get(`/api/tasks/${created.taskId}/app-instances`)).loadedInstanceId).toBe(
      instance.appInstanceId
    );
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await page.locator('#project-list [data-task="existing"]').click();
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await page.locator(`[data-open-instance="${instance.tabId}"]`).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    await useApplicationInConversation(page);
    await expect(page.locator(`#project-list [data-task="${created.taskId}"]`)).toHaveClass(/active/);
    expect((await get("/api/tasks")).tasks).toHaveLength(2);
  } finally {
    await d.stop();
  }
});

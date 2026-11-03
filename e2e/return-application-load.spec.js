import { useApplicationInConversation } from "./workbench-menu-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

for (const empty of [false, true])
  test(`returning from an independent ${empty ? "empty instance" : "document"} loads it into the current conversation and still permits unloading`, async ({
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
      await post("/api/tasks", { taskId: "current", goal: "继续当前会话" });
      const { appInstance } = await post("/api/workbench/open-application", { appType: "text-editor" });
      let resource;
      if (!empty)
        ({ resource } = await post(`/api/workbench/instances/${appInstance.appInstanceId}/resources`, {
          kind: "text/plain",
          title: "自动加载.txt",
          initialContent: "Saved document"
        }));
      await post("/api/workbench/tabs", { kind: "conversation", taskId: "current" });
      await page.goto(dashboard.base);
      await page.locator('#project-list [data-task="current"]').click();
      await page.locator("#composer-input").fill("保留未发送的要求");
      await page.locator("#apps-nav").click();
      await page.locator('[data-toggle-instances="text-editor"]').click();
      await page.locator(`[data-open-instance="window:${appInstance.appInstanceId}"]`).click();
      await expect(page.locator("#conversation-pane")).toBeHidden();
      if (!empty) {
        await page.route("**/api/workbench/load-instance", (route) =>
          route.fulfill({ status: 503, json: { error: "Loading unavailable" } })
        );
        await useApplicationInConversation(page);
        await expect(page.locator("#toast")).toContainText("关联失败");
        await expect(page.locator("#conversation-pane")).toBeHidden();
        expect((await get("/api/tasks/current")).applications.loadedInstanceId).toBeUndefined();
        await page.unroute("**/api/workbench/load-instance");
      }
      await useApplicationInConversation(page);
      await expect(page.locator("#conversation-pane")).toBeVisible();
      await expect
        .poll(async () => (await get("/api/tasks/current")).applications.loadedInstanceId)
        .toBe(appInstance.appInstanceId);
      await expect(page.locator("#app-bind-select")).toContainText(empty ? "文本编辑器" : "自动加载.txt");
      await expect(page.locator("#composer-input")).toHaveValue("保留未发送的要求");
      expect((await get("/api/tasks")).tasks).toHaveLength(1);
      await page.locator("#app-bind-select").click();
      await page.locator('[data-bind-instance="__unbound__"]').click();
      await expect
        .poll(async () => (await get("/api/tasks/current")).applications.loadedInstanceId)
        .toBeUndefined();
      if (resource)
        expect((await get(`/api/tasks/current/resources/${resource.resourceId}`)).snapshot.content).toBe(
          "Saved document"
        );
    } finally {
      await dashboard.stop();
    }
  });

test("returning from a first standalone document creates one loaded conversation without asking for another project", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="text-editor"]').click();
    const { confirmApplicationWorkspace } = await import("./application-workspace-helper.js");
    await confirmApplicationWorkspace(page);
    await page.locator("[data-empty-new]:visible").click();
    await page.getByRole("textbox", { name: "文件名" }).fill("首次返回.md");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await useApplicationInConversation(page);
    await expect(page.getByRole("dialog", { name: "新建项目", exact: true })).toHaveCount(0);
    await expect(page.locator("#app-bind-select")).toContainText("首次返回.md");
    await expect
      .poll(async () => (await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks.length)
      .toBe(1);
    await page.reload();
    await expect(page.locator("#app-bind-select")).toContainText("首次返回.md");
  } finally {
    await dashboard.stop();
  }
});

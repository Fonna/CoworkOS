import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("restoring an instance fills the workspace and both instance lists support consecutive closes", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const taskId = "instance-navigation";
  const resources = [];
  const resourceIds = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    await post("/api/tasks", { taskId, goal: "实例切换测试" });
    await post("/api/workbench/tabs", { kind: "conversation", taskId });
    for (const title of ["甲.md", "乙.md", "丙.md"]) {
      const created = await post(`/api/tasks/${taskId}/resources`, {
        kind: "text/markdown",
        title,
        initialContent: title
      });
      resources.push(created.appInstance.appInstanceId);
      resourceIds.push(created.resource.resourceId);
      await post("/api/workbench/tabs", {
        kind: "application",
        resourceId: created.resource.resourceId,
        bindTo: taskId
      });
    }
    const cad = await post(`/api/tasks/${taskId}/app-instances/open`, { appType: "cad" });
    await post("/api/workbench/tabs", {
      kind: "application",
      taskId,
      appInstanceId: cad.appInstance.appInstanceId
    });
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await page.locator(`[data-open-instance="window:${resources[0]}"]`).click();
    await expect(page.locator("[data-editor-input]:visible")).toBeVisible();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await expect(page.locator(".chat-pane")).toHaveClass(/is-app-expanded/);
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await page.locator(`[data-open-instance="window:${resources[0]}"]`).click();
    await expect(page.locator("#conversation-pane")).toBeHidden();

    await page.route("**/operations", (route) =>
      route.fulfill({ status: 503, json: { error: "save unavailable" } })
    );
    await page.locator("[data-editor-input]:visible").fill("未保存的内容必须保留");

    const rail = page.locator("[data-tab-rail]");
    await expect(rail.locator("[data-close-tab]")).toHaveCount(3);
    // The rail exposes the related text documents; the independent CAD
    // view remains available in the application list.
    await rail.locator(".workbench-rail-entry.active [data-close-tab]").click();
    await expect(page.locator("[data-editor-status]:visible")).toHaveAttribute("data-state", "error");
    await expect(rail).toBeVisible();
    await expect(rail.locator("[data-close-tab]")).toHaveCount(3);
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("未保存的内容必须保留");
    await page.unroute("**/operations");
    for (const remaining of [2, 1]) {
      // Closing the active document keeps the next text document in front.
      await rail.locator(".workbench-rail-entry.active [data-close-tab]").click();
      await expect(rail).toBeVisible();
      await expect(rail.locator("[data-close-tab]")).toHaveCount(remaining);
      await expect(page.locator("[data-editor-input]:visible")).toBeVisible();
      await expect(page.locator("#conversation-pane")).toBeHidden();
    }
    await page.locator('[data-toggle-instances="cad"]').click();
    const textList = page.locator('[data-app-instances="text-editor"]');
    const cadList = page.locator('[data-app-instances="cad"]');
    await expect(textList.locator("[data-close-instance]")).toHaveCount(1);
    await expect(cadList.locator("[data-close-instance]")).toHaveCount(1);
    await page.screenshot({ path: ".tmp/app-instances-sidebar.png" });
    await textList.locator("[data-close-instance]").click();
    await expect(textList).toBeHidden();
    await expect(page.locator('[data-toggle-instances="text-editor"]')).toBeHidden();
    await expect(cadList).toBeVisible();
    await cadList.locator("[data-open-instance]").click();
    await expect(page.locator("[data-cad-new]")).toBeVisible();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await cadList.locator("[data-close-instance]").click();
    await expect(cadList).toBeHidden();
    await expect(page.locator('[data-toggle-instances="cad"]')).toBeHidden();
    for (const resourceId of resourceIds) {
      const response = await page.request.get(
        `${dashboard.base}/api/tasks/${taskId}/resources/${resourceId}`
      );
      expect(response.ok()).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

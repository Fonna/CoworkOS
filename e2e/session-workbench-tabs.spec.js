import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("session files stay above the right editor and disappear when its pane closes", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  const post = async (path, data) => {
    const response = await page.request.post(dashboard.base + path, { data });
    expect(response.ok(), path).toBeTruthy();
    return response.json();
  };
  try {
    const created = {};
    for (const taskId of ["session-a", "session-b"]) {
      await post("/api/tasks", { taskId, goal: taskId, projectId: dashboard.projectId });
      created[taskId] = [];
      for (const suffix of ["one", "two"]) {
        const document = await post(`/api/tasks/${taskId}/resources`, {
          kind: "text/plain",
          title: `${taskId}-${suffix}.txt`,
          initialContent: `${taskId}-${suffix}`
        });
        created[taskId].push(document);
        await post("/api/workbench/tabs", {
          kind: "application",
          appInstanceId: document.appInstance.appInstanceId,
          activate: false
        });
      }
      await post("/api/workbench/load-instance", {
        taskId,
        appInstanceId: created[taskId][0].appInstance.appInstanceId
      });
    }
    await page.goto(dashboard.base);
    const rail = page.locator("[data-tab-rail]");
    const editor = page.locator("[data-editor-input]:visible");
    for (const taskId of ["session-a", "session-b", "session-a"]) {
      await page.locator(`#project-list [data-task="${taskId}"]`).click();
      await page.locator("[data-composer-context]").click();
      await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
      await expect(rail).toBeVisible();
      await expect(rail.locator("[data-tab]")).toHaveCount(2);
      await expect(rail).toContainText(`${taskId}-one.txt`);
      await expect(rail).toContainText(`${taskId}-two.txt`);
      const other = taskId === "session-a" ? "session-b" : "session-a";
      await expect(rail).not.toContainText(other);
      const [chatBox, workbenchBox, railBox] = await Promise.all([
        page.locator("#conversation-pane").boundingBox(),
        page.locator("#workbench").boundingBox(),
        rail.boundingBox()
      ]);
      expect(railBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width);
      expect(railBox.x - workbenchBox.x).toBeLessThanOrEqual(12);
      expect(railBox.width).toBeLessThanOrEqual(workbenchBox.width);
      await expect(rail.locator("[data-close-tab]")).toHaveCount(2);
      await rail.getByRole("button", { name: `文件：${taskId}-two.txt`, exact: true }).click();
      await expect(editor).toHaveValue(`${taskId}-two`);
    }
    await page.screenshot({ path: info.outputPath("session-tabs-right-pane.png") });
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(rail).toBeHidden();
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.locator("#new-conversation").click();
    await expect(rail).toBeHidden();
    await expect(rail.locator("[data-tab]")).toHaveCount(0);
    for (const width of [760, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(rail).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  } finally {
    await dashboard.stop();
  }
});

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("the application picker uses document homes while Task data stays central", async ({ page }) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const api = async (path, body) => {
    const response = await fetch(`${dashboard.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  try {
    const projects = [];
    for (const name of ["项目甲", "项目乙", "空项目"]) {
      const projectDirectory = join(dashboard.root, name);
      await mkdir(projectDirectory);
      const { project } = await api("/api/projects", { projectName: name, projectDirectory });
      projects.push(project);
    }
    for (const [index, taskId] of ["first", "other"].entries())
      await api("/api/tasks", { taskId, goal: `会话${index}`, projectId: projects[index].projectId });
    // An older document in central storage remains usable alongside project documents.
    const legacyService = new ApplicationService(dashboard.workspaceRoot);
    const old = await legacyService.resources.createResource({
      appType: "text-editor",
      kind: "text/plain",
      title: "旧工作区.txt",
      initialContent: "旧版内容保留\n",
      actor: { type: "user", id: "fixture" }
    });
    await legacyService.referenceResource({
      taskId: "first",
      resourceId: old.resource.resourceId,
      appType: "text-editor"
    });
    const legacy = {
      resource: old.resource,
      appInstance: await legacyService.openResource({ taskId: "first", resourceId: old.resource.resourceId })
    };
    await api("/api/workbench/tabs", {
      kind: "application",
      appInstanceId: legacy.appInstance.appInstanceId,
      activate: false
    });
    const { applications } = await api("/api/applications");
    const open = async (appType, project, title) => {
      const { appInstance } = await api("/api/workbench/open-application", {
        appType,
        workspaceRoot: project.projectDirectory
      });
      const definition = applications.find((entry) => entry.appType === appType);
      const created = await api(`/api/workbench/instances/${appInstance.appInstanceId}/resources`, {
        kind: definition.resourceKinds[0],
        title
      });
      expect(created.resource.projectId).toBe(project.projectId);
      return { appInstanceId: appInstance.appInstanceId, resourceId: created.resource.resourceId };
    };
    const cad = await open("cad", projects[0], "项目 CAD");
    const text = await open("text-editor", projects[0], "同名方案.txt");
    const foreign = await open("text-editor", projects[1], "同名方案.txt");
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="first"]').click();
    await expect(page.locator('[data-tab="conversation:first"][aria-selected="true"]')).toHaveCount(1);
    await expect(page.locator("#app-bind-select")).toBeVisible();
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${cad.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${text.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${legacy.appInstance.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${foreign.appInstanceId}"]`)).toHaveCount(0);
    await page.locator(`[data-bind-instance="${cad.appInstanceId}"]`).click();
    await expect
      .poll(async () => (await api("/api/tasks/first/active-app-context")).context?.resource.resourceId)
      .toBe(cad.resourceId);
    const detail = await api("/api/tasks/first");
    expect(detail.storageRoot).toBe(dashboard.workspaceRoot);
    expect(detail.projectDirectory).toBe(projects[0].projectDirectory);
    expect(detail.applications.workspaceRoot).toBe(projects[0].projectDirectory);
    await page.locator("#app-bind-select").click();
    await page.locator(`[data-bind-instance="${legacy.appInstance.appInstanceId}"]`).click();
    await expect
      .poll(async () => (await api("/api/tasks/first/active-app-context")).context?.resource.resourceId)
      .toBe(legacy.resource.resourceId);
    const { tabs } = await api("/api/workbench/tabs");
    const legacyTab = tabs.find((tab) => tab.appInstanceId === legacy.appInstance.appInstanceId);
    expect(legacyTab.workspaceRoot).toBe(dashboard.workspaceRoot);
    expect(legacyTab.loadedConversations.map((entry) => entry.taskId)).toContain("first");
    await expect(page.locator("#app-bind-select .app-bind-name")).toContainText("旧工作区");
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("旧版内容保留\n");
    await page.locator("[data-app-expand]").click();
    await expect(page.locator("#conversation-pane")).toBeHidden();
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
    await expect(page.locator("#conversation-pane")).toBeVisible();
    await expect.poll(async () => (await api("/api/workbench/tabs")).activeTabId).toBe("conversation:first");
    expect(
      (await api("/api/tasks")).tasks
        .filter((entry) => entry.kind !== "workspace")
        .map((entry) => entry.taskId)
        .sort()
    ).toEqual(["first", "other"]);
    // A new draft has a selected project, but no Task storage identity yet.
    await page.locator("#new-conversation").click();
    await expect(page.locator("#project-list .conversation-item.active")).toHaveCount(0);
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#app-bind-select")).toBeVisible();
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${cad.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${text.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${legacy.appInstance.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${foreign.appInstanceId}"]`)).toHaveCount(0);
    await page.locator(`[data-bind-instance="${cad.appInstanceId}"]`).click();
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    const newTaskId = await page.locator("#project-list .conversation-item.active").getAttribute("data-task");
    expect(newTaskId).toBeTruthy();
    expect(newTaskId).not.toBe("first");
    const newDetail = await api(`/api/tasks/${newTaskId}`);
    expect(newDetail.storageRoot).toBe(dashboard.workspaceRoot);
    expect(newDetail.projectDirectory).toBe(projects[0].projectDirectory);
    expect(newDetail.applications.workspaceRoot).toBe(projects[0].projectDirectory);
    expect((await api(`/api/tasks/${newTaskId}/active-app-context`)).context.resource.resourceId).toBe(
      cad.resourceId
    );
    expect((await api("/api/tasks")).tasks.filter((entry) => entry.kind !== "workspace")).toHaveLength(3);
    // Loading an old central document must not move a draft to that document's project.
    await page.locator(`[data-project="${projects[2].projectId}"] .project-heading`).hover();
    await page.locator(`[data-project-create="${projects[2].projectId}"]`).click();
    await expect(page.locator("#project-context")).toHaveText("空项目");
    await expect(page.locator("#project-list .conversation-item.active")).toHaveCount(0);
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${cad.appInstanceId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-bind-instance="${foreign.appInstanceId}"]`)).toHaveCount(0);
    await page.locator(`[data-bind-instance="${legacy.appInstance.appInstanceId}"]`).click();
    await expect(page.locator("#app-bind-select")).toHaveClass(/is-bound/);
    await expect(page.locator("#app-bind-select")).toBeEnabled();
    const legacyTaskId = await page
      .locator("#project-list .conversation-item.active")
      .getAttribute("data-task");
    expect(legacyTaskId).toBeTruthy();
    const legacyDetail = await api(`/api/tasks/${legacyTaskId}`);
    expect(legacyDetail.task.projectId).toBe(projects[2].projectId);
    expect(legacyDetail.projectDirectory).toBe(projects[2].projectDirectory);
    expect(legacyDetail.storageRoot).toBe(dashboard.workspaceRoot);
    expect((await api(`/api/tasks/${legacyTaskId}/active-app-context`)).context.resource.resourceId).toBe(
      legacy.resource.resourceId
    );
    expect((await api("/api/tasks")).tasks.filter((entry) => entry.kind !== "workspace")).toHaveLength(4);
    await page.locator('#project-list [data-task="other"]').click();
    await expect.poll(async () => (await api("/api/workbench/tabs")).activeTabId).toBe("conversation:other");
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${foreign.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${cad.appInstanceId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-bind-instance="${text.appInstanceId}"]`)).toHaveCount(0);
    await dashboard.restart({ newPort: true });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="first"]').click();
    await expect(page.locator("#app-bind-select")).toBeVisible();
    await page.locator("#app-bind-select").click();
    await expect(page.locator(`[data-bind-instance="${cad.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${legacy.appInstance.appInstanceId}"]`)).toBeVisible();
    await expect(page.locator(`[data-bind-instance="${foreign.appInstanceId}"]`)).toHaveCount(0);
  } finally {
    await dashboard.stop();
  }
});

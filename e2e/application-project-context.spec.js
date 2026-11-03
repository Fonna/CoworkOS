import { test, expect } from "@playwright/test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { ResourceFiles } from "../dist/src/applications/resource-files.js";

test("editor collaboration and application rows show the persisted project while stale empty legacy groups stay hidden", async ({
  page
}) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    const api = async (path, body) => {
      const response = await page.request[body === undefined ? "get" : "post"](
        d.base + path,
        body === undefined ? {} : { data: body }
      );
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const directory = join(d.root, "different-storage-name");
    const empty = join(d.root, "empty-project");
    await Promise.all([mkdir(directory), mkdir(empty)]);
    const { project } = await api("/api/projects", {
      projectName: "用户选择的项目名称",
      projectDirectory: directory
    });
    const { project: emptyProject } = await api("/api/projects", {
      projectName: "合法空项目",
      projectDirectory: empty
    });
    await api("/api/tasks", { taskId: "chat", projectId: project.projectId, goal: "项目中的会话" });
    const created = await api("/api/tasks/chat/resources", {
      kind: "text/plain",
      title: "项目文档.txt",
      initialContent: "持久内容\n"
    });
    await api("/api/workbench/load-instance", {
      taskId: "chat",
      appInstanceId: created.appInstance.appInstanceId
    });
    const catalogPath = join(d.root, "projects.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    const staleDirectory = join(d.root, "atria-reasoning-launcher-old");
    catalog.projects.push({
      projectId: staleDirectory,
      projectDirectory: staleDirectory,
      projectName: "atria-reasoning-launcher-old",
      legacy: true,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z"
    });
    await writeFile(catalogPath, JSON.stringify(catalog));
    await page.goto(d.base);
    await page.locator('#project-list [data-task="chat"]').click();
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("持久内容\n");
    await expect(page.locator("[data-app-task-status]")).toContainText("项目：用户选择的项目名称");
    await expect(page.locator("[data-app-task-status]")).not.toContainText("different-storage-name");
    await expect(page.locator(`[data-project="${emptyProject.projectId}"]`)).toContainText("还没有对话");
    await expect(page.locator(`[data-project="${staleDirectory}"]`)).toHaveCount(0);
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await expect(page.locator(".app-instance-workspace")).toHaveText("项目：用户选择的项目名称");
    const metadataPath = join(
      directory,
      "applications",
      "text-editor",
      "resources",
      created.resource.resourceId,
      "metadata.json"
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata.project.projectId).toBe(project.projectId);
    expect(
      await readFile(join(directory, "applications", "text-editor", "files", metadata.path), "utf8")
    ).toBe("持久内容\n");
    await d.restart();
    await page.reload();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("持久内容\n");
    await expect(page.locator("[data-app-task-status]")).toContainText("项目：用户选择的项目名称");
    expect(JSON.parse(await readFile(metadataPath, "utf8")).project).toEqual(metadata.project);
  } finally {
    await d.stop();
  }
});

test("loading an unassigned independent editor into a project chat retains its explicit unassigned status", async ({
  page
}) => {
  const d = await startDashboard();
  try {
    const post = async (path, data) => {
      const response = await page.request.post(d.base + path, { data });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    await post("/api/tasks", { taskId: "chat", projectId: d.projectId, goal: "项目会话" });
    // Default root is itself an explicitly created project in this fixture, so
    // choose a directory with no project record to exercise unassigned creation.
    const root = join(d.root, "independent-editor");
    await mkdir(root);
    const opened = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: root
    });
    const created = await post(`/api/workbench/instances/${opened.appInstance.appInstanceId}/resources`, {
      kind: "text/plain",
      title: "独立文档.txt",
      initialContent: "独立\n"
    });
    // A persisted explicit reference allows sharing across roots without reassigning.
    const { ApplicationService } = await import("../dist/src/applications/application-service.js");
    await new ApplicationService(root, undefined, d.workspaceRoot).referenceResource({
      taskId: "chat",
      resourceId: created.resource.resourceId,
      appType: "text-editor"
    });
    await post("/api/workbench/load-instance", {
      taskId: "chat",
      appInstanceId: opened.appInstance.appInstanceId
    });
    await page.goto(d.base);
    await page.locator('#project-list [data-task="chat"]').click();
    await page.locator("[data-composer-context]").click();
    await expect(page.locator("[data-app-task-status]")).toContainText("无项目归属");
    await page.locator("#apps-nav").click();
    await page.locator('[data-toggle-instances="text-editor"]').click();
    await expect(page.locator(".app-instance-workspace")).toHaveText("无项目归属");
    expect(created.resource.project).toBeNull();
  } finally {
    await d.stop();
  }
});

test("new and legacy empty editors create real files with their project roots and keep project labels after restart", async ({
  page
}) => {
  const d = await startDashboard({ defaultProject: false });
  try {
    const post = async (path, data) => {
      const response = await page.request.post(d.base + path, { data });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const get = async (path) => {
      const response = await page.request.get(d.base + path);
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const directory = join(d.root, "project-home");
    await mkdir(directory);
    const { project } = await post("/api/projects", {
      projectName: "空窗口项目",
      projectDirectory: directory
    });
    await post("/api/tasks", { taskId: "chat", projectId: project.projectId, goal: "保留旧文件的会话" });
    const original = new ApplicationService(d.workspaceRoot);
    const old = (
      await original.resources.createResource({
        appType: "text-editor",
        kind: "text/plain",
        title: "old.txt",
        initialContent: "old\n",
        actor: { type: "user", id: "fixture" }
      })
    ).resource;
    await original.referenceResource({ taskId: "chat", resourceId: old.resourceId, appType: old.appType });
    const oldWindow = await original.openResource({ taskId: "chat", resourceId: old.resourceId });
    await post("/api/workbench/load-instance", { taskId: "chat", appInstanceId: oldWindow.appInstanceId });
    const { appInstance: fresh } = await post("/api/tasks/chat/app-instances/open", {
      appType: "text-editor"
    });
    await post("/api/workbench/tabs", { kind: "application", appInstanceId: fresh.appInstanceId });
    const createVisible = async (instance, title) => {
      await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
      await page.locator("[data-empty-new]:visible").click();
      await page.getByRole("textbox", { name: "文件名" }).fill(title);
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.locator("[data-editor-input]:visible")).toBeEnabled();
      await expect(page.locator("[data-app-task-status]")).toContainText("项目：空窗口项目");
      const tab = (await get("/api/workbench/tabs")).tabs.find(
        (entry) => entry.appInstanceId === instance.appInstanceId
      );
      expect(tab.project.projectId).toBe(project.projectId);
      expect(tab.workspaceRoot).toBe(directory);
      const resource = (await get(`/api/workbench/instances/${instance.appInstanceId}`)).appInstance
        .resourceIds[0];
      const metadata = JSON.parse(
        await readFile(
          join(directory, "applications", "text-editor", "resources", resource, "metadata.json"),
          "utf8"
        )
      );
      expect(metadata.project.projectId).toBe(project.projectId);
      await access(new ResourceFiles(directory).absolutePath(metadata));
      await expect(access(new ResourceFiles(d.workspaceRoot).absolutePath(metadata))).rejects.toMatchObject({
        code: "ENOENT"
      });
    };
    await page.goto(d.base);
    await createVisible(fresh, "new.txt");
    const { appInstance: legacy } = await post("/api/workbench/open-application", {
      appType: "text-editor",
      workspaceRoot: directory
    });
    const indexPath = join(directory, "applications", "instances", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    delete index.instances.find((entry) => entry.appInstanceId === legacy.appInstanceId).project;
    await writeFile(indexPath, JSON.stringify(index));
    await page.reload();
    await createVisible(legacy, "legacy.txt");
    await d.restart();
    await page.reload();
    await expect(page.locator("[data-app-task-status]")).toContainText("项目：空窗口项目");
    expect(await readFile(new ResourceFiles(d.workspaceRoot).absolutePath(old), "utf8")).toBe("old\n");
  } finally {
    await d.stop();
  }
});

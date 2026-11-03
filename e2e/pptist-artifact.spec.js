import { presentationSave } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import PptxGenJS from "pptxgenjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { ApplicationService } from "../dist/src/applications/application-service.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function selectSlide(frame, index) {
  const toggle = frame.getByRole("button", { name: "幻灯片列表", exact: true });
  if ((await toggle.getAttribute("aria-pressed")) === "false") await toggle.click();
  await frame.locator(".thumbnail-item").nth(index).click();
}

async function collapseWorkbench(page) {
  if (await page.locator("#workbench").isVisible())
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await expect(page.locator("#workbench")).toBeHidden();
}

async function openTaskPanel(page) {
  const panel = page.locator("#agent-pane");
  if (await panel.isVisible()) return;
  const toggle = page.locator("#output-pane-toggle");
  await expect(toggle).toBeVisible();
  if (!(await page.locator("[data-app-collaborate]").isVisible())) {
    await toggle.click();
    await expect
      .poll(
        async () => (await panel.isVisible()) || (await page.locator("[data-app-collaborate]").isVisible())
      )
      .toBe(true);
  }
  if (await page.locator("[data-app-collaborate]").isVisible()) {
    await page.getByRole("button", { name: "工作区菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "任务面板", exact: true }).click();
  }
  await expect(panel).toBeVisible();
}

test("PPTX artifact opens directly, reuses its editable document and leaves the export untouched", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const taskId = "pptx_artifact_task";
  const name = "已有演示 空格 & #.pptx";
  const errors = [];
  const artifactReads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === `/api/tasks/${taskId}/artifact` &&
      url.searchParams.get("path") === name &&
      url.searchParams.get("download") !== "1"
    )
      artifactReads.push(request.url());
  });
  try {
    const projectDirectory = join(dashboard.root, "separate-project");
    await mkdir(projectDirectory);
    const { project } = await (
      await page.request.post(`${dashboard.base}/api/projects`, {
        data: { projectName: "演示文稿项目", projectDirectory }
      })
    ).json();
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "打开已有 PPTX", projectId: project.projectId }
    });
    const root = join(dashboard.workspaceRoot, taskId, "artifacts");
    await mkdir(root, { recursive: true });
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    const first = pptx.addSlide();
    first.addText("原有 PPTX 标题", { x: 1, y: 1, w: 6, h: 1 });
    first.addImage({
      x: 8,
      y: 1,
      w: 1,
      h: 1,
      data:
        "data:image/svg+xml;base64," +
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ba2345"/></svg>'
        ).toString("base64")
    });
    const second = pptx.addSlide();
    second.addTable(
      [
        ["项目", "数量"],
        ["页面", "2"]
      ],
      { x: 1, y: 1, w: 6, h: 2 }
    );
    second.addNotes("原文件演讲备注");
    const bytes = await pptx.write({ outputType: "nodebuffer" });
    await writeFile(join(root, name), bytes);
    await writeFile(join(root, "损坏文件.pptx"), "this is not a zip");
    await page.route(`**/api/tasks/${taskId}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        response,
        json: {
          ...detail,
          task: {
            ...detail.task,
            status: "completed",
            completion: { policy: "natural", signal: "natural_stop" }
          },
          runtime: { active: false },
          messages: [
            {
              role: "assistant",
              content: `[打开演示文稿]( <${join(root, name)}> )`,
              timestamp: 1,
              stopReason: "stop"
            }
          ]
        }
      });
    });
    await page.goto(dashboard.base);
    await openTaskPanel(page);
    const row = page.locator("[data-artifact]").filter({ hasText: name });
    await expect(row.locator("[data-edit-artifact]")).toBeVisible();
    await row.click();
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".thumbnail-item")).toHaveCount(2, { timeout: 30000 });
    expect(artifactReads).toHaveLength(1);
    await expect(page.locator("#artifact-drawer")).toBeHidden();
    await expect(frame.locator(".canvas")).toContainText("原有 PPTX 标题");
    await selectSlide(frame, 1);
    await expect(frame.locator(".canvas table")).toContainText("数量");
    await expect(frame.locator(".remark .ProseMirror")).toContainText("原文件演讲备注");
    await frame.locator(".remark .ProseMirror").fill("从产出物打开后继续修改");
    const save = presentationSave(page);
    await save.click();
    await expect(save).toHaveText("已保存");
    const resources = await (
      await page.request.get(`${dashboard.base}/api/tasks/${taskId}/resources`)
    ).json();
    expect(resources.resources).toHaveLength(1);
    const imported = await (
      await page.request.get(
        `${dashboard.base}/api/tasks/${taskId}/resources/${resources.resources[0].resourceId}`
      )
    ).json();
    const svg = imported.snapshot.content.slides[0].elements.find((element) => element.type === "image");
    expect(svg.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(svg.src.split(",")[1], "base64").toString()).toContain("#ba2345");
    const summary = await (
      await page.request.get(`${dashboard.base}/api/tasks/${taskId}/app-instances`)
    ).json();
    expect(summary.boundResourceId).toBeUndefined();
    expect(summary.resources.map((resource) => resource.resourceId)).toContain(
      resources.resources[0].resourceId
    );
    await openTaskPanel(page);
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(1);
    await expect(page.locator("#output-list .output-row")).toHaveCount(2);
    await expect(page.locator("#workspace-artifact-count")).toHaveText("2");
    // The same final-answer link must return to the edited resource after
    // polling and reload, even though its original file row is now merged.
    for (const reload of [false, true]) {
      if (reload) {
        await dashboard.restart();
        await page.reload();
      }
      await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      await page.getByRole("link", { name: "打开演示文稿", exact: true }).click();
      await expect(page.locator("#artifact-drawer")).toBeHidden();
      await selectSlide(frame, 1);
      await expect(frame.locator(".remark .ProseMirror")).toContainText("从产出物打开后继续修改");
      const reopened = await (
        await page.request.get(`${dashboard.base}/api/tasks/${taskId}/resources`)
      ).json();
      expect(reopened.resources.map((resource) => resource.resourceId)).toEqual([
        resources.resources[0].resourceId
      ]);
      const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      expect(tabs.tabs.filter((tab) => tab.kind === "application")).toHaveLength(1);
      expect(artifactReads).toHaveLength(1);
    }
    expect(await readFile(join(root, name))).toEqual(bytes);
    await openTaskPanel(page);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: `下载 ${name}`, exact: true }).click();
    expect(await readFile(await (await download).path())).toEqual(bytes);
    await expect(page.locator("body")).not.toHaveClass(/app-fullbleed/);
    // The merged resource row is also a direct, repeatable editor entry.
    for (let click = 0; click < 2; click++) {
      await openTaskPanel(page);
      await page.locator("#output-list [data-resource-row]").click();
      await expect(frame.locator(".remark .ProseMirror")).toContainText("从产出物打开后继续修改");
      await openTaskPanel(page);
      await expect(page.locator("#output-list .output-row")).toHaveCount(2);
      expect(artifactReads).toHaveLength(1);
      await collapseWorkbench(page);
    }
    // A failed conversion must not create a blank resource or change the active document.
    await openTaskPanel(page);
    await page.locator('[data-artifact="损坏文件.pptx"]').click();
    await expect(page.locator("#toast")).toContainText("无法解析 PPTX", { timeout: 15000 });
    const after = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}/resources`)).json();
    expect(after.resources).toHaveLength(1);
    await expect(page.locator('iframe[title="演示文稿导入器"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("opening a presentation's own exports repeatedly keeps one document, editor and loading option", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const taskId = "pptist_export_identity";
  try {
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "验证导出物回到原文档" }
    });
    const response = await page.request.post(`${dashboard.base}/api/tasks/${taskId}/resources`, {
      data: {
        appType: "pptist",
        kind: "presentation/pptist+json",
        title: "CoworkOS Harness 介绍",
        initialContent: { slides: [{ id: "original", elements: [], remark: "原始文档，包含原生备注" }] }
      }
    });
    expect(response.ok()).toBeTruthy();
    const created = await response.json();
    const resourceId = created.resource.resourceId;
    const instanceId = created.appInstance.appInstanceId;
    const service = new ApplicationService(dashboard.workspaceRoot);
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    const exports = [];
    for (const format of ["pptx", "json", "pptist"]) {
      const file = await service.renderForDownload({ taskId, resourceId, format });
      const relativePath = `exports/${resourceId}/abcd1234-${file.fileName}`;
      await store.publishArtifact({
        taskId,
        runId: "run",
        producerAgentId: "main",
        relativePath,
        displayName: file.fileName,
        mimeType: file.mimeType,
        content: file.body,
        // Cover both the old generated path and new explicit export provenance.
        ...(format === "pptx" ? {} : { sourceResourceId: resourceId })
      });
      exports.push(relativePath);
    }
    const artifactsRoot = join(dashboard.workspaceRoot, taskId, "artifacts");
    await page.route(`**/api/tasks/${taskId}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        response,
        json: {
          ...detail,
          messages: [
            {
              role: "assistant",
              content: exports
                .map((path, index) => `[打开导出 ${index}](<${join(artifactsRoot, path)}>)`)
                .join("\n\n"),
              timestamp: 1,
              stopReason: "stop"
            }
          ]
        }
      });
    });
    await page.goto(dashboard.base);
    await openTaskPanel(page);
    await expect(page.locator("#output-list .output-row")).toHaveCount(1);
    await expect(page.locator("#workspace-artifact-count")).toHaveText("1");
    await expect(page.locator("#output-list [data-resource-row]")).toHaveCount(1);
    await openTaskPanel(page);
    await page.locator("[data-output-download-menu]").click();
    const menu = page.locator('.output-download-menu[role="menu"]');
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    const downloadPath = await menu.getByRole("menuitem").first().getAttribute("data-download-artifact");
    expect(exports).toContain(downloadPath);
    const exportDownload = page.waitForEvent("download");
    await menu.getByRole("menuitem").first().click();
    expect(await readFile(await (await exportDownload).path())).toEqual(
      await readFile(join(artifactsRoot, downloadPath))
    );
    await expect(page.locator("body")).not.toHaveClass(/app-fullbleed/);
    await page.keyboard.press("Escape");
    for (const relativePath of [...exports, exports[0]]) {
      await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
      await page
        .getByRole("link", { name: `打开导出 ${exports.indexOf(relativePath)}`, exact: true })
        .click();
      const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
      await expect(frame.locator(".remark .ProseMirror")).toContainText("原始文档，包含原生备注");
      const summary = await (
        await page.request.get(`${dashboard.base}/api/tasks/${taskId}/app-instances`)
      ).json();
      expect(summary.resources.map((resource) => resource.resourceId)).toEqual([resourceId]);
      expect(summary.instances.map((instance) => instance.appInstanceId)).toEqual([instanceId]);
      await expect(page.locator("#output-list .output-row")).toHaveCount(1);
      const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
      expect(tabs.tabs.filter((tab) => tab.kind === "application").map((tab) => tab.appInstanceId)).toEqual([
        instanceId
      ]);
      await collapseWorkbench(page);
    }
    await page.reload();
    await page.locator("#app-bind-select").click();
    await expect(
      page.locator("#app-bind-menu [data-bind-instance]").filter({ hasText: "CoworkOS Harness 介绍" })
    ).toHaveCount(1);
  } finally {
    await dashboard.stop();
  }
});

test("reopening an ordinary PPTX artifact keeps its edited copy and project after restart", async ({
  page
}) => {
  const dashboard = await startDashboard({ defaultProject: false });
  const taskId = "ordinary_pptx_reopen";
  try {
    const directory = join(dashboard.root, "project-files");
    await mkdir(directory);
    const projectResponse = await page.request.post(`${dashboard.base}/api/projects`, {
      data: { projectName: "测试", projectDirectory: directory }
    });
    const { project } = await projectResponse.json();
    await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, projectId: project.projectId, goal: "创建一个 PPT，一页空白" }
    });
    const artifacts = join(dashboard.workspaceRoot, taskId, "artifacts");
    await mkdir(artifacts, { recursive: true });
    const pptx = new PptxGenJS();
    pptx.addSlide();
    const bytes = await pptx.write({ outputType: "nodebuffer" });
    await writeFile(join(artifacts, "blank.pptx"), bytes);
    await page.goto(dashboard.base);
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    const open = async () => {
      await openTaskPanel(page);
      await page.locator('[data-artifact="blank.pptx"], #output-list [data-resource-row]').first().click();
      await expect(frame.locator(".thumbnail-item")).toHaveCount(1, { timeout: 30000 });
      const detail = await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}`)).json();
      expect(detail.applications.deliverables).toHaveLength(1);
    };
    const resources = async () =>
      (await (await page.request.get(`${dashboard.base}/api/tasks/${taskId}/resources`)).json()).resources;
    await open();
    const [copy] = await resources();
    expect(copy.project.projectId).toBe(project.projectId);
    await frame.locator(".remark .ProseMirror").fill("保存的编辑应在再次点击产出物后保留");
    const save = presentationSave(page);
    await save.click();
    await expect(save).toHaveText("已保存");
    for (let attempt = 0; attempt < 3; attempt++) {
      await collapseWorkbench(page);
      await open();
      expect((await resources()).map((resource) => resource.resourceId)).toEqual([copy.resourceId]);
      await expect(frame.locator(".remark .ProseMirror")).toContainText("保存的编辑应在再次点击产出物后保留");
    }
    const close = page.locator("[data-tab-rail] [data-close-tab]");
    await expect(close).toHaveCount(1);
    await close.click();
    await expect(page.locator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]')).toHaveCount(0);
    await open();
    expect((await resources()).map((resource) => resource.resourceId)).toEqual([copy.resourceId]);
    await expect(frame.locator(".remark .ProseMirror")).toContainText("保存的编辑应在再次点击产出物后保留");
    await dashboard.restart({ newPort: true });
    await page.goto(dashboard.base);
    await collapseWorkbench(page);
    await open();
    expect((await resources()).map((resource) => resource.resourceId)).toEqual([copy.resourceId]);
    await expect(frame.locator(".remark .ProseMirror")).toContainText("保存的编辑应在再次点击产出物后保留");
    await expect(page.locator("[data-app-task-status]")).toContainText("项目：测试");
    expect(await readFile(join(artifacts, "blank.pptx"))).toEqual(bytes);
  } finally {
    await dashboard.stop();
  }
});

test("updated PPTX artifacts fold older editable copies into a usable version menu", async ({
  page
}, info) => {
  test.setTimeout(120000);
  const dashboard = await startDashboard({ defaultProject: false });
  const taskId = "pptx_artifact_versions";
  const relativePath = "发布稿 空格 & #.pptx";
  const pdfPath = "发布稿.pdf";
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const task = await page.request.post(`${dashboard.base}/api/tasks`, {
      data: { taskId, goal: "在最新演示文稿中保留历史编辑" }
    });
    expect(task.ok()).toBe(true);
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    const bytesFor = async (title, remark) => {
      const deck = new PptxGenJS();
      deck.layout = "LAYOUT_WIDE";
      const slide = deck.addSlide();
      slide.addText(title, { x: 1, y: 1, w: 8, h: 1 });
      slide.addNotes(remark);
      return deck.write({ outputType: "nodebuffer" });
    };
    const publish = (content, path = relativePath) =>
      store.publishArtifact({
        taskId,
        runId: "version-run",
        producerAgentId: "main",
        relativePath: path,
        displayName: path,
        content
      });
    const resources = async () => {
      const response = await page.request.get(`${dashboard.base}/api/tasks/${taskId}/resources`);
      expect(response.ok()).toBe(true);
      return (await response.json()).resources;
    };
    const readResource = async (resourceId) => {
      const response = await page.request.get(
        `${dashboard.base}/api/tasks/${taskId}/resources/${resourceId}`
      );
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const deliverables = async () => {
      const response = await page.request.get(`${dashboard.base}/api/tasks/${taskId}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).applications.deliverables;
    };
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    const remark = frame.locator(".remark .ProseMirror");
    const saveRemark = async (content) => {
      await remark.fill(content);
      await presentationSave(page).click();
      await expect(presentationSave(page)).toHaveText("已保存");
    };
    const outputRows = page.locator("#output-list .output-row");
    const oldBytes = await bytesFor("第一版源文件", "第一版源备注");
    const oldArtifact = await publish(oldBytes);
    await publish(Buffer.from("%PDF-1.7\nindependent pdf output\n"), pdfPath);
    await page.goto(dashboard.base);
    await openTaskPanel(page);
    await page.locator(`[data-artifact="${relativePath}"]`).click();
    await expect(frame.locator(".canvas")).toContainText("第一版源文件");
    await saveRemark("第一版中已保存的人工编辑");
    const [older] = await resources();
    expect(older.importedArtifact.sha256).toBe(oldArtifact.sha256);

    const currentBytes = await bytesFor("第二版源文件", "第二版源备注");
    const currentArtifact = await publish(currentBytes);
    expect(currentArtifact.sha256).not.toBe(oldArtifact.sha256);
    await page.reload();
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await openTaskPanel(page);
    await page.locator(`[data-artifact="${relativePath}"]`).click();
    await expect(frame.locator(".canvas")).toContainText("第二版源文件");
    await expect(remark).toContainText("第二版源备注");
    const copies = await resources();
    expect(copies).toHaveLength(2);
    const current = copies.find((resource) => resource.resourceId !== older.resourceId);
    expect(current.importedArtifact).toEqual({
      ...older.importedArtifact,
      sha256: currentArtifact.sha256
    });
    await expect
      .poll(async () => (await deliverables()).map((row) => row.kind))
      .toEqual(["resource", "file"]);
    const [main] = await deliverables();
    expect(main.resourceId).toBe(current.resourceId);
    expect(main.files.map((file) => file.relativePath)).toEqual([relativePath]);
    expect(main.previousVersions.map((version) => version.resourceId)).toEqual([older.resourceId]);
    await openTaskPanel(page);
    await expect(outputRows).toHaveCount(2);
    await expect(page.locator("#workspace-artifact-count")).toHaveText("2");
    await expect(page.locator(`#output-list [data-resource-row="${older.resourceId}"]`)).toHaveCount(0);
    await expect(page.locator(`#output-list [data-artifact="${pdfPath}"]`)).toBeVisible();
    const currentRow = page.locator(`#output-list [data-resource-row="${current.resourceId}"]`);
    const historyTrigger = currentRow.locator("[data-output-version-menu]");
    const historyMenu = page.getByRole("menu", { name: "较早版本", exact: true });
    const previous = historyMenu.locator(`[data-output-version="${older.resourceId}"]`);
    await historyTrigger.focus();
    await historyTrigger.press("ArrowDown");
    await expect(previous).toBeFocused();
    const olderRevision = (await readResource(older.resourceId)).snapshot.revision;
    expect(main.previousVersions[0].revision).toBe(olderRevision);
    await expect(previous).toHaveAttribute("title", `${older.title} · r${olderRevision}`);
    await page.screenshot({ path: info.outputPath("pptx-output-version-menu.png"), animations: "disabled" });
    const refresh = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/tasks/${taskId}` && response.ok()
    );
    await refresh;
    await expect(previous).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(historyMenu).toHaveCount(0);
    await expect(historyTrigger).toBeFocused();
    await historyTrigger.press("ArrowUp");
    await expect(previous).toBeFocused();
    await previous.press("Enter");
    await expect(historyMenu).toHaveCount(0);
    await expect(frame.locator(".canvas")).toContainText("第一版源文件");
    await expect(remark).toContainText("第一版中已保存的人工编辑");
    await saveRemark("较早版本从历史中继续保存的修改");
    expect((await readResource(older.resourceId)).snapshot.content.slides[0].remark).toContain(
      "较早版本从历史中继续保存的修改"
    );
    expect((await readResource(current.resourceId)).snapshot.content.slides[0].remark).toContain(
      "第二版源备注"
    );
    await openTaskPanel(page);
    await currentRow.click();
    await expect(frame.locator(".canvas")).toContainText("第二版源文件");
    await expect(remark).toContainText("第二版源备注");
    await openTaskPanel(page);
    const download = page.waitForEvent("download");
    await currentRow.getByRole("link", { name: `下载 ${relativePath}`, exact: true }).click();
    expect(await readFile(await (await download).path())).toEqual(currentBytes);
    expect(await readFile(join(dashboard.workspaceRoot, taskId, "artifacts", relativePath))).toEqual(
      currentBytes
    );

    const independentResponse = await page.request.post(`${dashboard.base}/api/tasks/${taskId}/resources`, {
      data: {
        appType: "pptist",
        kind: "presentation/pptist+json",
        title: current.title,
        initialContent: { slides: [{ id: "independent", elements: [], remark: "同名独立文档" }] }
      }
    });
    expect(independentResponse.ok()).toBe(true);
    const independent = (await independentResponse.json()).resource;
    await dashboard.restart({ newPort: true });
    await page.goto(dashboard.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await openTaskPanel(page);
    await expect(outputRows).toHaveCount(3);
    await expect(page.locator("#workspace-artifact-count")).toHaveText("3");
    await expect(page.locator(`#output-list [data-resource-row="${independent.resourceId}"]`)).toBeVisible();
    await expect(page.locator("#output-list [data-output-version-menu]")).toHaveCount(1);
    await historyTrigger.click();
    await expect(previous).toHaveCount(1);
    await previous.click();
    await expect(remark).toContainText("较早版本从历史中继续保存的修改");
    await openTaskPanel(page);
    await expect(outputRows).toHaveCount(3);
    expect(await resources()).toHaveLength(3);
    const refreshed = await deliverables();
    expect(
      refreshed
        .filter((row) => row.kind === "resource")
        .map((row) => row.resourceId)
        .sort()
    ).toEqual([current.resourceId, independent.resourceId].sort());
    expect(
      refreshed.find((row) => row.resourceId === current.resourceId).previousVersions[0].resourceId
    ).toBe(older.resourceId);
    await page.screenshot({
      path: info.outputPath("pptx-versioned-output-list.png"),
      animations: "disabled"
    });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

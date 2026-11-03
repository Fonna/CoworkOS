import { test, expect } from "@playwright/test";
import { applicationServiceForTask } from "../dist/src/applications/task-service.js";
import { blenderStatus } from "../dist/src/software/blender/engine.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const actor = { type: "agent", id: "live-fixture" };

async function standalone(page, dashboard, appType) {
  const response = await page.request.post(`${dashboard.base}/api/workbench/open-application`, {
    data: { appType }
  });
  expect(response.ok()).toBe(true);
  const opened = await response.json();
  await page.goto(dashboard.base);
  await expect(page.locator("#conversation-pane")).toBeHidden();
  return { service: await applicationServiceForTask(dashboard.workspaceRoot, opened.taskId), ...opened };
}

test("a standalone TXT app shows each committed stage and keeps an unsaved human draft", async ({ page }) => {
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { service, appInstance, taskId } = await standalone(page, dashboard, "text-editor");
    await expect(page.locator("[data-empty-new]:visible")).toBeVisible();
    const { resource } = await service.createInApplication({
      taskId,
      appInstanceId: appInstance.appInstanceId,
      kind: "text/plain",
      title: "实时阶段.txt",
      actor
    });
    const input = page.locator("[data-editor-input]:visible");
    await expect(input).toBeEnabled();
    const commit = async (revision, text) =>
      service.applyOperation({
        taskId,
        appInstanceId: appInstance.appInstanceId,
        resourceId: resource.resourceId,
        appType: "text-editor",
        operationId: `stage-${revision}`,
        operationType: "text.insert",
        baseRevision: revision,
        payload: { at: 0, text },
        actor
      });
    // No running conversation/SSE exists; these operations use a separate service.
    await commit(0, "第一阶段\n");
    await expect(input).toHaveValue("第一阶段\n", { timeout: 1800 });
    let failedRead = false;
    await page.route(`**/resources/${resource.resourceId}`, (route) => {
      if (!failedRead && route.request().method() === "GET") {
        failedRead = true;
        return route.fulfill({ status: 503, json: { error: "temporarily offline" } });
      }
      return route.continue();
    });
    await commit(1, "第二阶段\n");
    await expect(input).toHaveValue("第二阶段\n第一阶段\n", { timeout: 1800 });
    expect(failedRead).toBe(true);
    await page.route("**/operations", (route) => route.fulfill({ status: 503, json: { error: "offline" } }));
    await input.fill("人工未保存草稿");
    await commit(2, "第三阶段\n");
    await expect(page.locator("[data-editor-conflict]:visible")).toContainText("内容有冲突");
    await expect(input).toHaveValue("人工未保存草稿");
    await page.locator("[data-editor-info] summary").click();
    await expect(page.locator("[data-editor-revision]:visible")).toHaveText("r3");
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

for (const sourceMode of [false, true])
  test(`standalone CAD ${sourceMode ? "source" : "feature"} operations refresh the preview during successive commits`, async ({
    page
  }) => {
    test.setTimeout(60000);
    const dashboard = await startDashboard();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const { service, appInstance, taskId } = await standalone(page, dashboard, "cad");
      const { resource } = await service.createInApplication({
        taskId,
        appInstanceId: appInstance.appInstanceId,
        kind: sourceMode ? "model/atria-jscad+json" : "model/atria-cad+json",
        title: "逐步建模",
        actor
      });
      const count = page.locator(sourceMode ? "[data-program-count]" : "[data-cad-count]:visible");
      if (sourceMode) await expect(page.locator("[data-program-parts-toggle]")).toBeHidden();
      else await expect(count).toBeVisible();
      const viewport = page.locator("[data-cad-viewport]:visible");
      for (let stage = 1; stage <= 2; stage++) {
        const parts = Array.from({ length: stage }, (_, index) => ({
          id: `part_${index}`,
          shape: "box",
          name: `阶段${index + 1}`,
          size: [20, 20, 20],
          position: [index * 30, 0, 0]
        }));
        await service.applyOperation({
          taskId,
          resourceId: resource.resourceId,
          appType: "cad",
          actor,
          operationId: `stage-${stage}`,
          baseRevision: stage - 1,
          operationType: sourceMode ? "cad.program.replace" : "cad.replace",
          payload: sourceMode
            ? {
                program: {
                  version: 2,
                  engine: "jscad",
                  units: "mm",
                  parameters: {},
                  source: `const {cuboid}=require('@jscad/modeling').primitives; const {translate}=require('@jscad/modeling').transforms; module.exports.main=()=>Array.from({length:${stage}},(_,i)=>translate([i*30,0,0],cuboid({size:[20,20,20]})));`
                }
              }
            : { model: { version: 1, units: "mm", parts } }
        });
        await expect(count).toHaveText(sourceMode ? `${stage}` : `${stage}/64`, { timeout: 5000 });
        await expect(count).toBeVisible();
        await expect(viewport).toHaveAttribute("data-ready", "true");
      }
      expect(errors).toEqual([]);
    } finally {
      await dashboard.stop();
    }
  });

test("standalone Blender commits refresh native scene snapshots before subsequent operations", async ({
  page
}) => {
  test.skip(!(await blenderStatus()).available, "Blender native runtime not installed");
  test.setTimeout(120000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { service, appInstance, taskId } = await standalone(page, dashboard, "blender");
    const { resource } = await service.createInApplication({
      taskId,
      appInstanceId: appInstance.appInstanceId,
      kind: "project/atria-blender+json",
      title: "逐步生成场景",
      actor
    });
    await expect(page.locator("[data-blender-title]:visible")).toHaveText("逐步生成场景");
    for (let stage = 1; stage <= 2; stage++) {
      await service.executeResourceCommand({
        taskId,
        resourceId: resource.resourceId,
        actor,
        operationId: `stage-${stage}`,
        baseRevision: stage - 1,
        command: "blender_run_python",
        params: {
          resetScene: true,
          source: `import bpy\ndef main(p):\n    for i in range(${stage}):\n        bpy.ops.mesh.primitive_cube_add(size=2, location=(i*3,0,0))\n        bpy.context.object.name='Stage'+str(i+1)\n`
        }
      });
      await expect(page.locator("[data-blender-count]:visible")).toHaveText(`${stage}`, { timeout: 5000 });
      await expect(page.locator("[data-blender-viewport]:visible")).toHaveAttribute("data-ready", "true");
      await expect(page.locator("[data-blender-objects]:visible")).toContainText(`Stage${stage}`);
    }
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("a standalone empty PPT app opens its new document and renders successive committed slides", async ({
  page
}) => {
  test.setTimeout(60000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const { service, appInstance, taskId } = await standalone(page, dashboard, "pptist");
    await expect(page.locator("[data-pptist-new]:visible")).toBeVisible();
    const { resource } = await service.createInApplication({
      taskId,
      appInstanceId: appInstance.appInstanceId,
      kind: "presentation/pptist+json",
      title: "逐步生成",
      actor
    });
    const frame = page.frameLocator('[data-app-mount]:not([hidden]) iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".canvas")).toBeVisible({ timeout: 30000 });
    const read = await service.readResource(taskId, resource.resourceId);
    const slideId = read.snapshot.content.slides[0].id;
    const commit = async (revision, text) =>
      service.applyOperation({
        taskId,
        appInstanceId: appInstance.appInstanceId,
        resourceId: resource.resourceId,
        appType: "pptist",
        operationId: `stage-${revision}`,
        operationType: "pptist.edit",
        baseRevision: revision,
        actor,
        payload: {
          changes: [
            {
              type: "upsert_element",
              slideId,
              element: {
                id: "title",
                type: "text",
                left: 60,
                top: 60,
                width: 860,
                height: 100,
                rotate: 0,
                content: `<p style="font-size:44px">${text}</p>`
              }
            }
          ]
        }
      });
    await commit(0, "第一阶段的标题");
    await expect(frame.locator(".canvas")).toContainText("第一阶段的标题", { timeout: 1800 });
    await commit(1, "第二阶段的标题");
    await expect(frame.locator(".canvas")).toContainText("第二阶段的标题", { timeout: 1800 });
    expect((await (await page.request.get(`${dashboard.base}/api/tasks`)).json()).tasks).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

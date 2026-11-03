import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { blenderStatus } from "../dist/src/software/blender/engine.js";

const native = (await blenderStatus()).available;
const source =
  "import bpy\ndef main(p):\n    bpy.ops.mesh.primitive_cube_add(size=2,location=(4,0,1))\n    bpy.context.object.name='Body'\n";
async function scene(page, base) {
  await page.goto(base);
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="blender"]').click();
  await confirmApplicationWorkspace(page);
  await page.locator("[data-blender-new]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("属性和取消验收");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator("[data-blender-source-toggle]").click();
  await page.locator("[data-blender-source]").fill(source);
  await page.locator("[data-blender-run]").click();
  await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
  await page.locator("[data-blender-select]").click();
  const tabs = await (await page.request.get(`${base}/api/workbench/tabs`)).json(),
    tab = tabs.tabs.find((item) => item.resourceId),
    url = `${base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
  return {
    url,
    read: async () => (await page.request.get(url)).json(),
    preview: async () => {
      const read = await (await page.request.get(url)).json();
      return (await page.request.post(`${url}/preview`, { data: { content: read.snapshot.content } })).json();
    }
  };
}

test("Blender keeps invalid object fields, saves focused values, and undo restores actual native properties", async ({
  page
}) => {
  test.skip(!native, "Blender native runtime not installed");
  test.setTimeout(90000);
  const dashboard = await startDashboard({ blenderExecutable: process.env.ATRIA_TEST_BLENDER_EXECUTABLE }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const model = await scene(page, dashboard.base),
      x = page.getByRole("spinbutton", { name: "位置 X", exact: true }),
      roughness = page.getByRole("spinbutton", { name: "粗糙度", exact: true }),
      scale = page.getByRole("spinbutton", { name: "缩放 X", exact: true }),
      initial = await model.read();
    await x.fill("");
    await x.press("Tab");
    await expect(x).toHaveValue("");
    await expect(x).toHaveAttribute("aria-invalid", "true");
    await page.locator("[data-blender-save]").click();
    await expect(page.locator("[data-blender-error]")).toContainText("修正对象属性");
    expect((await model.read()).resource.revision).toBe(initial.resource.revision);
    await page.reload();
    await expect(x).toHaveValue("");
    await x.fill("8");
    await x.press("ControlOrMeta+s");
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    expect((await model.preview()).scene.objects[0].position[0]).toBe(8);
    await roughness.fill("2");
    await roughness.press("Tab");
    await expect(roughness).toHaveValue("2");
    await expect(roughness).toHaveAttribute("aria-invalid", "true");
    const beforeInvalid = (await model.read()).resource.revision;
    await page.locator("[data-blender-undo]").click();
    await expect(page.locator("[data-blender-error]")).toContainText("修正对象属性");
    expect((await model.read()).resource.revision).toBe(beforeInvalid);
    await roughness.fill("0.31");
    await roughness.press("ControlOrMeta+s");
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    expect((await model.preview()).scene.objects[0].roughness).toBeCloseTo(0.31, 5);
    await scale.fill("0");
    await scale.press("Tab");
    await expect(scale).toHaveValue("0");
    await expect(page.locator("[data-blender-error]")).toContainText("缩放不能为零");
    await scale.fill("1");
    await scale.press("Tab");
    await expect(page.locator("[data-blender-status]")).toContainText("已保存");
    await page.locator("[data-blender-undo]").click();
    await expect(page.locator("[data-blender-status]")).toContainText("已保存", { timeout: 30000 });
    await expect(roughness).toHaveValue("0.5");
    expect((await model.preview()).scene.objects[0].position[0]).toBe(8);
    await page.screenshot({ path: test.info().outputPath("blender-object-input-after.png") });
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("Blender cancels native import without discarding the saved scene or preceding manual draft", async ({
  page
}) => {
  test.skip(!native, "Blender native runtime not installed");
  test.setTimeout(60000);
  const dashboard = await startDashboard({ blenderExecutable: process.env.ATRIA_TEST_BLENDER_EXECUTABLE });
  try {
    const model = await scene(page, dashboard.base),
      before = await model.read();
    const exported = await page.request.get(`${model.url}/download?format=blend`);
    expect(exported.ok()).toBe(true);
    const bytes = await exported.body();
    await page.locator("[data-blender-source]").fill("# manual draft before cancelled import");
    const importing = page.waitForRequest((request) => request.url().includes("/import-native?"));
    await page
      .locator("[data-blender-file]")
      .setInputFiles({ name: "synthetic.blend", mimeType: "application/octet-stream", buffer: bytes });
    await importing;
    await page.locator("[data-blender-cancel]").click();
    await expect(page.locator("[data-blender-error]")).toContainText("取消");
    const after = await model.read();
    expect(after.resource.revision).toBe(before.resource.revision + 1);
    expect(after.snapshot.content).toEqual({
      ...before.snapshot.content,
      source: "# manual draft before cancelled import"
    });
    expect((await model.preview()).scene.objects[0].position).toEqual([4, 0, 1]);
    await page.reload();
    await page.locator("[data-blender-source-toggle]").click();
    await expect(page.locator("[data-blender-source]")).toHaveValue("# manual draft before cancelled import");
  } finally {
    await dashboard.stop();
  }
});

test("Blender replaces a late native preview and keeps outdated object controls read-only", async ({
  page
}) => {
  test.skip(!native, "Blender native runtime not installed");
  test.setTimeout(60000);
  const dashboard = await startDashboard({ blenderExecutable: process.env.ATRIA_TEST_BLENDER_EXECUTABLE });
  let releaseOld, releaseCurrent;
  const oldGate = new Promise((resolve) => {
      releaseOld = resolve;
    }),
    currentGate = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
  try {
    const model = await scene(page, dashboard.base),
      before = await model.read(),
      nativeScene = await model.preview(),
      id = nativeScene.scene.objects[0].id;
    let requests = 0;
    await page.route("**/attachments/preview.glb?**", async (route) => {
      requests++;
      const response = await route.fetch();
      await (requests === 1 ? oldGate : currentGate);
      await route.fulfill({ response }).catch(() => {});
    });
    await page.locator("[data-blender-source]").fill(source + "\n# saved code only\n");
    await page.locator("[data-blender-save]").click();
    await expect.poll(() => requests).toBe(1);
    const current = await model.read();
    expect(current.resource.revision).toBe(before.resource.revision + 1);
    const changed = await page.request.post(`${model.url}/commands`, {
      data: {
        command: "blender_apply_operations",
        params: { edits: [{ id, name: "Updated Body" }] },
        baseRevision: current.resource.revision,
        operationId: "late-preview-human-rename"
      }
    });
    expect(changed.ok()).toBe(true);
    await expect.poll(() => requests).toBe(2);
    await expect(page.getByRole("textbox", { name: "对象名称" })).toBeDisabled();
    releaseOld();
    await expect(page.getByRole("textbox", { name: "对象名称" })).toBeDisabled();
    releaseCurrent();
    await expect(page.getByRole("textbox", { name: "对象名称" })).toHaveValue("Updated Body");
    await expect(page.getByRole("textbox", { name: "对象名称" })).toBeEnabled();
    await expect(page.locator("[data-blender-error]")).toBeHidden();
  } finally {
    releaseOld();
    releaseCurrent();
    await dashboard.stop();
  }
});

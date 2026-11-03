import { openCadExport } from "./cad-editor-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";

const curvedAssembly = `import cadquery as cq
def main(p):
    root = cq.Assembly(name='rotor',loc=cq.Location(cq.Vector(10,20,30)))
    group = cq.Assembly(name='rings',loc=cq.Location(cq.Vector(0,0,10)),color=cq.Color(1,0,0,1))
    for i in range(7):
        group.add(cq.Solid.makeTorus(20,5),name='ring_'+str(i),loc=cq.Location(cq.Vector(i*60,0,0)))
    root.add(group)
    return root
`;
const simpleBox = `import cadquery as cq
def main(p):
    return cq.Workplane('XY').box(2,3,4)
`;

test("native previews above the former budget retain full quality, every part and exact STEP", async ({
  page
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(150000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const editor = page.locator("[data-app-mount]:not([hidden])");
  const q = (selector) => editor.locator(selector);
  const previewFor = (source) =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith("/preview") &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.content?.source === source,
      { timeout: 60000 }
    );
  const expectFullQuality = async () => {
    await expect(q("[data-program-count]")).toHaveText("7", { timeout: 60000 });
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-ready", "true");
    await expect(q("[data-program-select]")).toHaveCount(7);
    for (let i = 0; i < 7; i++)
      await expect(q(`[data-program-select="solid_${i}"]`)).toContainText(`ring_${i}`);
    await expect(q("[data-program-preview-notice]")).toBeHidden();
    await expect(q("[data-program-details]")).not.toContainText("已调整预览精度");
    await expect(q("[data-program-error]")).toBeHidden();
    await expect(q("[data-program-retry]")).toBeHidden();
    await q("[data-program-parts-toggle]").click();
    await expect(q("[data-program-select]:visible")).toHaveCount(7);
    await q("[data-program-parts-toggle]").click();
  };
  try {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator('[data-create-app="cad"]').click();
    await confirmApplicationWorkspace(page);
    await page.locator("[data-cad-new]").click();
    await page.getByRole("textbox", { name: "文件名", exact: true }).fill("曲面装配.cad.json");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(q("[data-program-metrics]")).toHaveText("尚未生成模型", { timeout: 30000 });
    const importedPreview = previewFor(curvedAssembly);
    await q("[data-program-file]").setInputFiles({
      name: "curved-assembly.py",
      mimeType: "text/x-python",
      buffer: Buffer.from(curvedAssembly)
    });
    const response = await importedPreview;
    expect(response.ok()).toBe(true);
    await expectFullQuality();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    await expect(q("[data-program-source]")).toHaveValue(curvedAssembly);
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    const tabs = await (await page.request.get(`${dashboard.base}/api/workbench/tabs`)).json();
    const tab = tabs.tabs.find((entry) => entry.resourceId);
    const resourceUrl = `${dashboard.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
    const saved = await (await page.request.get(resourceUrl)).json();
    expect(saved.snapshot.content.source).toBe(curvedAssembly);
    expect(saved.snapshot.content.tessellation).toBeUndefined();
    // Large meshes exceed Chromium's response-body inspector cache. Inspect the same
    // real preview through the fixture's API context after the browser has rendered it.
    const inspectPreview = async (content) => {
      const result = await page.request.post(`${resourceUrl}/preview`, {
        data: { content, options: { timeoutMs: 60000 } }
      });
      expect(result.ok()).toBe(true);
      return result.json();
    };
    const geometry = await inspectPreview(saved.snapshot.content);
    expect(geometry.tessellation).toEqual({ linearTolerance: 0.1, angularTolerance: 0.1, adjusted: false });
    expect(geometry.positions.length / 9).toBeGreaterThan(200000);
    expect(geometry.features).toHaveLength(7);
    expect(geometry.brep.solids).toBe(7);

    const reloadedPreview = previewFor(curvedAssembly);
    await page.reload();
    expect((await reloadedPreview).ok()).toBe(true);
    await expectFullQuality();
    const reloaded = await inspectPreview(saved.snapshot.content);
    expect(reloaded.tessellation).toEqual(geometry.tessellation);
    expect(reloaded.features).toHaveLength(7);
    await expect(q("[data-program-source]")).toHaveValue(curvedAssembly);
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await openCadExport(editor);
    const downloaded = page.waitForEvent("download", { timeout: 60000 });
    await q('[data-program-export="step"]').click();
    const file = await downloaded;
    expect(file.suggestedFilename()).toMatch(/\.step$/);
    const bytes = await readFile(await file.path());
    expect(bytes.toString()).toMatch(/^ISO-10303-21;/);
    expect(bytes.toString()).toContain("END-ISO-10303-21;");
    await expect(q("[data-program-error]")).toBeHidden();
    expect((await (await page.request.get(resourceUrl)).json()).snapshot.content.source).toBe(curvedAssembly);

    await q("[data-program-source-toggle]").click();
    const boxPreview = previewFor(simpleBox);
    await q("[data-program-source]").fill(simpleBox);
    await q("[data-program-preview]").click();
    expect((await boxPreview).ok()).toBe(true);
    await expect(q("[data-program-count]")).toHaveText("1", { timeout: 30000 });
    const box = await inspectPreview({ ...saved.snapshot.content, source: simpleBox });
    expect(box.tessellation).toEqual({ linearTolerance: 0.1, angularTolerance: 0.1, adjusted: false });
    await expect(q("[data-program-preview-notice]")).toBeHidden();
    await expect(q("[data-program-details]")).not.toContainText("已调整预览精度");
    await expect(q("[data-program-error]")).toBeHidden();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    expect((await (await page.request.get(resourceUrl)).json()).snapshot.content.source).toBe(curvedAssembly);
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    expect((await (await page.request.get(resourceUrl)).json()).snapshot.content.source).toBe(simpleBox);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

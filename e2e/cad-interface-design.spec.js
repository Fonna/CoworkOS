import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { emptyCadQueryProgram } from "../dist/src/software/cad/program.js";
import { PNG } from "pngjs";

// The shipped CAD editor/viewport run against an isolated deterministic preview service.
// Geometry quality belongs to the native CAD suites; these cases exercise the UI state machine.
const source =
  "# UI_PARAMETER\nimport cadquery as cq\ndef main(p):\n    return cq.Workplane('XY').box(p.get('width', 20), 20, 10)\n";
const positions = [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 10, 0, 20, 0, 20, 0, 0];
function geometry(program) {
  const populated = program.source.includes("UI_PARAMETER");
  return {
    positions: populated ? positions : [],
    features: populated
      ? [
          {
            id: "solid_0",
            name: "壳体",
            positions,
            bounds: [
              [0, 0, 0],
              [20, 20, 10]
            ]
          }
        ]
      : [],
    dimensions: populated ? [20, 20, 10] : [0, 0, 0],
    volume: populated ? 2000 : 0,
    definitions: populated
      ? [{ name: "width", caption: "宽度", type: "float", min: 1, max: 100, step: 1 }]
      : [],
    parameters: { width: program.parameters.width ?? 20 },
    diagnostics: populated ? "尺寸计算已完成" : "",
    assessment: {
      geometry: "mesh_valid",
      completeness: "not_declared",
      warnings: [],
      sourceChecks: [],
      limitations: [],
      note: "仅用于界面验收"
    }
  };
}
async function openEditor(page) {
  const dashboard = await startDashboard();
  const previewState = { fail: false };
  await page.route("**/api/tasks/*/resources/*/preview", async (route) => {
    if (previewState.fail)
      return route.fulfill({ status: 503, json: { error: "CadQuery 运行时缺失，请在设置中安装" } });
    await route.fulfill({ json: geometry(route.request().postDataJSON().content) });
  });
  const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
  await store.createTask("cad-interface", { goal: "检查 CAD 界面" });
  const created = await page.request.post(`${dashboard.base}/api/tasks/cad-interface/resources`, {
    data: {
      kind: "model/atria-cadquery+json",
      title: "界面检查.cad.json",
      initialContent: emptyCadQueryProgram()
    }
  });
  expect(created.status()).toBe(201);
  const { resource } = await created.json();
  await page.request.post(`${dashboard.base}/api/workbench/tabs`, {
    data: { kind: "application", resourceId: resource.resourceId, bindTo: "cad-interface" }
  });
  await page.route("**/api/tasks/*/resources/*/selection", (route) =>
    route.fulfill({ json: { selection: route.request().postDataJSON() } })
  );
  await page.goto(`${dashboard.base}/?task=cad-interface`);
  await page.locator('#project-list [data-task="cad-interface"]').click();
  const context = page.locator("[data-composer-context]");
  if (await context.isVisible()) await context.click();
  const editor = page.locator("[data-app-mount]:not([hidden])");
  await expect(editor.locator("[data-program-metrics]")).toHaveText("尚未生成模型");
  return { dashboard, editor, previewState, q: (selector) => editor.locator(selector) };
}
async function populate(q) {
  await q("[data-program-file]").setInputFiles({
    name: "interface.py",
    mimeType: "text/plain",
    buffer: Buffer.from(source)
  });
  await expect(q("[data-program-count]")).toHaveText("1");
  await expect(q("[data-program-preview-notice]")).toBeHidden();
}

test("CAD panels follow empty, parameter and selected-object states without losing drafts or keyboard focus", async ({
  page
}, info) => {
  const { dashboard, editor, previewState, q } = await openEditor(page);
  try {
    await expect(q(".cad-inspector")).toBeHidden();
    await expect(q("[data-program-view-menu]")).toBeHidden();
    await expect(q("[data-program-parts-toggle]")).toBeHidden();
    await expect(q("[data-inspect-measure-panel]")).toBeHidden();
    await page.screenshot({ path: info.outputPath("cad-empty-1440.png") });
    await q("[data-program-empty-code]").click();
    await expect(q("[data-program-source]")).toBeFocused();
    await q("[data-program-source-toggle]").click();
    await expect(q("[data-program-source-panel]")).toBeHidden();
    await q("[data-program-file-menu]").click();
    await q("[data-program-open-checks]").click();
    await expect(q("[data-program-check-panel]")).toBeVisible();
    await q("[data-program-inspector-close]").click();
    await expect(q("[data-program-file-menu]")).toBeFocused();
    await populate(q);
    await q("[data-program-inspector-toggle]").click();
    await expect(q("[data-program-parameter-section]")).toBeVisible();
    await expect(q("[data-program-selected-properties]")).toBeHidden();
    await expect(q("[data-program-check-panel]")).toBeHidden();
    const width = q('[data-program-param="width"]');
    await width.fill("24");
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "dirty");
    await expect(q("[data-program-preview-notice]")).toBeHidden();
    await expect(width).toBeFocused();
    await expect(width).toHaveValue("24");
    await q("[data-program-inspector-close]").click();
    await expect(q(".cad-inspector")).toBeHidden();
    await expect(q("[data-program-inspector-toggle]")).toBeFocused();
    await q("[data-program-view-menu]").press("ArrowDown");
    await expect(q("[data-program-view-panel]")).toBeVisible();
    await q("[data-program-style]").focus();
    await q("[data-program-style]").press("ArrowDown");
    await expect(q("[data-program-view-panel]")).toBeVisible();
    await q("[data-program-style]").press("Tab");
    await expect(q("[data-program-view-panel]")).toBeVisible();
    await q("[data-program-view-panel]").press("Escape");
    await expect(q("[data-program-view-panel]")).toBeHidden();
    await expect(q("[data-program-view-menu]")).toBeFocused();
    await q("[data-program-parts-toggle]").click();
    await q('[data-program-select="solid_0"]').click();
    await expect(q("[data-program-selected-properties]")).toBeVisible();
    await expect(q("[data-program-part-info]")).toContainText("壳体");
    await expect(q("[data-inspect-reference]")).toHaveValue(/#solid_0$/);
    await q("[data-inspect-actions]").press("ArrowDown");
    await expect(editor.getByRole("menuitem", { name: "复制引用", exact: true })).toBeFocused();
    await expect(q(".cad-context-menu .cad-menu-group")).toHaveCount(3);
    await editor.getByRole("menuitem", { name: "复制引用", exact: true }).press("Escape");
    await expect(q("[data-inspect-actions]")).toBeFocused();
    await q('[data-program-inspector-tab="checks"]').click();
    await expect(q("[data-inspect-quality]")).toBeVisible();
    await expect(q("[data-program-diagnostics]")).toBeVisible();
    await expect(q("[data-program-properties]")).toBeHidden();
    await q('[data-program-inspector-tab="checks"]').press("ArrowLeft");
    await expect(q('[data-program-inspector-tab="properties"]')).toBeFocused();
    await expect(width).toHaveValue("24");
    await q("[data-program-save]").click();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    await q("[data-program-file-menu]").click();
    await expect(q("[data-program-export-menu]")).toHaveCSS("font-size", "14px");
    await expect(q("[data-program-export-menu]")).toHaveCSS("display", "flex");
    await expect(q("[data-program-export-menu]")).toHaveCSS("border-top-style", "none");
    await expect(q("[data-application-save-copy]")).toBeVisible();
    await expect(editor.getByRole("button", { name: "保存到… / 加入项目", exact: true })).toHaveCount(0);
    await q("[data-application-save-copy]").click();
    const saveDialog = page.getByRole("dialog", { name: "保存到目录或项目", exact: true });
    await expect(saveDialog).toBeVisible();
    await saveDialog.getByRole("button", { name: "取消", exact: true }).click();
    await q("[data-program-inspector-close]").click();
    await q("[data-program-view-menu]").click();
    await q('[data-inspect-nav="measure"]').click();
    await expect(q("[data-inspect-measure-panel]")).toBeVisible();
    await expect(q("[data-program-view-panel]")).toBeHidden();
    await q("[data-inspect-measure-exit]").click();
    await expect(q("[data-inspect-measure-panel]")).toBeHidden();
    await expect(q("[data-program-view-menu]")).toBeFocused();
    await expect(q("[data-program-status]")).toHaveAttribute("data-state", "saved");
    previewState.fail = true;
    await page.setViewportSize({ width: 960, height: 900 });
    await q("[data-program-inspector-toggle]").click();
    await width.fill("28");
    await expect(q("[data-program-preview-details]")).toBeVisible();
    await expect(q("[data-program-properties]")).toBeVisible();
    await expect(q("[data-program-preview-details]")).toBeInViewport();
    await page.screenshot({ path: info.outputPath("cad-error-properties-960.png") });
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("cad-error-properties-320.png") });
    await q("[data-program-preview-details]").click();
    await expect(q("[data-program-preview-error-text]")).toContainText("运行时缺失");
    await expect(q("[data-program-component-settings]")).toBeVisible();
    await expect(width).toHaveValue("28");
    previewState.fail = false;
    await q("[data-program-check-retry]").click();
    await expect(q("[data-program-preview-notice]")).toBeHidden();
    await expect(q("[data-program-preview-error]")).toBeHidden();
    await expect(q('[data-program-inspector-tab="checks"]')).toBeFocused();
    await q("[data-program-source-toggle]").click();
    await expect(q(".cad-inspector")).toBeHidden();
    await expect(q("[data-program-source]")).toBeFocused();
    await q("[data-program-inspector-toggle]").click();
    await expect(q(".cad-inspector")).toBeVisible();
    await q("[data-program-source]").focus();
    await expect(q(".cad-inspector")).toBeHidden();
    await q("[data-program-preview]").click();
    await expect(q("[data-program-preview-notice]")).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("CAD canvas controls stay on one row and the requested panels fit split and narrow layouts", async ({
  page
}, info) => {
  test.setTimeout(90000);
  const { dashboard, editor, q } = await openEditor(page);
  try {
    await populate(q);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const pixels = PNG.sync.read(await q("[data-cad-viewport] canvas").screenshot());
      expect(pixels.data[0] > 150).toBe(theme === "light");
      for (const width of [1440, 960, 700, 620, 320]) {
        await page.setViewportSize({ width, height: 800 });
        if (!(await editor.isVisible())) await page.locator("[data-composer-context]").click();
        if (!(await q(".cad-inspector").isVisible())) await q("[data-program-inspector-toggle]").click();
        await expect(q("[data-program-parameter-section]")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const panel = await q(".cad-inspector").boundingBox();
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: info.outputPath(`cad-properties-${theme}-${width}.png`) });
        await q("[data-program-inspector-close]").click();
        const bar = await q(".cad-view-controls").boundingBox();
        expect(bar.height).toBeLessThanOrEqual(42);
        await q("[data-program-view-menu]").click();
        const view = await q("[data-program-view-panel]").boundingBox();
        expect(view.x).toBeGreaterThanOrEqual(0);
        expect(view.x + view.width).toBeLessThanOrEqual(width);
        expect(view.y + view.height).toBeLessThanOrEqual(800);
        await page.screenshot({ path: info.outputPath(`cad-view-${theme}-${width}.png`) });
        await q("[data-program-view-close]").click();
        const workspace = await q(".cad-workspace").boundingBox();
        const stage = await q(".cad-program-stage").boundingBox();
        expect(Math.abs(stage.width - workspace.width)).toBeLessThan(2);
        await q("[data-program-parts-toggle]").click();
        await q("[data-program-tree-pin]").check();
        await q('[data-program-select="solid_0"]').click();
        if ((await q("section.cad-program-editor").boundingBox()).width <= 760)
          await expect(q(".cad-inspector")).toBeHidden();
        await expect(q("[data-program-parts-panel]")).toBeVisible();
        await q("[data-program-parts-toggle]").click();
        await q("[data-program-file-menu]").click();
        await q("[data-program-export-menu]").click();
        const parentMenu = await q("[data-program-file-panel]").boundingBox();
        const childMenu = await q("[data-program-export-panel]").boundingBox();
        if ((await q("section.cad-program-editor").boundingBox()).width <= 680)
          expect(childMenu.x + childMenu.width).toBeLessThanOrEqual(parentMenu.x + parentMenu.width);
        await page.screenshot({ path: info.outputPath(`cad-export-${theme}-${width}.png`) });
        await q("[data-program-export-panel]").press("Escape");
        await q("[data-program-file-panel]").press("Escape");
      }
    }
  } finally {
    await dashboard.stop();
  }
});

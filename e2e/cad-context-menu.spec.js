import { openCadView } from "./cad-editor-helper.js";
import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { emptyCadQueryProgram } from "../dist/src/software/cad/program.js";

const source = `import cadquery as cq
def main(p):
 a=cq.Assembly(name='mechanism')
 a.add(cq.Workplane('XY').circle(18).extrude(24),name='rotor')
 a.add(cq.Workplane('XY').box(15,15,24).translate((-42,0,12)),name='left')
 a.add(cq.Workplane('XY').box(15,15,24).translate((42,0,12)),name='right')
 return a
def get_motion(p):
 return {'duration':2,'tracks':[{'path':'/mechanism/rotor','type':'rotation','axis':[0,0,1],'times':[0,2],'values':[0,360]}]}
`;

test("canvas right-click offers visible clickable commands in conversation and simulation", async ({
  page,
  request
}) => {
  test.skip(process.platform !== "darwin", "Native CAD requires macOS isolation");
  test.setTimeout(120000);
  const dashboard = await startDashboard(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
    await store.createTask("cad-menu", { goal: "检查右键菜单" });
    const created = await request.post(`${dashboard.base}/api/tasks/cad-menu/resources`, {
      data: {
        kind: "model/atria-cadquery+json",
        title: "菜单机构.cad.json",
        initialContent: { ...emptyCadQueryProgram(), source }
      }
    });
    expect(created.status()).toBe(201);
    const { resource } = await created.json();
    await request.post(`${dashboard.base}/api/workbench/tabs`, {
      data: { kind: "application", resourceId: resource.resourceId, bindTo: "cad-menu" }
    });
    await page.goto(dashboard.base);
    await page.locator('#project-list [data-task="cad-menu"]').click();
    const editor = page.locator("[data-app-mount]:not([hidden])"),
      q = (s) => editor.locator(s);
    await expect(q("[data-program-count]")).toHaveText("3", { timeout: 65000 });
    await q("[data-program-view]").selectOption("front");
    const canvas = q("[data-cad-viewport] canvas"),
      menu = q(".cad-context-menu");
    async function rightClick(x = 0.5, y = 0.5) {
      const rect = await canvas.boundingBox();
      await canvas.click({ button: "right", position: { x: rect.width * x, y: rect.height * y } });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1440);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      expect(
        await menu.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return e.contains(document.elementFromPoint(r.x + 20, r.y + 20));
        })
      ).toBe(true);
    }
    await openCadView(editor);
    await q('[data-inspect-nav="measure"]').click();
    let release,
      held = 0;
    const gate = new Promise((done) => {
      release = done;
    });
    await page.route("**/selection", async (route) => {
      held++;
      await gate;
      await route.continue();
    });
    try {
      await rightClick();
      await expect.poll(() => held).toBeGreaterThan(0);
      await expect(menu).toBeVisible({ timeout: 1000 });
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await canvas.focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu).toBeVisible({ timeout: 1000 });
      await page.keyboard.press("Escape");
      await q("[data-inspect-actions]").click();
      await expect(menu).toBeVisible({ timeout: 1000 });
      await expect(q("[data-inspect-actions]")).toHaveAttribute("aria-expanded", "true");
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
    await expect(editor.getByRole("menuitem", { name: "隐藏选中", exact: true })).toBeEnabled();
    await editor.getByRole("menuitem", { name: "隐藏选中", exact: true }).click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "2");
    await rightClick(0.02, 0.35);
    await editor.getByRole("menuitem", { name: "显示全部零件", exact: true }).click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "3");
    await openCadView(editor);
    await q("[data-inspect-simulation]").click();
    await q("[data-program-play]").click();
    await q("[data-program-view]").selectOption("front");
    await rightClick();
    await editor.getByRole("menuitem", { name: "隔离选中", exact: true }).click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "1");
    await rightClick(0.98, 0.35);
    await editor.getByRole("menuitem", { name: "显示全部零件", exact: true }).click();
    await expect(q("[data-cad-viewport]")).toHaveAttribute("data-visible-parts", "3");
    await q("[data-inspect-simulation-close]").click();
    const saved = await (
      await request.get(`${dashboard.base}/api/tasks/cad-menu/resources/${resource.resourceId}`)
    ).json();
    expect(saved.resource.revision).toBe(0);
    expect(saved.snapshot.content.source).toBe(source);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

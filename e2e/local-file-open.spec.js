import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { openPresentationFileMenu } from "./pptist-helper.js";
import { test, expect } from "@playwright/test";
import PptxGenJS from "pptxgenjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("empty applications import local files into the same independent instance", async ({ page }) => {
  test.setTimeout(90000);
  const dashboard = await startDashboard();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const get = async (path) => (await page.request.get(`${dashboard.base}${path}`)).json();
  const launch = async (app) => {
    if (!(await page.locator("#apps-panel").isVisible())) await page.locator("#apps-nav").click();
    const opened = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/workbench/open-application") && response.request().method() === "POST"
    );
    await page.locator(`[data-create-app="${app}"]`).click();
    await confirmApplicationWorkspace(page);
    await opened;
    const markers = {
      "text-editor": "data-empty-new",
      cad: "data-cad-new",
      blender: "data-blender-new",
      pptist: "data-pptist-new"
    };
    await expect(page.locator(`[data-app-mount]:visible [${markers[app]}]`)).toBeVisible();
    await expect(page.locator("[data-app-mount]:visible [data-local-open]")).toBeVisible();
  };
  const upload = (name, buffer) =>
    page
      .locator("[data-app-mount]:visible [data-local-file]")
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  try {
    await page.goto(dashboard.base);
    await launch("text-editor");
    // Canceling the OS picker creates nothing.
    const picker = page.waitForEvent("filechooser");
    await page.locator("[data-local-open]:visible").click();
    await (await picker).setFiles([]);
    expect((await get("/api/workbench/temporary-resources")).resources).toHaveLength(0);
    await upload("wrong.bin", Buffer.from("bad"));
    await expect(page.locator("[data-local-status]:visible")).toContainText("打开失败");
    expect((await get("/api/workbench/temporary-resources")).resources).toHaveLength(0);
    await upload("笔记.md", Buffer.from("# 本地内容\n导入后继续编辑"));
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# 本地内容\n导入后继续编辑");
    expect(
      (await get("/api/workbench/tabs")).tabs.filter((entry) => entry.kind === "application")
    ).toHaveLength(1);
    await launch("cad");
    await upload("broken.cad.json", Buffer.from("{}"));
    await expect(page.locator("[data-local-status]:visible")).toContainText("打开失败");
    expect((await get("/api/workbench/temporary-resources")).resources).toHaveLength(1);
    await upload("local.jscad", Buffer.from("function main() { return []; } module.exports = { main };"));
    await expect
      .poll(async () =>
        (await get("/api/workbench/temporary-resources")).resources.some(
          (r) => r.title === "local.jscad" && r.kind === "model/atria-jscad+json"
        )
      )
      .toBe(true);
    await launch("blender");
    await upload("broken.blend", Buffer.from("not a blend file"));
    await expect(page.locator("[data-local-status]:visible")).toContainText("打开失败", { timeout: 30000 });
    expect((await get("/api/workbench/temporary-resources")).resources).toHaveLength(2);
    await launch("pptist");
    const pptx = new PptxGenJS();
    pptx.addSlide().addText("打开已有演示文稿", { x: 1, y: 1, w: 5, h: 1 });
    await upload("已有文稿.pptx", await pptx.write({ outputType: "nodebuffer" }));
    const frame = page.frameLocator('[data-app-mount]:visible iframe[title="PPT 演示文稿编辑器"]');
    await expect(frame.locator(".canvas")).toContainText("打开已有演示文稿", { timeout: 30000 });
    await openPresentationFileMenu(page);
    await expect(frame.locator("[data-pptist-title]")).toContainText("已有文稿");
    expect((await get("/api/tasks")).tasks).toHaveLength(0);
    expect(
      (await get("/api/workbench/tabs")).tabs.filter((entry) => entry.kind === "application")
    ).toHaveLength(4);
    expect(errors).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

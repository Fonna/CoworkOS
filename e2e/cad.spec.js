import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";
let server;
test.beforeEach(async ({ page }) => {
  server = await startDashboard();
  await page.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
  await page.goto(server.base);
});
test.afterEach(async () => {
  await server?.stop();
});
async function createCad(page) {
  await page.locator("#apps-nav").click();
  await page.locator('[data-create-app="cad"]').click();
  await confirmApplicationWorkspace(page);
  await page.locator("[data-cad-more] summary").click();
  await page.locator("[data-cad-new-basic]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("支架.cad.json");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.locator("[data-cad-save]")).toBeVisible();
  await expect(page.locator("[data-application-save-copy]")).toHaveCount(1);
}
async function save(page) {
  await page.locator("[data-cad-save]").click();
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
}
test("CAD file menu supports keyboard navigation, Escape and outside dismissal", async ({ page }) => {
  await createCad(page);
  const trigger = page.locator("[data-cad-file-menu]");
  const panel = page.locator("[data-cad-file-actions]");
  await trigger.press("ArrowDown");
  await expect(page.locator("[data-cad-import]")).toBeFocused();
  await page.locator("[data-cad-import]").press("End");
  await expect(page.locator("[data-application-save-copy]")).toBeFocused();
  await page.locator("[data-application-save-copy]").press("ArrowDown");
  await expect(page.locator("[data-cad-import]")).toBeFocused();
  await page.locator("[data-cad-import]").press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator("[data-cad-add='box']").click();
  await expect(panel).toBeHidden();
  await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  const cleared = page.waitForResponse(
    (response) => response.url().endsWith("/selection") && response.request().method() === "PUT"
  );
  await page.locator("[data-cad-viewport] canvas").click({ position: { x: 3, y: 3 } });
  expect((await cleared).ok()).toBe(true);
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
});
test("CAD creates actual geometry, edits dimensions, cuts a hole, exports and restores", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createCad(page);
  await page.locator('[data-cad-add="box"]').click();
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await expect(page.locator("[data-cad-metrics]")).toContainText("24000.0");
  await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("60");
  await save(page);
  await expect(page.locator("[data-cad-metrics]")).toContainText("36000.0");
  await page.locator('[data-cad-add="cylinder"]').click();
  await page.getByLabel("特征作用", { exact: true }).selectOption("cut");
  await page.getByRole("spinbutton", { name: "半径", exact: true }).fill("5");
  await page.getByRole("spinbutton", { name: "高度", exact: true }).fill("30");
  await page.getByRole("spinbutton", { name: "位置 X", exact: true }).fill("0");
  await save(page);
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await expect(page.locator("[data-cad-metrics]")).toContainText("34439.");
  const jsonEvent = page.waitForEvent("download");
  await page.locator("[data-cad-file-menu]").click();
  await page.locator("[data-cad-json]").click();
  const jsonFile = await jsonEvent;
  const model = JSON.parse(await readFile(await jsonFile.path(), "utf8"));
  expect(model.parts).toHaveLength(2);
  expect(model.parts[1].mode).toBe("cut");
  const stlEvent = page.waitForEvent("download");
  await page.locator("[data-cad-file-menu]").click();
  await page.locator("[data-cad-stl]").click();
  const stlFile = await stlEvent;
  const bytes = await readFile(await stlFile.path());
  expect(stlFile.suggestedFilename()).toBe("支架.stl");
  expect(bytes.readUInt32LE(80)).toBeGreaterThan(20);
  expect(bytes.length).toBe(84 + bytes.readUInt32LE(80) * 50);
  await page.reload();
  await expect(page.locator("[data-cad-count]")).toHaveText("2/64");
  await page.locator("[data-cad-select]").last().click();
  await expect(page.getByLabel("特征作用", { exact: true })).toHaveValue("cut");
  await page.locator("[data-cad-undo]").click();
  await expect(page.getByLabel("特征作用", { exact: true })).toHaveValue("add");
  const canvas = page.locator("[data-cad-viewport] canvas");
  await canvas.hover();
  await page.mouse.down();
  await page.mouse.move(650, 460);
  await page.mouse.up();
  await page.locator('[data-cad-view="top"]').click();
  await expect(canvas).toBeVisible();
  expect(errors).toEqual([]);
});
test("CAD failed saves retain drafts across refresh, conflicts require explicit reload", async ({ page }) => {
  await createCad(page);
  await page.locator('[data-cad-add="box"]').click();
  await save(page);
  await page.route("**/operations", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline"}' })
  );
  await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("73");
  await page.locator("[data-cad-save]").click();
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "error");
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("73");
  await page.unroute("**/operations");
  await save(page);
  const tabs = await (await page.request.get(`${server.base}/api/workbench/tabs`)).json();
  const tab = tabs.tabs.find((t) => t.resourceId);
  const endpoint = `${server.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
  const read = await (await page.request.get(endpoint)).json();
  await page.getByRole("spinbutton", { name: "宽度 X", exact: true }).fill("90");
  await page.request.post(`${endpoint}/operations`, {
    data: {
      appType: "cad",
      operationId: "agent-edit",
      operationType: "cad.upsert",
      baseRevision: read.resource.revision,
      payload: { part: { ...read.snapshot.content.parts[0], size: [80, 30, 20] } }
    }
  });
  await page.locator("[data-cad-save]").click();
  await expect(page.locator("[data-cad-status]")).toContainText("版本冲突");
  await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("90");
  await page.locator("[data-cad-reload]").click();
  await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("80");
});
test("CAD imports and renames models, rejects invalid imports, and undoes deletion", async ({ page }) => {
  await createCad(page);
  const file = (model) => ({
    name: "import.cad.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(model))
  });
  const model = {
    version: 1,
    units: "mm",
    parts: [{ id: "ball", name: "球体", shape: "sphere", radius: 8 }]
  };
  await page.locator("[data-cad-file]").setInputFiles(file(model));
  await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  await expect(page.getByRole("spinbutton", { name: "半径", exact: true })).toHaveValue("8");
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await page.locator("[data-cad-rename]").click();
  await page.getByRole("textbox", { name: "文件名" }).fill("球体样件.cad.json");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator("[data-cad-title]")).toHaveText("球体样件.cad.json");
  await page.locator("[data-cad-file]").setInputFiles(file({ ...model, version: 2 }));
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "error");
  await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
  await page.locator("[data-cad-delete]").click();
  await expect(page.locator("[data-cad-count]")).toHaveText("0/64");
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  await page.locator("[data-cad-file-menu]").click();
  await page.locator("[data-cad-stl]").click();
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "error");
  await page.locator("[data-cad-undo]").click();
  await expect(page.locator("[data-cad-count]")).toHaveText("1/64");
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  await page.reload();
  await expect(page.locator("[data-cad-title]")).toHaveText("球体样件.cad.json");
  await expect(page.getByRole("spinbutton", { name: "半径", exact: true })).toHaveValue("8");
});

test("human edits select geometry, move with handles, cancel, copy and undo", async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await createCad(page);
  await page.locator('[data-cad-add="box"]').click();
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await page.locator('[data-cad-add="sphere"]').click();
  await expect(page.locator("[data-cad-count]")).toHaveText("2/64");
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("32");
  await expect(page.locator("[data-cad-viewport]")).toHaveAttribute("data-mode", "translate");
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await expect(page.locator("[data-cad-metrics]")).not.toContainText("计算");
  await page.locator('[data-cad-view="selected"]').click();
  await page.locator('[data-cad-mode="select"]').click();
  const canvas = page.locator("[data-cad-viewport] canvas");
  const rect = await canvas.boundingBox();
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await canvas.click({ position: { x: rect.width - 8, y: rect.height - 8 } });
  await expect(page.locator("[data-cad-form]")).toContainText("未选中特征");
  await page.mouse.click(center.x, center.y);
  await expect(page.getByRole("textbox", { name: "特征名称" })).toHaveValue("球体");
  await page.locator('[data-cad-mode="translate"]').click();
  await page.locator("[data-cad-snap]").check();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 60, center.y + 20, { steps: 8 });
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "dirty");
  await expect(page.locator('[data-cad-mode="rotate"]')).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toBeDisabled();
  await page.keyboard.press("r");
  await expect(page.locator("[data-cad-viewport]")).toHaveAttribute("data-mode", "translate");
  await page.mouse.up();
  await expect(page.locator("[data-cad-status]")).toContainText("r3");
  const x = await page.getByRole("spinbutton", { name: "位置 X", exact: true }).inputValue();
  const y = await page.getByRole("spinbutton", { name: "位置 Y", exact: true }).inputValue();
  expect([x, y]).not.toEqual(["32", "0"]);
  expect(Number.isInteger(Number(x)) && Number.isInteger(Number(y))).toBe(true);
  await page.locator('[data-cad-view="selected"]').click();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 35, center.y + 25, { steps: 5 });
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "dirty");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("[data-cad-status]")).toContainText("r3");
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue(x);
  await expect(page.getByRole("spinbutton", { name: "位置 Y", exact: true })).toHaveValue(y);
  await page.locator("[data-cad-duplicate]").click();
  await expect(page.locator("[data-cad-count]")).toHaveText("3/64");
  await expect(page.getByRole("textbox", { name: "特征名称" })).toHaveValue("球体 副本");
  await page.locator("[data-cad-undo]").click();
  await expect(page.locator("[data-cad-count]")).toHaveText("2/64");
  await page.locator("[data-cad-select]").last().click();
  await page.locator('[data-cad-mode="rotate"]').click();
  await page.locator("[data-cad-snap]").uncheck();
  await expect(page.locator('[data-cad-mode="rotate"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-cad-view="selected"]').click();
  // Drag the outer view-plane ring: its radius scales with viewport height.
  const ring = rect.height * 0.1514;
  await page.mouse.move(center.x + ring, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + ring * Math.cos(Math.PI / 6), center.y - ring / 2, { steps: 10 });
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "dirty");
  await page.mouse.up();
  await expect(page.locator("[data-cad-status]")).toContainText("r6");
  const angles = await page
    .locator('[data-cad-field^="rotation."]')
    .evaluateAll((fields) => fields.map((f) => Number(f.value)));
  expect(angles.some((angle) => Math.abs(angle) > 1)).toBe(true);
  await page.getByRole("spinbutton", { name: "旋转 Z", exact: true }).fill("45");
  await save(page);
  await page.reload();
  await page.locator("[data-cad-select]").last().click();
  await expect(page.getByRole("spinbutton", { name: "旋转 Z", exact: true })).toHaveValue("45");
  expect(errors).toEqual([]);
});

test("a remote edit during a drag cannot overwrite either saved data or the local draft", async ({
  page
}) => {
  await createCad(page);
  await page.locator('[data-cad-add="box"]').click();
  await expect(page.locator('[data-cad-viewport][data-ready="true"]')).toBeVisible();
  await page.locator('[data-cad-view="selected"]').click();
  const tabs = await (await page.request.get(`${server.base}/api/workbench/tabs`)).json();
  const tab = tabs.tabs.find((t) => t.resourceId);
  const endpoint = `${server.base}/api/tasks/${tab.accessTaskId}/resources/${tab.resourceId}`;
  const before = await (await page.request.get(endpoint)).json();
  const rect = await page.locator("[data-cad-viewport] canvas").boundingBox();
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 60, center.y + 20, { steps: 8 });
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "dirty");
  const localX = await page.getByRole("spinbutton", { name: "位置 X", exact: true }).inputValue();
  expect(Number(localX)).not.toBe(0);
  const remote = await page.request.post(`${endpoint}/operations`, {
    data: {
      appType: "cad",
      operationId: "remote-during-drag",
      operationType: "cad.upsert",
      baseRevision: before.resource.revision,
      payload: { part: { ...before.snapshot.content.parts[0], size: [80, 30, 20] } }
    }
  });
  expect(remote.ok()).toBe(true);
  await page.mouse.up();
  await expect(page.locator("[data-cad-status]")).toContainText("版本冲突");
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue(localX);
  const saved = await (await page.request.get(endpoint)).json();
  expect(saved.snapshot.content.parts[0].size).toEqual([80, 30, 20]);
  expect(saved.snapshot.content.parts[0].position).toEqual([0, 0, 0]);
  await page.locator("[data-cad-reload]").click();
  await expect(page.getByRole("spinbutton", { name: "宽度 X", exact: true })).toHaveValue("80");
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("0");
});

test("an AI-sized model still accepts additions and capacity limits have visible feedback", async ({
  page
}) => {
  await createCad(page);
  const load = async (count) =>
    page.locator("[data-cad-file]").setInputFiles({
      name: "rocket.cad.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          version: 1,
          units: "mm",
          parts: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, shape: "box" }))
        })
      )
    });
  await load(32);
  await expect(page.locator("[data-cad-count]")).toHaveText("32/64");
  await page.locator('[data-cad-add="sphere"]').click();
  await expect(page.locator("[data-cad-count]")).toHaveText("33/64");
  await expect(page.getByRole("spinbutton", { name: "位置 X", exact: true })).toHaveValue("32");
  await expect(page.locator("[data-cad-status]")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("[data-cad-file]")).toHaveValue("");
  await load(64);
  await expect(page.locator("[data-cad-count]")).toHaveText("64/64");
  await expect(page.locator('[data-cad-add="sphere"]')).toBeDisabled();
  await expect(page.locator("[data-cad-add-hint]")).toContainText("已达到 64 个特征上限");
});

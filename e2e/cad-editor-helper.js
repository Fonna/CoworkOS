import { expect } from "@playwright/test";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { emptyCadQueryProgram } from "../dist/src/software/cad/program.js";

/** Existing source CAD remains openable even when its legacy app tile is no longer listed. */
export async function openCadProgram(page, dashboard, title = "CAD 检查.cad.json") {
  return openCadResource(page, dashboard, {
    kind: "model/atria-cadquery+json",
    title,
    initialContent: { ...emptyCadQueryProgram(), source: "def main(p):\n    return []\n" }
  });
}

export async function openCadResource(page, dashboard, { kind, title, initialContent }) {
  const taskId = "cad-editor-fixture";
  const store = new LocalWorkspaceStore(dashboard.workspaceRoot);
  await store.createTask(taskId, { goal: title });
  const created = await page.request.post(`${dashboard.base}/api/tasks/${taskId}/resources`, {
    data: { kind, title, initialContent }
  });
  expect(created.status()).toBe(201);
  const { resource } = await created.json();
  const opened = await page.request.post(`${dashboard.base}/api/workbench/tabs`, {
    data: { kind: "application", resourceId: resource.resourceId, bindTo: taskId }
  });
  expect(opened.ok()).toBe(true);
  await page.goto(`${dashboard.base}/?task=${taskId}`);
  const context = page.locator("[data-composer-context]");
  if (await context.isVisible()) await context.click();
  return { resource, taskId };
}

export async function openCadExport(editor) {
  const filePanel = editor.locator("[data-program-file-panel]");
  if (!(await filePanel.isVisible())) await editor.locator("[data-program-file-menu]").click();
  const exports = editor.locator("[data-program-export-panel]");
  if (!(await exports.isVisible())) await editor.locator("[data-program-export-menu]").click();
}

export async function openCadView(editor) {
  if (!(await editor.locator("[data-program-view-panel]").isVisible()))
    await editor.locator("[data-program-view-menu]").click();
}

export async function openCadProperties(editor) {
  if (!(await editor.locator(".cad-inspector").isVisible()))
    await editor.locator("[data-program-inspector-toggle]").click();
  await editor.locator('[data-program-inspector-tab="properties"]').click();
}

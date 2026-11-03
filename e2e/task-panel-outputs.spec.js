import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("task-panel outputs and title controls remain usable at every sidebar width", async ({ page }, info) => {
  test.setTimeout(60_000);
  const dashboard = await startDashboard();
  const taskId = "task-panel-output-layout";
  const title = "桌面恢复验证.txt";
  const content = "切换侧栏后文档和草稿仍然保留。\n";
  const errors = [];
  const measurements = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const post = async (path, data) => {
    const response = await page.request.post(`${dashboard.base}${path}`, { data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  try {
    await page.addInitScript(() => localStorage.setItem("atria.appearance", "system"));
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
    await post("/api/tasks", { taskId, goal: "验证侧栏产出物与编辑器恢复" });
    const created = await post(`/api/tasks/${taskId}/resources`, {
      appType: "text-editor",
      kind: "text/plain",
      title,
      initialContent: content
    });
    const resourceId = created.resource.resourceId;
    await new LocalWorkspaceStore(dashboard.workspaceRoot).publishArtifact({
      taskId,
      runId: "layout-fixture",
      producerAgentId: "main",
      relativePath: `exports/${resourceId}/${title}`,
      displayName: title,
      mimeType: "text/plain",
      content,
      sourceResourceId: resourceId
    });
    await post("/api/workbench/tabs", { kind: "conversation", taskId });
    await post("/api/workbench/tabs", { kind: "application", resourceId, bindTo: taskId });
    await page.goto(dashboard.base);
    const editor = page.locator("[data-editor-input]:visible");
    await expect(editor).toHaveValue(content);
    const collaborate = page.locator("[data-app-collaborate]");
    if (await collaborate.isVisible()) await collaborate.click();
    await expect(page.locator("body")).toHaveClass(/application-task-layout/);
    const pane = page.locator("#agent-pane");
    const navigation = page.getByRole("button", { name: "显示默认侧栏", exact: true });
    const tasks = page.getByRole("button", { name: "显示任务面板", exact: true });
    if (!(await pane.isVisible())) await tasks.click();
    const row = page.locator(`#output-list [data-resource-row="${resourceId}"]`);
    const open = row.locator("[data-open-resource]");
    const download = row.locator("[data-output-download]");
    const divider = page.locator("#sidebar-divider");
    const refresh = page.getByRole("button", { name: "刷新任务面板", exact: true });
    await expect(row).toHaveCount(1);
    await expect(download).toHaveCount(1);
    await page.locator("#composer-input").fill("调整任务面板时保留草稿");
    await expect.poll(async () => (await pane.boundingBox()).width).toBe(320);

    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      for (const width of [320, 248, 180, 420]) {
        if (width === 320) await divider.dblclick();
        else if (width === 180) await divider.press("Home");
        else if (width === 420) await divider.press("End");
        else {
          const handle = await divider.boundingBox();
          await page.mouse.move(handle.x + handle.width / 2, handle.y + 150);
          await page.mouse.down();
          await page.mouse.move((await pane.boundingBox()).x + width, handle.y + 150, { steps: 3 });
          await page.mouse.up();
        }
        await expect.poll(async () => (await pane.boundingBox()).width).toBeCloseTo(width, 0);
        await page.mouse.move(900, 800);
        const before = await row.locator("strong").boundingBox();
        const layout = await row.evaluate((node) => {
          const copy = node.querySelector(".output-copy");
          const strong = copy.querySelector("strong");
          const style = getComputedStyle(strong);
          const pane = node.closest("#agent-pane");
          return {
            copyWidth: copy.getBoundingClientRect().width,
            fontSize: parseFloat(style.fontSize),
            titleLines: strong.getBoundingClientRect().height / parseFloat(style.lineHeight),
            titleOverflow: strong.scrollWidth > strong.clientWidth + 1,
            rowOverflow: node.scrollWidth > node.clientWidth + 1,
            paneOverflow: pane.scrollWidth > pane.clientWidth + 1
          };
        });
        measurements.push({ colorScheme, width, ...layout });
        expect
          .soft(layout.copyWidth, `${colorScheme} ${width}px CJK title width`)
          .toBeGreaterThanOrEqual(layout.fontSize * 4);
        expect.soft(layout.titleLines, `${colorScheme} ${width}px title lines`).toBeLessThanOrEqual(2.05);
        expect.soft(layout.titleOverflow, `${colorScheme} ${width}px title overflow`).toBe(false);
        expect.soft(layout.rowOverflow, `${colorScheme} ${width}px row overflow`).toBe(false);
        expect.soft(layout.paneOverflow, `${colorScheme} ${width}px panel overflow`).toBe(false);
        await row.hover();
        const hovered = await row.locator("strong").boundingBox();
        expect.soft(hovered.x).toBeCloseTo(before.x, 1);
        expect.soft(hovered.y).toBeCloseTo(before.y, 1);
        expect.soft(hovered.width).toBeCloseTo(before.width, 1);
        await expect(open).toBeInViewport();
        await expect(download).toBeInViewport();
        await open.click({ trial: true });
        await download.click({ trial: true });
        const switchBox = await navigation.boundingBox();
        const refreshBox = await refresh.boundingBox();
        expect.soft(switchBox.y + switchBox.height / 2).toBeCloseTo(refreshBox.y + refreshBox.height / 2, 0);
        await navigation.hover();
        const hoveredSwitch = await navigation.boundingBox();
        expect.soft(hoveredSwitch.x).toBeCloseTo(switchBox.x, 1);
        expect.soft(hoveredSwitch.y).toBeCloseTo(switchBox.y, 1);
        await page.screenshot({ path: info.outputPath(`task-outputs-${colorScheme}-${width}.png`) });
        await navigation.click();
        await expect(tasks).toBeVisible();
        expect((await page.locator("#conversation-sidebar").boundingBox()).width).toBeCloseTo(width, 0);
        await tasks.click();
        await expect(navigation).toBeEnabled();
        const restored = await navigation.boundingBox();
        expect.soft(restored.x).toBeCloseTo(switchBox.x, 1);
        expect.soft(restored.y).toBeCloseTo(switchBox.y, 1);
        await expect(editor).toHaveValue(content);
        await expect(page.locator("#composer-input")).toHaveValue("调整任务面板时保留草稿");
      }
    }
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/tasks" && response.ok()
    );
    await refresh.click();
    await refreshed;
    await expect(row).toBeVisible();
    await expect(page.locator("#composer-input")).toHaveValue("调整任务面板时保留草稿");
    await open.click();
    await expect(editor).toHaveValue(content);
    const downloading = page.waitForEvent("download");
    await download.click();
    const file = await downloading;
    expect(file.suggestedFilename()).toBe(title);
    expect(await readFile(await file.path(), "utf8")).toBe(content);
    await expect(page.locator("#composer-input")).toHaveValue("调整任务面板时保留草稿");
    expect(errors).toEqual([]);
  } finally {
    const measurementsPath = info.outputPath("task-output-layout.json");
    await writeFile(measurementsPath, JSON.stringify(measurements, null, 2));
    await info.attach("task-output-layout.json", {
      path: measurementsPath,
      contentType: "application/json"
    });
    await dashboard.stop();
  }
});

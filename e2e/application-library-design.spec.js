import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("the application sidebar stays short while every preserved file remains searchable and openable", async ({
  page
}, info) => {
  const dashboard = await startDashboard();
  try {
    const post = async (path, data) => {
      const response = await page.request.post(dashboard.base + path, { data });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await post("/api/tasks", { taskId: "library-design", goal: "文档整理" });
    for (let i = 1; i <= 9; i++)
      await post("/api/tasks/library-design/resources", {
        kind: "text/markdown",
        title: `文档 ${String(i).padStart(2, "0")}.md`,
        initialContent: `# 文档 ${i}\n保留的内容`
      });
    await page.goto(`${dashboard.base}/?task=library-design`);
    await page.locator("#composer-input").fill("尚未发送的整理要求");
    await page.locator("#apps-nav").click();
    await expect(page.locator("#apps-panel [data-open-resource]")).toHaveCount(5);
    await expect(page.locator("#apps-panel .app-resource-copy small")).toHaveCount(0);
    const all = page.locator("[data-all-resources]");
    await expect(all).toBeVisible();
    for (const [theme, width] of [
      ["light", 1440],
      ["dark", 320]
    ]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 760 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (!(await all.isVisible())) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
      await all.click();
      const picker = page.getByRole("dialog", { name: "全部文件", exact: true });
      const search = picker.getByRole("searchbox", { name: "搜索文件", exact: true });
      await expect(search).toBeFocused();
      await expect(picker.locator("[data-picker-resource]")).toHaveCount(9);
      await expect(picker.locator("[data-picker-count]")).toBeHidden();
      await expect(picker.locator(".app-file-result > span small")).toHaveCount(0);
      await search.fill("文本编辑器");
      await expect(picker.locator("[data-picker-resource]")).toHaveCount(9);
      await expect(picker.locator("[data-picker-count]")).toHaveText("9 个结果");
      await search.fill("没有这样的文档");
      await expect(picker.locator(".app-file-empty")).toHaveText("没有匹配的文件");
      await search.fill("文档 09");
      await expect(picker.locator("[data-picker-resource]")).toHaveCount(1);
      await expect(picker.locator("[data-picker-count]")).toHaveText("1 个结果");
      await search.press("ArrowDown");
      await expect(picker.locator("[data-picker-resource]")).toBeFocused();
      await page.screenshot({ path: info.outputPath(`files-${theme}-${width}.png`) });
      const bounds = await picker.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await picker.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
      await expect(all).toBeFocused();
      await expect(page.locator("#composer-input")).toHaveValue("尚未发送的整理要求");
    }
    await all.click();
    const picker = page.getByRole("dialog", { name: "全部文件", exact: true });
    await picker.getByRole("searchbox").fill("文档 09");
    await picker.locator("[data-picker-resource]").click();
    await expect(page.locator("[data-editor-input]:visible")).toHaveValue("# 文档 9\n保留的内容");
  } finally {
    await dashboard.stop();
  }
});

test("shared action menus style plain rows and skip hidden groups during keyboard navigation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    await page.evaluate(async () => {
      const { createMenu } = await import("/assets/ui/menu.js");
      const host = document.createElement("div");
      host.className = "ui-menu-anchor";
      host.style.cssText = "position:fixed;top:100px;left:20px;z-index:2000";
      host.innerHTML =
        '<button id="design-menu-trigger">文件操作</button><div class="ui-menu" id="design-menu" hidden><button>打开文件</button><div role="group" hidden><button>不可用的隐藏操作</button></div><button>保存副本</button></div>';
      document.body.append(host);
      createMenu(host.querySelector("button"), host.querySelector(".ui-menu"));
    });
    const trigger = page.locator("#design-menu-trigger");
    const menu = page.locator("#design-menu");
    await trigger.click();
    await expect(menu.getByRole("button", { name: "打开文件", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("button", { name: "保存副本", exact: true })).toBeFocused();
    await expect(menu.getByRole("button", { name: "保存副本", exact: true })).toHaveCSS("font-size", "14px");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally {
    await dashboard.stop();
  }
});

test("file browsing closes on history navigation and a late open preserves the later conversation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const opening = new Promise((resolve) => {
    started = resolve;
  });
  try {
    const post = async (path, data) => {
      const response = await page.request.post(dashboard.base + path, { data });
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await post("/api/tasks", { taskId: "library-a", goal: "会话 A 的文件" });
    await post("/api/tasks", { taskId: "library-b", goal: "会话 B 的草稿" });
    let resourceId;
    for (let i = 1; i <= 6; i++) {
      const created = await post("/api/tasks/library-a/resources", {
        kind: "text/plain",
        title: `A 的文件 ${i}.txt`,
        initialContent: `A ${i}`
      });
      resourceId = created.resource.resourceId;
    }
    await page.goto(`${dashboard.base}/?task=library-b`);
    await page.locator("#composer-input").fill("B 的独立草稿");
    await page.locator('#project-list [data-task="library-a"]').click();
    await expect(page).toHaveURL(/task=library-a/);
    // A same-document browser history entry exercises the production popstate route.
    await page.evaluate(() => {
      history.replaceState(null, "", "?task=library-b");
      history.pushState(null, "", "?task=library-a");
    });
    await page.locator("#apps-nav").click();
    await page.locator("[data-all-resources]").click();
    const picker = page.getByRole("dialog", { name: "全部文件", exact: true });
    await expect(picker).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/task=library-b/);
    await expect(picker).toHaveCount(0);
    await expect(page.locator("#composer-input")).toHaveValue("B 的独立草稿");
    await expect(page.locator("[data-all-resources]")).not.toBeFocused();

    await page.locator('#project-list [data-task="library-a"]').click();
    const nav = page.locator("#apps-nav");
    if ((await nav.getAttribute("aria-expanded")) === "true") await nav.click();
    await nav.click();
    await page.locator("[data-all-resources]").click();
    await page.route(`**/api/tasks/library-a/resources/${resourceId}/open`, async (route) => {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    });
    await picker.locator(`[data-picker-resource="${resourceId}"]`).click();
    await opening;
    await page.locator('#project-list [data-task="library-b"]').click();
    const composer = page.locator("#composer-input");
    await expect(composer).toHaveValue("B 的独立草稿");
    await composer.focus();
    const completed = page.waitForResponse((response) =>
      response.url().endsWith(`/api/tasks/library-a/resources/${resourceId}/open`)
    );
    release();
    await completed;
    // Wait for the normal tab poll as well: it must not restore A's late editor.
    await page.waitForResponse(
      (response) => response.url().endsWith("/api/workbench/tabs") && response.request().method() === "GET"
    );
    await expect(page).toHaveURL(/task=library-b/);
    await expect(composer).toHaveValue("B 的独立草稿");
    await expect(composer).toBeFocused();
    await expect(page.locator("[data-editor-input]:visible")).toHaveCount(0);
    await expect(picker).toHaveCount(0);
    await expect(page.locator("#toast")).not.toContainText("打开失败");
  } finally {
    release();
    await dashboard.stop();
  }
});

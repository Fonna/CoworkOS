import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("background preparation stays visible without blocking chat and offers cancel and retry in settings", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const state = {
    id: "blender",
    phase: "downloading",
    message: "正在下载组件",
    dependencies: ["Blender 4.5 LTS"],
    supported: true,
    enabled: true,
    available: false,
    managed: true,
    installing: true,
    progress: 20
  };
  const actions = [];
  await page.route("**/api/components**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const action = new URL(request.url()).pathname.split("/").at(-1);
      actions.push(action);
      if (action === "cancel")
        Object.assign(state, { installing: false, phase: "cancelled", message: "准备已取消" });
      if (action === "install")
        Object.assign(state, {
          installing: true,
          phase: "downloading",
          message: "正在下载组件",
          progress: 0
        });
      return route.fulfill({ json: state });
    }
    return route.fulfill({ json: { components: [state] } });
  });
  try {
    await page.goto(dashboard.base);
    const notice = page.locator("[data-component-preparation]");
    await expect(notice).toContainText("正在准备 Blender · 20%");
    await page.locator("#composer-input").fill("准备组件时保留这条聊天草稿");
    expect(actions).toEqual([]);
    await notice.click();
    const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
    const blender = settings.locator('[data-component-id="blender"]');
    await expect(blender).toBeFocused();
    await expect(settings.locator(".component-auth")).toHaveCount(0);
    await blender.getByRole("button", { name: "取消安装", exact: true }).click();
    await expect(notice).toContainText("准备已取消");
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.locator("#composer-input")).toHaveValue("准备组件时保留这条聊天草稿");
    await notice.click();
    await expect(blender).toBeFocused();
    await blender.getByRole("button", { name: "安装 / 重试", exact: true }).click();
    await expect(blender.getByRole("progressbar")).toBeVisible();
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(notice).toContainText("正在准备 Blender");
    Object.assign(state, { installing: false, available: true, phase: "ready", message: "组件可用" });
    await expect(notice).toBeHidden();
    await expect(page.locator("#composer-input")).toHaveValue("准备组件时保留这条聊天草稿");
    expect(actions).toEqual(["cancel", "install"]);
  } finally {
    await dashboard.stop();
  }
});

for (const theme of ["light", "dark"]) {
  test(`public components live in settings and remain usable in ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const dashboard = await startDashboard();
    const states = ["cadquery", "blender", "pptist"].map((id, index) => ({
      id,
      phase: index === 0 ? "missing" : "ready",
      message: "组件可用",
      dependencies: ["long-dependency-name-".repeat(12)],
      version: "1.0",
      supported: true,
      enabled: true,
      available: index !== 0,
      installing: false
    }));
    const requests = [];
    await page.route("**/api/components**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      requests.push(`${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`);
      const action = path.match(/^\/api\/components\/([a-z]+)\/(enable|disable|install)$/);
      if (action) {
        const state = states.find((entry) => entry.id === action[1]);
        state.enabled = action[2] !== "disable";
        state.available = state.enabled;
        state.phase = state.enabled ? "ready" : "disabled";
        return route.fulfill({ json: state });
      }
      await route.fulfill({ json: { components: states } });
    });
    try {
      await page.goto(dashboard.base);
      await page.locator("#apps-nav").click();
      await expect(page.locator("#apps-panel [data-component-manager]")).toHaveCount(0);
      await expect(page.locator("#apps-panel [data-blender-install]")).toHaveCount(0);
      await page.locator("#apps-nav").click();
      for (const width of [1440, 474, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
        if (!(await page.locator("#user-menu-button").isVisible()))
          await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
        await page.locator("#user-menu-button").click();
        const overview = page.getByRole("dialog", { name: "设置", exact: true });
        await overview.locator("#appearance-select").selectOption(theme);
        await overview.getByRole("button", { name: "管理应用", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
        await expect(settings).toBeVisible();
        await expect(overview).toBeHidden();
        await expect(settings).toContainText("后台下载并安装");
        await expect(settings.locator('input[type="password"]')).toHaveCount(0);
        await expect(settings.locator(".component-auth")).toHaveCount(0);
        const cad = settings.locator('[data-component-id="cadquery"]');
        await expect(cad.getByRole("button", { name: "安装 / 重试", exact: true })).toBeEnabled();
        await cad.locator("summary").click();
        const blender = settings.locator('[data-component-id="blender"]');
        await blender.getByRole("button", { name: "停用", exact: true }).click();
        await expect(blender).toContainText("已停用");
        await blender.getByRole("button", { name: "启用", exact: true }).click();
        await expect(blender).toContainText("可用");
        await expect(cad.locator("details")).toHaveAttribute("open", "");
        await expect(settings.getByRole("button", { name: "返回设置", exact: true })).toBeInViewport();
        await expect(settings.getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
        expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        expect(
          await settings.locator(".settings-scroll").evaluate((node) => node.scrollWidth <= node.clientWidth)
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-components.png`) });
        await page.keyboard.press("Escape");
        await expect(settings).toBeHidden();
        await expect(page.locator("#user-menu-button")).toBeFocused();
      }
      // A usage entry opens the same settings surface and selects the missing component.
      await page.evaluate(() =>
        document.dispatchEvent(
          new CustomEvent("atria:component-settings", { detail: { componentId: "cadquery" } })
        )
      );
      const cad = page.locator('[data-component-id="cadquery"]');
      await expect(cad).toBeFocused();
      expect(requests.some((request) => /refresh=1|\/install|\/upgrade/.test(request))).toBe(false);
      await cad.getByRole("button", { name: "安装 / 重试", exact: true }).click();
      await expect(cad).toContainText("可用");
      expect(requests).toContain("POST /api/components/cadquery/install");
    } finally {
      await dashboard.stop();
    }
  });
}

test("the full offline package keeps bundled component activation and repair without public downloads", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const states = ["cadquery", "blender", "pptist"].map((id, index) => ({
    id,
    phase: index === 0 ? "missing" : "ready",
    message: "使用 CoworkOS 内置组件",
    dependencies: [],
    bundled: true,
    managed: false,
    supported: true,
    enabled: true,
    available: index !== 0,
    installing: false
  }));
  const requests = [];
  await page.route("**/api/components**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    const action = url.pathname.match(/^\/api\/components\/([a-z]+)\/(enable|disable)$/);
    if (action) {
      const state = states.find((entry) => entry.id === action[1]);
      state.enabled = action[2] === "enable";
      state.available = state.enabled;
      state.phase = state.enabled ? "ready" : "disabled";
      return route.fulfill({ json: state });
    }
    return route.fulfill({ json: { components: states } });
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await expect(settings).toContainText("此安装包包含全部应用组件");
    const cad = settings.locator('[data-component-id="cadquery"]');
    await cad.getByRole("button", { name: "修复安装", exact: true }).click();
    await expect(cad).toContainText("CoworkOS 完整安装包");
    await expect(settings.getByRole("button", { name: "安装 / 重试", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "升级", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "卸载组件", exact: true })).toHaveCount(0);
    const blender = settings.locator('[data-component-id="blender"]');
    await blender.getByRole("button", { name: "停用", exact: true }).click();
    await expect(blender).toContainText("已停用");
    await blender.getByRole("button", { name: "启用", exact: true }).click();
    await expect(blender).toContainText("可用");
    await settings.getByRole("button", { name: "重新检查安装状态", exact: true }).click();
    await expect(cad).not.toContainText("CoworkOS 完整安装包");
    expect(requests).toContain("GET /api/components?probe=1");
    expect(requests.some((request) => /refresh=1|\/(install|upgrade|uninstall)$/.test(request))).toBe(false);
  } finally {
    await dashboard.stop();
  }
});

test("a light App repairs its bundled PPT editor with the normal CoworkOS installer", async ({ page }) => {
  const dashboard = await startDashboard();
  let actions = 0;
  await page.route("**/api/components**", (route) => {
    if (route.request().method() === "POST") actions++;
    return route.fulfill({
      json: {
        components: ["cadquery", "blender", "pptist"].map((id) => ({
          id,
          phase: id === "pptist" ? "missing" : "ready",
          message: id === "pptist" ? "内置 PPT 编辑器缺失" : "组件可用",
          dependencies: [],
          bundled: id === "pptist",
          managed: id !== "pptist",
          supported: true,
          enabled: true,
          available: id !== "pptist",
          installing: false
        }))
      }
    });
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const ppt = page
      .getByRole("dialog", { name: "应用与组件", exact: true })
      .locator('[data-component-id="pptist"]');
    await ppt.getByRole("button", { name: "修复安装", exact: true }).click();
    await expect(ppt).toContainText("请重新安装 CoworkOS，恢复内置 PPT 编辑器");
    await expect(ppt).toContainText("文档、任务和历史会保留");
    await expect(ppt).not.toContainText("完整安装包");
    await expect(ppt.getByRole("button", { name: "安装 / 重试", exact: true })).toHaveCount(0);
    await expect(ppt.getByRole("button", { name: "升级", exact: true })).toHaveCount(0);
    await expect(ppt.getByRole("button", { name: "卸载组件", exact: true })).toHaveCount(0);
    expect(actions).toBe(0);
  } finally {
    await dashboard.stop();
  }
});

test("component failures remain visible and reopening settings retries", async ({ page }) => {
  const dashboard = await startDashboard();
  let failing = true;
  await page.route("**/api/components", (route) =>
    route.fulfill(
      failing ? { status: 503, json: { error: "本机服务暂不可用" } } : { json: { components: [] } }
    )
  );
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await expect(dialog.getByRole("alert")).toContainText("本机服务暂不可用");
    await page.keyboard.press("Escape");
    failing = false;
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    await expect(dialog.locator('[role="alert"]')).toBeEmpty();
  } finally {
    await dashboard.stop();
  }
});

test("bundled component updates use the existing CoworkOS update settings", async ({ page }) => {
  const dashboard = await startDashboard();
  await page.addInitScript(() => {
    window.componentUpdateChecks = 0;
    const update = { mode: "installed", phase: "up-to-date", currentVersion: "1.0" };
    window.bookmanDesktop = {
      onPrepareClose() {},
      modelStatus: async () => ({ configured: true, model: "fixture" }),
      updateStatus: async () => update,
      checkUpdates: async () => {
        window.componentUpdateChecks++;
        return update;
      },
      applyUpdate: async () => update
    };
  });
  await page.route("**/api/components", (route) => route.fulfill({ json: { components: [] } }));
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const before = await page.evaluate(() => window.componentUpdateChecks);
    await page.getByRole("button", { name: "检查 CoworkOS 更新", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "应用与组件", exact: true })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.componentUpdateChecks)).toBeGreaterThan(before);
  } finally {
    await dashboard.stop();
  }
});

test("version checking probes local components and updates the restored state", async ({ page }) => {
  const dashboard = await startDashboard();
  let available = false;
  let localProbes = 0;
  await page.route("**/api/components**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("probe") === "1") localProbes++;
    await route.fulfill({
      json: {
        components: [
          {
            id: "pptist",
            enabled: true,
            available,
            installing: false,
            supported: true,
            phase: available ? "ready" : "missing",
            message: available ? "已恢复可用" : "未安装",
            dependencies: []
          }
        ]
      }
    });
  });
  try {
    await page.goto(dashboard.base);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "应用与组件", exact: true });
    const ppt = dialog.locator('[data-component-id="pptist"]');
    await expect(ppt.getByRole("button", { name: "安装 / 重试", exact: true })).toBeEnabled();
    available = true;
    // Cover keyboard activation as well as the pointer controls exercised above.
    await dialog.getByRole("button", { name: "检查版本与下载大小", exact: true }).press("Enter");
    await expect(ppt).toContainText("已恢复可用");
    expect(localProbes).toBe(1);
  } finally {
    await dashboard.stop();
  }
});

test("an activation finishing after settings closes still notifies the open editors", async ({ page }) => {
  const dashboard = await startDashboard();
  const state = {
    id: "blender",
    phase: "disabled",
    enabled: false,
    available: false,
    installing: false,
    supported: true,
    dependencies: [],
    message: "已停用"
  };
  let activation;
  await page.route("**/api/components**", async (route) => {
    if (route.request().method() === "POST") {
      activation = route;
      return;
    }
    await route.fulfill({ json: { components: [state] } });
  });
  try {
    await page.goto(dashboard.base);
    await page.evaluate(() => {
      window.componentChanges = 0;
      document.addEventListener("atria:components-changed", () => window.componentChanges++);
    });
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await dialog.getByRole("button", { name: "启用", exact: true }).click();
    await expect.poll(() => !!activation).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    Object.assign(state, { available: true, enabled: true, phase: "ready", message: "组件可用" });
    await activation.fulfill({ json: state });
    await expect.poll(() => page.evaluate(() => window.componentChanges)).toBe(1);
  } finally {
    await dashboard.stop();
  }
});

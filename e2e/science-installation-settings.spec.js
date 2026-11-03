import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function openScience(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "管理科学环境", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "科学计算", exact: true });
  await expect(dialog.getByLabel("基础 Python", { exact: true })).toBeEnabled();
  return dialog;
}

async function installationFixture(page) {
  const requests = [];
  const states = {
    general: { target: "general", state: "absent", specVersion: "fixture" },
    chemistry: { target: "chemistry", state: "absent", specVersion: "fixture" }
  };
  await page.route("**/api/science-settings/environments", (route) => route.fulfill({ json: states }));
  for (const action of ["install", "cancel"]) {
    await page.route(`**/api/science-settings/${action}`, async (route) => {
      const input = route.request().postDataJSON();
      requests.push({ action, ...input });
      const previous = states[input.target];
      states[input.target] = {
        ...previous,
        state: action === "install" ? "installing" : "cancelled",
        phase: action === "install" ? "venv" : undefined
      };
      await route.fulfill({ status: action === "install" ? 202 : 200, json: states[input.target] });
    });
  }
  return { requests, states };
}

test("installation runs across settings close, preserves drafts, and needs explicit selection and save", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const fixture = await installationFixture(page);
  const snapshot = async () => (await page.request.get(`${dashboard.base}/api/science-settings`)).json();
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const before = await snapshot();
    expect(fixture.requests).toEqual([]);
    const bootstrap = join(dashboard.root, "chosen-python");
    const installed = join(dashboard.root, "managed-general", "bin", "python3");
    await dialog.getByLabel("基础 Python", { exact: true }).fill(bootstrap);
    await dialog.getByRole("button", { name: "安装基础环境", exact: true }).click();
    await expect(dialog.locator('[data-environment="general"]')).toContainText("正在创建独立环境");
    await expect(dialog.getByRole("button", { name: "取消基础环境安装" })).toBeEnabled();
    expect(fixture.requests).toEqual([{ action: "install", target: "general", pythonExecutable: bootstrap }]);
    expect(await snapshot()).toEqual(before);
    await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
    fixture.states.general = { ...fixture.states.general, state: "ready", installedPython: installed };
    await page.getByRole("button", { name: "管理科学环境", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "使用基础环境", exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(bootstrap);
    await dialog.getByRole("button", { name: "使用基础环境", exact: true }).click();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(installed);
    expect(await snapshot()).toEqual(before);
    await dialog.getByRole("checkbox", { name: "启用科学工具" }).check();
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await snapshot()).toMatchObject({ enabled: true, pythonExecutable: installed });
    await dashboard.restart();
    await page.goto(dashboard.base);
    await openScience(page);
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(installed);
  } finally {
    await dashboard.stop();
  }
});

test("cancel and install failure retain configured Python and allow another installation", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const fixture = await installationFixture(page);
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const chemistry = join(dashboard.root, "existing-chemistry-python");
    await dialog.getByLabel("RDKit Python", { exact: true }).fill(chemistry);
    await dialog.getByRole("button", { name: "安装分子环境", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "取消分子环境安装" })).toBeEnabled();
    await dialog.getByRole("button", { name: "取消分子环境安装" }).click();
    await expect(dialog.locator('[data-environment="chemistry"]')).toContainText("安装已取消");
    await expect(dialog.getByLabel("RDKit Python", { exact: true })).toHaveValue(chemistry);
    expect(fixture.requests.at(-1)).toEqual({ action: "cancel", target: "chemistry" });
    await dialog.getByRole("button", { name: "重试安装分子环境", exact: true }).click();
    fixture.states.chemistry = {
      ...fixture.states.chemistry,
      state: "failed",
      error: { code: "installation_failed", message: "无法下载依赖，请检查网络后重试。" }
    };
    await expect(dialog.locator('[data-environment="chemistry"]')).toContainText("无法下载依赖");
    await expect(dialog.getByRole("button", { name: "重试安装分子环境", exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("RDKit Python", { exact: true })).toHaveValue(chemistry);
    await expect(dialog.getByRole("button", { name: "使用分子环境", exact: true })).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("narrow scientific settings keep installation controls within the dialog", async ({ page }) => {
  const dashboard = await startDashboard();
  await installationFixture(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(dashboard.base);
    if (!(await page.getByRole("button", { name: "设置", exact: true }).isVisible()))
      await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
    const dialog = await openScience(page);
    await expect(dialog.getByRole("button", { name: "安装基础环境", exact: true })).toBeVisible();
    const bounds = await dialog.evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth
    }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
  } finally {
    await dashboard.stop();
  }
});

test("a delayed status response cannot replace a newer installation's progress", async ({ page }) => {
  const dashboard = await startDashboard();
  let release;
  const delayed = new Promise((done) => {
    release = done;
  });
  let reads = 0;
  const states = {
    general: { target: "general", state: "absent", specVersion: "fixture" },
    chemistry: { target: "chemistry", state: "absent", specVersion: "fixture" }
  };
  await page.route("**/api/science-settings/environments", async (route) => {
    const snapshot = structuredClone(states);
    if (++reads === 1) await delayed;
    await route.fulfill({ json: snapshot });
  });
  await page.route("**/api/science-settings/install", async (route) => {
    states.general = { ...states.general, state: "installing", phase: "creating_venv" };
    await route.fulfill({ status: 202, json: states.general });
  });
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    await dialog.getByRole("button", { name: "安装基础环境", exact: true }).click();
    await expect(dialog.locator('[data-environment="general"]')).toContainText("正在创建独立环境");
    const stale = page.waitForResponse((response) =>
      response.url().endsWith("/science-settings/environments")
    );
    release();
    await stale;
    await expect(dialog.getByRole("button", { name: "取消基础环境安装" })).toBeVisible();
    await expect(dialog.locator('[data-environment="general"]')).toContainText("正在创建独立环境");
  } finally {
    release();
    await dashboard.stop();
  }
});

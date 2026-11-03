import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startDashboard } from "../test/dashboard-fixture.mjs";

async function openOverview(page) {
  const entry = page.getByRole("button", { name: "设置", exact: true });
  if (!(await entry.isVisible())) await page.getByRole("button", { name: "切换侧栏", exact: true }).click();
  await entry.click();
  return page.getByRole("dialog", { name: "设置", exact: true });
}

async function openScience(page) {
  const overview = await openOverview(page);
  await overview.getByRole("button", { name: "管理科学环境", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "科学计算", exact: true });
  await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).toBeEnabled();
  return dialog;
}

const snapshot = async (page, dashboard) =>
  (await page.request.get(`${dashboard.base}/api/science-settings`)).json();

test("science settings default off, persist separate paths and never check during load or save", async ({
  page
}) => {
  const dashboard = await startDashboard();
  const checks = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/science-settings/check")) checks.push(request.postDataJSON());
  });
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).not.toBeChecked();
    await expect(dialog).toContainText("路径用于新任务");
    await expect(dialog).toContainText("开关在下次启动会话时生效");
    const general = join(dashboard.root, "general-python");
    const chemistry = join(dashboard.root, "chemistry-python");
    await dialog.getByRole("checkbox", { name: "启用科学工具" }).check();
    await dialog.getByLabel("基础 Python", { exact: true }).fill(general);
    await dialog.getByLabel("RDKit Python", { exact: true }).fill(chemistry);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-science-status]")).toContainText("已启用");
    expect(await snapshot(page, dashboard)).toMatchObject({
      enabled: true,
      pythonExecutable: general,
      chemistryPythonExecutable: chemistry,
      chemistryInheritsGeneral: false,
      appliesTo: "new-runs"
    });
    expect(checks).toEqual([]);
    await dashboard.restart();
    await page.goto(dashboard.base);
    await openScience(page);
    await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).toBeChecked();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(general);
    await expect(dialog.getByLabel("RDKit Python", { exact: true })).toHaveValue(chemistry);
    expect(checks).toEqual([]);
  } finally {
    await dashboard.stop();
  }
});

test("explicit missing-Python check uses the unsaved draft, reports failure and preserves stored choices", async ({
  page
}) => {
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const before = await snapshot(page, dashboard);
    const missing = join(dashboard.root, "not-installed-python");
    await dialog.getByLabel("基础 Python", { exact: true }).fill(missing);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/science-settings/check")
    );
    await dialog.getByRole("button", { name: "检查基础环境", exact: true }).click();
    const checked = await response;
    expect(checked.request().postDataJSON()).toEqual({ target: "general", pythonExecutable: missing });
    const result = dialog.locator('[data-science-result="general"]');
    await expect(result).toContainText("Python 不可用");
    await expect(dialog.locator("[data-science-install]")).toHaveAttribute("open", "");
    await expect(dialog).toContainText("numpy==2.2.6 scipy==1.15.3");
    await expect(dialog).toContainText("rdkit==2026.9.1");
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(missing);
    expect(await snapshot(page, dashboard)).toEqual(before);
    await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
    await page.getByRole("button", { name: "管理科学环境", exact: true }).click();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue(missing);
    await expect(result).toContainText("Python 不可用");
    await dialog.getByLabel("基础 Python", { exact: true }).fill("python3");
    await expect(result).toBeHidden();
  } finally {
    await dashboard.stop();
  }
});

test("environment-managed fields stay fixed while an independent RDKit path can be saved", async ({
  page
}) => {
  const dashboard = await startDashboard({ science: { enabled: false, pythonExecutable: "python3" } });
  try {
    await page.goto(dashboard.base);
    const overview = await openOverview(page);
    await overview.getByRole("button", { name: "管理科学环境", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "科学计算", exact: true });
    await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).toBeDisabled();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("RDKit Python", { exact: true })).toBeEnabled();
    const chemistry = join(dashboard.root, "independent-chemistry");
    await dialog.getByLabel("RDKit Python", { exact: true }).fill(chemistry);
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await snapshot(page, dashboard)).toMatchObject({
      enabled: false,
      pythonExecutable: "python3",
      chemistryPythonExecutable: chemistry,
      managedFields: { enabled: true, pythonExecutable: true, chemistryPythonExecutable: false }
    });
    await dashboard.restart({
      science: { enabled: false, pythonExecutable: "python3", chemistryPythonExecutable: "python3" }
    });
    await page.goto(dashboard.base);
    await openOverview(page);
    await page.getByRole("button", { name: "管理科学环境", exact: true }).click();
    await expect(dialog.getByLabel("RDKit Python", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "检查 RDKit 环境", exact: true })).toBeEnabled();
  } finally {
    await dashboard.stop();
  }
});

test("a real general Python probe reports versions without saving the draft", async ({ page }) => {
  const python = process.env.COWORK_SCIENCE_TEST_PYTHON || "python3";
  test.skip(
    spawnSync(python, ["-I", "-c", "import sys"], { timeout: 5000 }).status !== 0,
    "Requires a runnable Python; configure COWORK_SCIENCE_TEST_PYTHON"
  );
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const before = await snapshot(page, dashboard);
    await dialog.getByLabel("基础 Python", { exact: true }).fill(python);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/science-settings/check")
    );
    await dialog.getByRole("button", { name: "检查基础环境", exact: true }).click();
    const checked = await (await response).json();
    expect(checked.python.available).toBe(true);
    expect(checked.python.version).toMatch(/^3\./);
    const result = dialog.locator('[data-science-result="general"]');
    await expect(result).toContainText(`Python ${checked.python.version}`);
    for (const name of ["numpy", "scipy"])
      await expect(result).toContainText(
        `${name}: ${checked.packages[name].available ? checked.packages[name].version : "未安装或无法导入"}`
      );
    expect(await snapshot(page, dashboard)).toEqual(before);
    await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).not.toBeChecked();
  } finally {
    await dashboard.stop();
  }
});

test("a real isolated RDKit probe reports its pinned version while general Python stays independent", async ({
  page
}) => {
  const python = process.env.COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON;
  test.skip(!python, "Configure COWORK_SCIENCE_CHEMISTRY_TEST_PYTHON with the locked RDKit environment");
  const dashboard = await startDashboard();
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const before = await snapshot(page, dashboard);
    await dialog.getByLabel("基础 Python", { exact: true }).fill(join(dashboard.root, "missing-general"));
    await dialog.getByLabel("RDKit Python", { exact: true }).fill(python);
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/science-settings/check")
    );
    await dialog.getByRole("button", { name: "检查 RDKit 环境", exact: true }).click();
    const checked = await (await response).json();
    expect(checked.ok).toBe(true);
    expect(checked.target).toBe("chemistry");
    expect(checked.packages.rdkit).toMatchObject({ available: true, version: "2026.09.1" });
    const result = dialog.locator('[data-science-result="chemistry"]');
    await expect(result).toContainText("环境可用");
    await expect(result).toContainText("rdkit: 2026.09.1");
    await expect(dialog.locator('[data-science-result="general"]')).toBeHidden();
    expect(await snapshot(page, dashboard)).toEqual(before);
  } finally {
    await dashboard.stop();
  }
});

test("invalid science settings keep drafts and the late check response keeps overview focus", async ({
  page
}) => {
  const dashboard = await startDashboard();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let requested;
  const started = new Promise((resolve) => {
    requested = resolve;
  });
  try {
    await page.goto(dashboard.base);
    const dialog = await openScience(page);
    const before = await snapshot(page, dashboard);
    await dialog.getByLabel("基础 Python", { exact: true }).fill("relative/python");
    await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(dialog.getByRole("alert")).not.toBeEmpty();
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toHaveValue("relative/python");
    expect(await snapshot(page, dashboard)).toEqual(before);
    await dialog.getByLabel("基础 Python", { exact: true }).fill(join(dashboard.root, "missing-python"));
    await page.route("**/api/science-settings/check", async (route) => {
      const response = await route.fetch();
      requested();
      await pending;
      await route.fulfill({ response });
    });
    await dialog.getByRole("button", { name: "检查基础环境", exact: true }).click();
    await started;
    await expect(dialog.getByLabel("基础 Python", { exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
    const overview = page.getByRole("dialog", { name: "设置", exact: true });
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/science-settings/check")
    );
    release();
    await response;
    await expect(
      page.locator('[aria-labelledby="science-settings-title"] [name="pythonExecutable"]')
    ).toBeEnabled();
    await expect(overview).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(overview.getByRole("button", { name: "管理科学环境", exact: true })).toBeFocused();
  } finally {
    release();
    await dashboard.stop();
  }
});

for (const theme of ["dark", "light"]) {
  test(`science settings remain reachable at 320px in ${theme}`, async ({ page }, testInfo) => {
    const dashboard = await startDashboard();
    try {
      await page.setViewportSize({ width: 320, height: 600 });
      await page.goto(dashboard.base);
      const overview = await openOverview(page);
      await overview.locator("#appearance-select").selectOption(theme);
      await overview.getByRole("button", { name: "管理科学环境", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "科学计算", exact: true });
      await expect(dialog.getByRole("checkbox", { name: "启用科学工具" })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`science-settings-${theme}.png`) });
      await expect(dialog.getByRole("button", { name: "返回设置", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "关闭设置", exact: true })).toBeFocused();
      await expect(dialog.getByRole("button", { name: "保存设置", exact: true })).toBeInViewport();
      expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await dialog.getByRole("button", { name: "返回设置", exact: true }).click();
      await expect(overview.getByRole("button", { name: "管理科学环境", exact: true })).toBeFocused();
      await overview.getByRole("button", { name: "管理科学环境", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "设置", exact: true })).toBeFocused();
    } finally {
      await dashboard.stop();
    }
  });
}

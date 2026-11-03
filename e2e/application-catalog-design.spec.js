import { test as base, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";

const applications = [
  ["text-editor", "i-text"],
  ["pptist", "i-slides"],
  ["cad", "i-cad"],
  ["blender", "i-blender"]
];
const test = base.extend({
  dashboard: async ({}, use) => {
    const dashboard = await startDashboard();
    try {
      await use(dashboard);
    } finally {
      await dashboard.stop();
    }
  }
});

for (const fixture of [
  {
    appType: "text-editor",
    name: "空白处导入.txt",
    content: "从空白处拖入的文字\n",
    selector: "[data-editor-input]",
    expected: "从空白处拖入的文字\n"
  },
  {
    appType: "cad",
    name: "空白处导入.cad.json",
    content: JSON.stringify({
      version: 1,
      units: "mm",
      parts: [{ id: "ball", name: "球体", shape: "sphere", radius: 8 }]
    }),
    selector: "[data-cad-title]",
    expected: "空白处导入.cad.json"
  }
]) {
  test(`${fixture.appType} imports a dropped file from the launch surface outside its action buttons`, async ({
    page,
    dashboard
  }) => {
    await page.goto(dashboard.base);
    await page.locator("#apps-nav").click();
    await page.locator(`[data-create-app="${fixture.appType}"]`).click();
    const home = page.locator("[data-app-mount]:not([hidden]) .application-home");
    await expect(home).toBeVisible();
    await home.locator("h2").evaluate((target, { name, content }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([content], name));
      target.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }));
    }, fixture);
    const document = page.locator(`${fixture.selector}:visible`);
    if (fixture.appType === "text-editor") await expect(document).toHaveValue(fixture.expected);
    else await expect(document).toHaveText(fixture.expected);
    await page.reload();
    if (fixture.appType === "text-editor") await expect(document).toHaveValue(fixture.expected);
    else await expect(document).toHaveText(fixture.expected);
  });
}

test("four built-in apps open from the keyboard with consistent light, dark and narrow launch surfaces", async ({
  page,
  dashboard
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(dashboard.base);
  const response = await page.request.get(`${dashboard.base}/api/applications`);
  expect(response.ok()).toBe(true);
  const catalog = (await response.json()).applications;
  expect(
    catalog
      .filter((app) => app.catalogVisibility !== "compatibility")
      .map((app) => app.appType)
      .sort()
  ).toEqual(applications.map(([type]) => type).sort());
  expect(catalog.filter((app) => app.catalogVisibility === "compatibility")).toHaveLength(4);

  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#user-menu-button").click();
    await page.locator("#appearance-select").selectOption(theme);
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.locator("#apps-nav").click();
    const tiles = page.locator("#apps-panel [data-create-app]");
    await expect(tiles).toHaveCount(4);
    await expect(page.locator("#apps-panel img")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-catalog.png`) });
    for (const [appType, glyph] of applications) {
      if (!(await tiles.first().isVisible())) await page.locator("#apps-nav").click();
      const launcher = page.locator(`[data-create-app="${appType}"]`);
      await expect(page.locator(`[data-toggle-instances="${appType}"] use`).first()).toHaveAttribute(
        "href",
        `#${glyph}`
      );
      await launcher.focus();
      await page.keyboard.press("Enter");
      const home = page.locator("[data-app-mount]:not([hidden]) .application-home");
      await expect(home).toBeVisible();
      await expect(home.locator(".application-home-icon use")).toHaveAttribute("href", `#${glyph}`);
      await expect(home.locator("h2")).toBeVisible();
      await expect(home.locator(".application-home-actions button")).toHaveCount(2);
      await expect(home.locator(".application-home-actions button").first()).toBeEnabled();
      await expect(home.locator(".application-home-actions [data-local-open]")).toBeEnabled();
      await expect(home.locator("p:visible")).toHaveCount(0);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(home).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        for (const button of await home.locator(".application-home-actions button").all()) {
          const box = await button.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${appType}-${width}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator("#apps-nav").click();
    }
    if (await page.locator("#apps-panel").isVisible()) await page.locator("#apps-nav").click();
  }
  expect(errors).toEqual([]);
});

import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { openCadResource, openCadView } from "./cad-editor-helper.js";

function redPixels(bytes) {
  const { data } = PNG.sync.read(bytes);
  let count = 0;
  for (let i = 0; i < data.length; i += 4)
    if (data[i] > 40 && data[i] > data[i + 1] * 1.8 && data[i] > data[i + 2] * 1.8) count++;
  return count;
}

test("JSCAD part colors reach the browser viewport and engineering mode stays gray", async ({ page }) => {
  const dashboard = await startDashboard();
  try {
    await openCadResource(page, dashboard, {
      kind: "model/atria-jscad+json",
      title: "颜色回归.cad.json",
      initialContent: {
        version: 2,
        engine: "jscad",
        units: "mm",
        parameters: {},
        source: `const {primitives,colors,transforms}=require('@jscad/modeling');
module.exports.main=()=>[
  colors.colorize([1,0,0],primitives.cuboid({size:[30,30,30]})),
  colors.colorize([0,0,0],transforms.translate([40,0,0],primitives.cuboid({size:[30,30,30]})))
];`
      }
    });
    const editor = page.locator("[data-app-mount]:not([hidden])");
    const viewport = editor.locator("[data-cad-viewport]");
    await expect(viewport).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const gray = redPixels(await viewport.screenshot());
    await openCadView(editor);
    await editor.getByRole("combobox", { name: "CAD 外观", exact: true }).selectOption("colors");
    await expect.poll(async () => redPixels(await viewport.screenshot())).toBeGreaterThan(gray + 1000);
    await editor.getByRole("combobox", { name: "CAD 外观", exact: true }).selectOption("engineering");
    await expect.poll(async () => redPixels(await viewport.screenshot())).toBeLessThan(gray + 100);
  } finally {
    await dashboard.stop();
  }
});

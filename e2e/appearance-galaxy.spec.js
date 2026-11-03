import { test, expect } from "@playwright/test";
import { startDashboard } from "../test/dashboard-fixture.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

for (const fallback of [false, true]) {
  test(`a real delegated team remains visible and selectable in light and dark galaxies (${fallback ? "canvas" : "webgl"})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    const provider = await modelProtocolFixture("openai-completions", (body) => {
      const main = body.tools?.some((tool) => (tool.name ?? tool.function?.name) === "call_subagent");
      if (!main) return { text: "星系协作完成" };
      if (!JSON.stringify(body.messages).includes("星系协作完成"))
        return { name: "call_subagent", arguments: { task: "返回星系协作完成", mode: "sync" } };
      return { text: "多智能体星系已就绪" };
    });
    const dashboard = await startDashboard({ modelEndpoint: provider.baseUrl });
    try {
      if (fallback)
        await page.addInitScript(() => {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            return type === "webgl" ? null : original.call(this, type, ...args);
          };
        });
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.goto(dashboard.base);
      await page.locator("#composer-input").fill("创建真实协作星系");
      await page.locator("#composer-input").press("Enter");
      await expect(
        page.locator("#conversation").getByText("多智能体星系已就绪", { exact: true })
      ).toBeVisible({
        timeout: 45_000
      });
      await page.getByRole("button", { name: "切换任务面板", exact: true }).click();
      const galaxy = page.locator(".agent-galaxy");
      await expect(galaxy).toHaveAttribute("data-renderer", fallback ? "canvas" : "webgl");
      await expect(galaxy.locator(".galaxy-star")).toHaveCount(2);
      const original = await galaxy
        .locator(".galaxy-star")
        .evaluateAll((nodes) => nodes.map((node) => node.dataset.agent));
      const images = [];
      for (const theme of ["light", "dark", "light"]) {
        await page.locator("#user-menu-button").click();
        await page.locator("#appearance-select").selectOption(theme);
        await page.locator("#profile-close").click();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(galaxy.locator(".galaxy-star")).toHaveCount(2);
        await galaxy.locator(".galaxy-star-satellite").click();
        await expect(galaxy.locator(".galaxy-star-satellite")).toHaveAttribute("aria-pressed", "true");
        await expect(galaxy.locator(".galaxy-guides path")).not.toHaveAttribute("d", "");
        await page.screenshot({ path: test.info().outputPath(`${theme}-team.png`), fullPage: true });
        const screenshot = await galaxy.screenshot();
        const changed = await page.evaluate(
          async ({ data, theme }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            const baseline = theme === "light" ? [240, 240, 247] : [5, 5, 6];
            let count = 0;
            for (let y = 70; y < image.height - 65; y++)
              for (let x = 30; x < image.width - 30; x++) {
                const i = (y * image.width + x) * 4;
                if (Math.max(...baseline.map((value, c) => Math.abs(pixels[i + c] - value))) > 28) count++;
              }
            return count;
          },
          { data: screenshot.toString("base64"), theme }
        );
        expect(changed).toBeGreaterThan(500);
        images.push(screenshot.toString("base64"));
        const label = galaxy.locator(".galaxy-star-main strong");
        await expect(label).toHaveCSS("color", theme === "light" ? "rgb(41, 45, 73)" : "rgb(230, 236, 243)");
        expect(
          await galaxy.locator(".galaxy-star").evaluateAll((nodes) => nodes.map((node) => node.dataset.agent))
        ).toEqual(original);
      }
      expect(images[0]).not.toBe(images[1]);
      const main = galaxy.locator(".galaxy-star-main");
      await main.focus();
      await page.keyboard.press("Enter");
      await expect(main).toHaveAttribute("aria-pressed", "true");
      await page.emulateMedia({ forcedColors: "active" });
      await expect(galaxy.locator(".galaxy-canvas")).toHaveCSS("visibility", "hidden");
      for (const marker of [main, galaxy.locator(".galaxy-star-satellite")]) {
        const style = await marker.evaluate((node) => {
          const before = getComputedStyle(node, "::before");
          return { content: before.content, background: before.backgroundColor, width: before.width };
        });
        expect(style.content).toBe('""');
        expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(Number.parseFloat(style.width)).toBeGreaterThanOrEqual(4);
      }
      await galaxy.locator(".galaxy-star-satellite").focus();
      await page.keyboard.press("Enter");
      await expect(galaxy.locator(".galaxy-star-satellite")).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: test.info().outputPath("forced-colors-team.png"), fullPage: true });
      await page.emulateMedia({ forcedColors: "none" });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await expect(page.locator("#agent-pane")).toBeHidden();
      await page.getByRole("button", { name: "切换任务面板", exact: true }).click();
      await expect(galaxy.locator(".galaxy-star")).toHaveCount(2);
    } finally {
      await dashboard.stop();
      await provider.close();
    }
  });
}

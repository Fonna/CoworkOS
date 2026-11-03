import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startDashboard } from "../test/dashboard-fixture.mjs";

test("real streamed LaTeX renders offline and survives reopening persisted history", async ({
  page
}, testInfo) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = String.raw`中文前文，行内 \(x_1^2\)。

\[
(\log_2 n)^2`;
  const rest = [
    String.raw`
\]

继续比较：
\[
n-2^a-2^b
\]

美元公式 $a_1+b^2$ 与 $$\frac{n(n+1)}{2}$$。

代码示例：`,
    "",
    "```latex",
    String.raw`\[(\log_2 n)^2\]`,
    "```",
    "",
    "行内源码 `\\(x_1^2\\)`。",
    "",
    String.raw`无效公式 \(\unknowncommand{<img src=x onerror=fail()>}\) 不影响结论。`,
    "",
    "结论：中文与公式混排完成。"
  ].join("\n");
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id: "math-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "math-fixture",
      choices: [{ index: 0, delta, finish_reason }]
    })}\n\n`;
  const provider = createServer(async (request, response) => {
    for await (const _ of request) {
      /* Drain only the local fixture's request. */
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(chunk({ role: "assistant" }) + chunk({ content: first }));
    await gate;
    response.end(chunk({ content: rest }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  let dashboard;
  const errors = [];
  const assetErrors = [];
  const fonts = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (!response.url().includes("/assets/math/")) return;
    if (!response.ok()) assetErrors.push(response.url());
    if (response.url().endsWith(".woff2")) fonts.push(response.url());
  });
  // All math code, styles and fonts must work with external network access blocked.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
  );
  try {
    dashboard = await startDashboard({ modelEndpoint: `http://127.0.0.1:${provider.address().port}/v1` });
    await page.goto(dashboard.base);
    await page.locator("#composer-input").fill("请输出数学公式并保留代码示例。");
    await page.locator("#send-button").click();
    const live = page.locator(".live-answer");
    await expect(live).toContainText("中文前文");
    await expect(live.locator(".katex")).toHaveCount(1);
    await expect(live.locator(".katex-display")).toHaveCount(0);
    await expect(live).toContainText("\\log_2 n");
    release();
    await expect(page.locator("#stop-button")).toBeHidden({ timeout: 30_000 });
    const answer = page.locator('[data-answer-kind="final"] .markdown-body');
    const assertAnswer = async () => {
      await expect(answer).toContainText("结论：中文与公式混排完成。");
      await expect(answer.locator(".katex")).toHaveCount(5);
      await expect(answer.locator(".katex-display")).toHaveCount(3);
      await expect(answer.locator("math")).toHaveCount(5);
      await expect(answer.locator("pre code")).toHaveText(String.raw`\[(\log_2 n)^2\]`);
      await expect(answer.locator("p > code")).toHaveText(String.raw`\(x_1^2\)`);
      await expect(answer.locator("pre .katex, code .katex, img, script")).toHaveCount(0);
      await expect(answer.locator(".math-fallback")).toContainText("\\unknowncommand");
    };
    await assertAnswer();
    const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
    await page.reload();
    await assertAnswer();
    // Recreate the service, then select the saved conversation rather than reuse live events.
    await dashboard.restart();
    await page.goto(dashboard.base);
    await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
    await assertAnswer();
    await page.evaluate(() => document.fonts.ready);
    expect(fonts.length).toBeGreaterThan(0);
    const display = answer.locator(".katex-display").first();
    expect(await display.evaluate((node) => getComputedStyle(node).display)).toBe("block");
    for (const width of [1440, 474, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(display).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath("conversation-math.png") });
    expect(assetErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    release();
    await dashboard?.stop();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});

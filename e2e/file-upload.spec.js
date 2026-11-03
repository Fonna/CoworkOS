import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDashboard } from "../test/dashboard-fixture.mjs";

for (const width of [1440, 900, 640])
  test(`local originals, previews and attachment-only messages at ${width}px`, async ({ page }) => {
    const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
    const errors = [];
    let submitted;
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(dashboard.base);
      await expect(page.locator("#composer-input")).toBeVisible();
      const text = "完整 UTF-8 😀\n" + "x".repeat(15000) + "\nFILE_END";
      await page
        .locator("#file-input")
        .setInputFiles({ name: "示例.txt", mimeType: "text/plain", buffer: Buffer.from(text) });
      await expect(page.locator("#attachment-strip")).toContainText("已添加");
      expect(
        await page
          .locator("#attachment-strip .attachment-name")
          .evaluate((node) => node.getBoundingClientRect().width)
      ).toBeGreaterThan(100);
      await page.locator("[data-upload-preview]").click();
      await expect(page.locator(".attachment-preview")).toBeVisible();
      await expect(page.locator("[data-preview-content]")).toContainText("完整 UTF-8 😀");
      await expect(page.locator("[data-preview-content]")).toContainText("12,000");
      const original = await (
        await page.request.get(
          new URL(await page.locator("[data-preview-download]").getAttribute("href"), dashboard.base).href
        )
      ).body();
      expect(original.toString()).toBe(text);
      await page.keyboard.press("Escape");
      await expect(page.locator(".attachment-preview")).toBeHidden();
      const image = await readFile("web/assets/atria-symbol.png");
      await page
        .locator("#file-input")
        .setInputFiles({ name: "截图.png", mimeType: "image/png", buffer: image });
      await expect(page.locator("#attachment-strip .attachment-chip")).toHaveCount(2);
      await page.reload();
      await expect(page.locator("#attachment-strip")).toContainText("截图.png");
      await expect(page.locator("#attachment-strip")).toContainText("示例.txt");
      await page.locator("#attachment-strip [data-upload-preview]").nth(1).click();
      await expect(page.locator("[data-preview-content] img")).toBeVisible();
      await expect
        .poll(() => page.locator("[data-preview-content] img").evaluate((img) => img.naturalWidth))
        .toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.route("**/run", (route) => {
        submitted = route.request().postDataJSON();
        return route.fulfill({ status: 202, json: { runId: "fixture-run" } });
      });
      await page.locator("#send-button").click();
      await expect.poll(() => submitted?.attachmentIds?.length).toBe(2);
      expect(submitted.prompt).toBe("请查看这些附件。");
      const chips = page.locator("#attachment-strip");
      await expect(chips).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await dashboard.stop();
    }
  });

test("drop, paste, retry, cancel and navigation keep files with their own draft", async ({ page }) => {
  const dashboard = await startDashboard({ modelEndpoint: "http://127.0.0.1:1/v1" });
  let rejectFirst = true;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let received = false;
  try {
    await page.goto(dashboard.base);
    await page.route("**/api/uploads?name=retry.txt", (route) => {
      if (rejectFirst) {
        rejectFirst = false;
        return route.fulfill({ status: 503, json: { error: "fixture retry" } });
      }
      return route.continue();
    });
    await page
      .locator("#file-input")
      .setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry original") });
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    await page.locator("[data-upload-retry]").click();
    await expect(page.locator("#attachment-strip")).toContainText("retry.txt");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["drop original"], "drop.txt", { type: "text/plain" }));
      document
        .querySelector(".composer")
        .dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#attachment-strip")).toContainText("drop.txt");
    const bytes = await readFile("web/assets/atria-symbol.png");
    await page.evaluate(
      (bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
        document
          .querySelector("#composer-input")
          .dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          );
      },
      [...bytes]
    );
    await expect(page.locator("#attachment-strip")).toContainText("paste.png");
    await page.route("**/api/uploads?name=pending.txt", async (route) => {
      received = true;
      await gate;
      await route.fulfill({ status: 503, json: { error: "cancelled fixture" } }).catch(() => {});
    });
    await page
      .locator("#file-input")
      .setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from("pending") });
    await expect.poll(() => received).toBe(true);
    await expect(page.locator("#send-button")).toBeDisabled();
    await page.locator("[data-upload-cancel]").click();
    release();
    await expect(page.locator("#send-button")).toBeEnabled();
    await expect(page.locator("#attachment-strip")).not.toContainText("pending.txt");
    await page
      .locator("#file-input")
      .setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not PNG") });
    await expect(page.locator("[data-upload-retry]")).toBeVisible();
    await expect(page.locator("#attachment-strip")).not.toContainText("invalid.png");
  } finally {
    release();
    await dashboard.stop();
  }
});

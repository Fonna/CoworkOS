import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("native legacy credentials remain encrypted while public downloads need no token", async () => {
  test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
  test.setTimeout(90000);
  const root = await mkdtemp(join(tmpdir(), "atria-component-auth-native-"));
  const env = desktopSmokeEnvironment({ data: root });
  const executablePath = await developmentExecutable();
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "COMPONENT_AUTH_TASK_OK"
  }));
  let native;
  const launch = async () => {
    // Synthetic token only; mock keychain is not production/OS authorization evidence.
    native = await electron.launch({ executablePath, args: ["--use-mock-keychain", resolve(".")], env });
    return native.firstWindow();
  };
  const secret = "synthetic-component-native-marker";
  try {
    let page = await launch();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="model"]').fill("fixture");
    await dialog.locator('[name="apiKey"]').fill("synthetic-model-key");
    const initialOrigin = await page.evaluate(() => location.origin);
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect.poll(() => page.evaluate(() => location.origin)).not.toBe(initialOrigin);
    await expect(dialog).toBeHidden();
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    const components = page.getByRole("dialog", { name: "应用与组件", exact: true });
    await expect(components).toBeVisible();
    await expect(components).toContainText("后台下载并安装");
    await expect(page.getByLabel("组件下载 GitHub token")).toHaveCount(0);
    const origin = await page.evaluate(() => location.origin);
    // Legacy IPC stays compatible for existing private component installations.
    await page.evaluate((token) => window.bookmanDesktop.saveComponentAuth({ token }), secret);
    expect(await page.evaluate(() => location.origin)).toBe(origin);
    const state = await page.evaluate(() => window.bookmanDesktop.componentAuthStatus());
    expect(state).toEqual({ configured: true, unavailable: false });
    expect((await readFile(join(root, "component-github-secret.bin"))).includes(secret)).toBe(false);
    expect(
      await page.evaluate(
        (marker) => document.body.innerText.includes(marker) || JSON.stringify(localStorage).includes(marker),
        secret
      )
    ).toBe(false);
    await native.close();
    native = undefined;
    page = await launch();
    expect(await page.evaluate(() => window.bookmanDesktop.componentAuthStatus())).toEqual({
      configured: true,
      unavailable: false
    });
    const reopened = await page.evaluate(() => location.origin);
    await page.evaluate(() => window.bookmanDesktop.saveComponentAuth({ clear: true }));
    expect(await page.evaluate(() => window.bookmanDesktop.componentAuthStatus())).toEqual({
      configured: false,
      unavailable: false
    });
    expect(await page.evaluate(() => location.origin)).toBe(reopened);
    await native.close();
    native = undefined;
    page = await launch();
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#model-select")).toContainText("fixture");
    expect(await page.evaluate(() => window.bookmanDesktop.componentAuthStatus())).toEqual({
      configured: false,
      unavailable: false
    });
    expect(await readFile(join(root, "logs/dashboard.log"), "utf8")).not.toContain(secret);
    expect(await readFile(join(root, "model-config.json"), "utf8")).not.toContain(secret);
    await native.close();
    native = undefined;
    await writeFile(join(root, "component-github-secret.bin"), "synthetic-corrupt-encrypted-secret");
    page = await launch();
    await expect(page.locator("#composer-input")).toBeVisible();
    await expect(page.locator("#model-select")).toContainText("fixture");
    expect(await page.evaluate(() => window.bookmanDesktop.componentAuthStatus())).toEqual({
      configured: false,
      unavailable: true
    });
    await page.locator("#composer-input").fill("COMPONENT_AUTH_BASE_TASK");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("COMPONENT_AUTH_TASK_OK", { timeout: 30000 });
    await expect(page.locator("#stop-button")).toBeHidden();
  } finally {
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

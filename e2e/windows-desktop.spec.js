import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

test("Windows desktop connects, saves a draft and restores it after application relaunch", async () => {
  test.skip(process.platform !== "win32", "Windows desktop acceptance");
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "cowork-windows-desktop-"));
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "Desktop fixture completed"
  }));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(COWORK_|ATRIA_|PI_|ELECTRON_RUN_AS_NODE$)/.test(key))
  );
  Object.assign(env, {
    COWORK_DESKTOP_DATA: root,
    ATRIA_HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1"
  });
  const launch = async () =>
    electron.launch({ executablePath: await developmentExecutable(), args: [resolve(".")], env });
  let native;
  try {
    native = await launch();
    let page = await native.firstWindow();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="model"]').fill("windows-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-windows-fixture");
    await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    const draft = "Windows relaunch must preserve this unsent draft";
    await page.locator("#composer-input").fill(draft);
    await native.close();
    native = await launch();
    page = await native.firstWindow();
    await expect(page.locator("#composer-input")).toHaveValue(draft);
    await expect(page.locator("#model-select")).toContainText("windows-fixture");
  } finally {
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

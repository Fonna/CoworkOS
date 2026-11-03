import { test, expect, _electron as electron } from "@playwright/test";
import { access, mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";
import { desktopSmokeEnvironment } from "../scripts/desktop-smoke-env.mjs";

test("an actual base App starts, completes a local model task and reopens its persisted task without CAD/PPT runtimes", async () => {
  test.skip(
    process.platform !== "darwin" || !process.env.ATRIA_DESKTOP_APP,
    "Explicit base App candidate and macOS required"
  );
  test.setTimeout(90000);
  const app = resolve(process.env.ATRIA_DESKTOP_APP),
    root = await mkdtemp(join(tmpdir(), "atria-base-app-"));
  await expect(access(join(app, "Contents/Resources/cadquery/bin/python3"))).rejects.toThrow();
  await expect(
    access(join(app, "Contents/Resources/app/web/assets/pptist/generated/index.html"))
  ).rejects.toThrow();
  const provider = await modelProtocolFixture("openai-completions", () => ({
    text: "BASE_PACKAGED_TASK_OK"
  }));
  const data = join(root, "data"),
    env = desktopSmokeEnvironment({ data });
  env.COWORK_BLENDER_EXECUTABLE = join(root, "missing-blender");
  let native;
  const launch = async () => {
    native = await electron.launch({
      executablePath: join(app, "Contents/MacOS/CoworkOS"),
      args: ["--use-mock-keychain"],
      env,
      timeout: 60000
    });
    return native.firstWindow();
  };
  try {
    let page = await launch();
    const dialog = page.getByRole("dialog", { name: "连接模型" });
    await expect(dialog).toBeVisible();
    await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
    await dialog.locator('[name="api"]').selectOption("openai-completions");
    await dialog.locator('[name="model"]').fill("protocol-fixture");
    await dialog.locator('[name="apiKey"]').fill("local-packaged-fixture");
    await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#model-select")).toContainText("protocol-fixture");
    await expect(page.locator("#composer-input")).toBeVisible();
    await page.locator("#new-project").click();
    await page.locator("#project-name").fill("Base candidate test");
    await page.locator("#project-directory").fill(root);
    await page.locator("#project-submit").click();
    await expect(page.locator("#project-modal")).toBeHidden();
    await expect(page.locator("#project-context")).toHaveText("Base candidate test");
    await page.locator("#new-conversation").click();
    const states = await page.evaluate(
      async () => (await (await fetch("/api/components")).json()).components
    );
    expect(states.find((c) => c.id === "cadquery").available).toBe(false);
    expect(states.find((c) => c.id === "pptist").available).toBe(false);
    await page.locator("#user-menu-button").click();
    await page.getByRole("button", { name: "管理应用", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "应用与组件", exact: true })).toBeVisible();
    await expect(page.getByText("CAD 精确内核", { exact: true })).toBeVisible();
    await expect(page.getByText("PPT 编辑器", { exact: true })).toBeVisible();
    await page
      .getByRole("dialog", { name: "应用与组件", exact: true })
      .getByRole("button", { name: "关闭设置", exact: true })
      .click();
    await page.locator("#composer-input").fill("BASE_PACKAGED_TASK");
    await page.locator("#send-button").click();
    await expect(page.locator("#conversation")).toContainText("BASE_PACKAGED_TASK_OK", { timeout: 30000 });
    await expect(page.locator("#stop-button")).toBeHidden();
    const taskId = await page.locator("#project-list .conversation-item.active").getAttribute("data-task");
    expect(taskId).toBeTruthy();
    await native.close();
    native = undefined;
    page = await launch();
    await expect(page.locator("#composer-input")).toBeVisible();
    const recovered = await page.evaluate(
      async (id) => await (await fetch(`/api/tasks/${id}`)).json(),
      taskId
    );
    expect(JSON.stringify(recovered)).toContain("BASE_PACKAGED_TASK_OK");
    const files = await readdir(join(data, "components")).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error)
    );
    expect(files).toEqual([]);
    expect(await readFile(join(data, "data-version.json"), "utf8")).toContain("formatVersion");
  } finally {
    await native?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});

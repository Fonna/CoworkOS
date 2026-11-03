import { loadCurrentApplication } from "./application-context-helper.js";
import { confirmApplicationWorkspace } from "./application-workspace-helper.js";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { developmentExecutable } from "../scripts/desktop-dev.mjs";
import { modelProtocolFixture } from "../test/model-protocol-fixture.mjs";

for (const entry of ["conversation", "standalone window"]) {
  test(`desktop composer survives session switching and application binding from a ${entry}`, async () => {
    test.skip(process.platform !== "darwin", "Native desktop acceptance requires macOS");
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "atria-composer-desktop-"));
    const provider = await modelProtocolFixture("openai-completions", () => ({ text: "输入框回归通过" }));
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (/^(?:COWORK_|ATRIA_|PI_)/.test(name)) delete env[name];
    Object.assign(env, {
      COWORK_DESKTOP_DATA: root,
      ATRIA_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      COWORK_DISABLE_WATCH_SUPERVISOR: "1",
      PI_OFFLINE: "1"
    });
    delete env.ELECTRON_RUN_AS_NODE;
    let native;
    try {
      native = await electron.launch({
        executablePath: await developmentExecutable(),
        args: ["--use-mock-keychain", resolve(".")],
        env
      });
      const page = await native.firstWindow();
      const dialog = page.getByRole("dialog", { name: "连接模型" });
      await dialog.locator('[name="api"]').selectOption("openai-completions");
      await dialog.locator('[name="baseUrl"]').fill(provider.baseUrl);
      await dialog.locator('[name="model"]').fill("composer-fixture");
      await dialog.locator('[name="apiKey"]').fill("local-composer-fixture");
      await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
      await expect(dialog.locator("[data-model-result]")).toContainText("连接通过");
      await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator("#model-select")).toContainText("composer-fixture");
      await page.locator("#new-project").click();
      await page.locator("#project-name").fill("输入框验收项目");
      await page.locator("#project-directory").fill(root);
      await page.locator("#project-submit").click();
      await expect(page.locator("#project-modal")).toBeHidden();
      await expect(page.locator("#project-context")).toHaveText("输入框验收项目");
      const input = page.locator("#composer-input");
      if (entry === "conversation") await page.locator("#new-conversation").click();
      await input.fill("保留这份未发送草稿\n第二行内容");
      await page.locator("#apps-nav").click();
      await page.locator('[data-create-app="text-editor"]').click();
      await confirmApplicationWorkspace(page);
      if (entry === "standalone window") {
        await page.getByRole("button", { name: "收起工作区", exact: true }).click();
        await page.locator("#app-bind-select").click();
        await page.locator('[data-bind-instance]:not([data-bind-instance="__unbound__"])').first().click();
        await expect(input).toBeVisible();
        await input.fill("保留这份未发送草稿\n第二行内容");
      }
      await page.locator("[data-empty-new]").click();
      await page.getByRole("textbox", { name: "文件名" }).fill("输入框回归.txt");
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.locator("[data-editor-input]")).toBeEnabled();
      if (entry === "conversation") {
        await loadCurrentApplication(page, { newConversation: true });
        await input.fill("保留这份未发送草稿\n第二行内容");
      }
      await expect(page.locator(".chat-pane")).toHaveClass(/is-collaborating/);
      const taskId = await page.locator(".conversation-item.active").getAttribute("data-task");
      for (let round = 0; round < 3; round += 1) {
        await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
        await expect(input).toBeHidden();
        await page.getByRole("button", { name: "恢复并排协作", exact: true }).click();
        await expect(input).toBeVisible();
        await expect(input).toHaveValue("保留这份未发送草稿\n第二行内容");
        await page.locator("#app-bind-select").click();
        await page.locator('[data-bind-instance="__unbound__"]').click();
        await expect(input).toBeVisible();
        await page.locator("#app-bind-select").click();
        await page.locator('[data-bind-instance]:not([data-bind-instance="__unbound__"])').first().click();
        await expect(input).toBeVisible();
        await page.getByRole("button", { name: "收起工作区", exact: true }).click();
        await expect(input).toBeVisible();
        await input.click();
        await expect(input).toBeFocused();
        await page.locator("[data-composer-context]").click();
        await page.getByRole("button", { name: "全屏编辑", exact: true }).click();
        await page.locator("#new-conversation").click();
        await expect(input).toBeVisible();
        await input.fill(`另一个会话 ${round}`);
        await page.locator("#send-button").click();
        await expect(page.locator("#conversation")).toContainText("输入框回归通过");
        await expect(page.locator("#stop-button")).toBeHidden();
        await input.fill("另一个会话的草稿");
        await page.locator(`.conversation-item[data-task="${taskId}"]`).click();
        await expect(input).toBeVisible();
        await expect(input).toHaveValue("保留这份未发送草稿\n第二行内容");
      }
      // Inject the observed geometry fault, not an invented user trigger. This
      // also verifies that app.js installs the recovery in the native renderer.
      await input.evaluate((node) => {
        node.focus();
        node.setSelectionRange(2, 7, "backward");
        const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight").get;
        Object.defineProperty(node, "getClientRects", { configurable: true, value: () => [] });
        Object.defineProperty(node, "offsetHeight", {
          configurable: true,
          get() {
            const value = height.call(node);
            if (getComputedStyle(node).display === "none") {
              delete node.getClientRects;
              delete node.offsetHeight;
              node.dataset.layoutRecovered = "true";
            }
            return value;
          }
        });
        window.dispatchEvent(new Event("focus"));
      });
      await expect(input).toHaveAttribute("data-layout-recovered", "true");
      await expect(input).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("保留这份未发送草稿\n第二行内容");
      expect(
        await input.evaluate((node) => [node.selectionStart, node.selectionEnd, node.selectionDirection])
      ).toEqual([2, 7, "backward"]);
      await page.locator("#send-button").click();
      await expect(page.locator("#conversation")).toContainText("输入框回归通过", { timeout: 30_000 });
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("");
    } finally {
      await native?.close();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
